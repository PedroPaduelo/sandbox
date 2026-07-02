import { spawn } from 'node:child_process';
import { stat, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectWorkspace } from './inspect.js';
import { buildAuthenticatedUrl } from './auth-url.js';
import { GitCloneError } from './clone-error.js';
import {
  doClone,
  doUpdate,
  configureIdentity,
  runGit,
} from './clone.js';
import { setRemoteUrl as setOriginUrl, RemoteUrlError } from './remote-url.js';

export interface CloneRepoOpts {
  url: string;
  workspace: string;
  ref?: string;
  token?: string;
  depth?: number;
  authorName?: string;
  authorEmail?: string;
  cleanIfDirty?: boolean;
  timeoutMs: number;
}

export interface CloneRepoResult {
  status: 'cloned' | 'updated';
  branch: string;
  head: { hash: string; short: string; subject: string; author: string; date: string };
  remoteUrl: string;
  workspacePath: string;
}

async function readHead(cwd: string, timeoutMs: number) {
  const sep = '\x1f';
  const fmt = ['%H', '%h', '%s', '%an <%ae>', '%aI'].join(sep);
  const r = await runGit(['log', '-1', `--pretty=format:${fmt}`], { cwd, timeoutMs });
  if (!r.ok) throw new GitCloneError(r.message, r.code);
  const [hash, short, subject, author, date] = r.stdout.split(sep);
  return { hash, short, subject, author, date };
}

async function readBranch(cwd: string, timeoutMs: number): Promise<string> {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs });
  if (!r.ok) throw new GitCloneError(r.message, r.code);
  return r.stdout.trim();
}

async function setRemoteUrl(cwd: string, url: string, timeoutMs: number) {
  // Adapter: usa o helper compartilhado mas mantém a interface (lança
  // GitCloneError) que o caller espera.
  try {
    await setOriginUrl(cwd, url, timeoutMs);
  } catch (err) {
    if (err instanceof RemoteUrlError) {
      throw new GitCloneError(err.message, err.code === 'TIMEOUT' ? 'TIMEOUT' : 'GIT_FAILED');
    }
    throw err;
  }
}

async function hasGitDir(cwd: string): Promise<boolean> {
  try {
    await stat(path.join(cwd, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Diretórios que NUNCA podem entrar no git do usuário, mesmo que ele rode
 * `git add .`. `uploads/` é a área onde a plataforma deposita arquivos que o
 * usuário sobe pra trabalhar (CSV/Excel/ZIP/PDF) — input do usuário, muitas
 * vezes grande (>100MB → GitHub rejeita o push) e potencialmente sensível.
 * Tem que ficar 100% fora do versionamento, mas continua no disco (`/workspace/uploads`)
 * pro programa do usuário ler via path relativo.
 */
const PLATFORM_EXCLUDES = ['uploads/'] as const;

/**
 * Garante (idempotente) que `PLATFORM_EXCLUDES` estão em `.git/info/exclude`.
 *
 * Usamos `info/exclude` em vez do `.gitignore` versionado de propósito:
 *  - é LOCAL — não polui/comita nada no repo do usuário;
 *  - não pode ser sobrescrito pelo `.gitignore` do projeto;
 *  - vale pra todos os worktrees (vive no git-common-dir);
 *  - some do `git status --untracked-files=all` e do `git add` → a UI nem
 *    chega a oferecer esses arquivos pra stage.
 *
 * Best-effort: qualquer falha (FS readonly, .git ausente) é engolida — não
 * deve derrubar o clone, que é o caminho crítico.
 */
async function ensureUploadsExcluded(workspace: string, timeoutMs: number): Promise<void> {
  try {
    // Resolve o path real do info/exclude (cobre worktrees linkados, onde
    // .git é arquivo e o exclude vive no common-dir).
    const r = await runGit(['rev-parse', '--git-path', 'info/exclude'], {
      cwd: workspace,
      timeoutMs,
    });
    if (!r.ok) return;
    const rel = r.stdout.trim();
    if (!rel) return;
    const excludePath = path.isAbsolute(rel) ? rel : path.join(workspace, rel);

    let current = '';
    try {
      current = await readFile(excludePath, 'utf8');
    } catch {
      /* arquivo pode não existir ainda — appendFile cria */
    }
    const existing = new Set(current.split('\n').map((l) => l.trim()));
    const missing = PLATFORM_EXCLUDES.filter((p) => !existing.has(p));
    if (missing.length === 0) return;

    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await appendFile(
      excludePath,
      `${prefix}# managed by platform — user-upload area, never version\n${missing.join('\n')}\n`,
    );
  } catch {
    /* best-effort: nunca falha o clone por causa do exclude */
  }
}

function chownBestEffort(target: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('chown', ['-R', '1001:1001', target], { stdio: 'ignore' });
    p.on('error', () => resolve());
    p.on('close', () => resolve());
  });
}

export async function cloneRepo(opts: CloneRepoOpts): Promise<CloneRepoResult> {
  const inspect = await inspectWorkspace(opts.workspace, opts.url);

  if (inspect.action === 'dirty') {
    throw new GitCloneError(
      'workspace contém arquivos não-git; limpe antes de importar',
      'WORKSPACE_DIRTY',
    );
  }
  if (inspect.action === 'mismatch') {
    throw new GitCloneError(
      `workspace já contém repositório diferente (origin=${inspect.currentRemote ?? 'unknown'})`,
      'REMOTE_MISMATCH',
    );
  }

  const authUrl = buildAuthenticatedUrl(opts.url, opts.token);
  let status: 'cloned' | 'updated';

  // try/finally garante que o token NUNCA persiste em `.git/config`, mesmo
  // se `doUpdate`/`doClone` falhar após o `git remote set-url <authUrl>`
  // interno do `doUpdate`. Spec D7: "Token nunca persiste no .git/config".
  // Ver tasks-issues/ISSUE-01-token-persiste-quando-update-falha.md.
  //
  // Estratégia: para clone autenticado, embedamos o token na URL via
  // `buildAuthenticatedUrl` (https://x-access-token:<token>@github.com/...).
  // O credential-helper baseado em script bash + GIT_CREDENTIAL_HELPER env
  // NÃO funciona — o git não reconhece essa env var, e o stdin protocol
  // do credential helper é `protocol=...\nhost=...\n`, não `url=...`.
  // Mantemos o `finally` resetando origin pra URL sem token (Spec D7).
  try {
    if (inspect.action === 'clone') {
      const r = await doClone({
        url: authUrl,
        dest: opts.workspace,
        depth: opts.depth ?? 1,
        ref: opts.ref,
        timeoutMs: opts.timeoutMs,
      });
      if (!r.ok) throw new GitCloneError(r.message, r.code);
      status = 'cloned';
    } else {
      const r = await doUpdate({
        cwd: opts.workspace,
        ref: opts.ref,
        depth: opts.depth ?? 1,
        cleanIfDirty: opts.cleanIfDirty,
        authUrl,
        timeoutMs: opts.timeoutMs,
      });
      if (!r.ok) throw new GitCloneError(r.message, r.code);
      status = 'updated';
    }
  } finally {
    // Idempotente: redefine origin pra URL sem token, mesmo no caminho de erro.
    // Best-effort: se o set-url falhar (ex.: `.git` corrompido ou nem foi criado),
    // engole — o erro original já está sendo propagado.
    if (await hasGitDir(opts.workspace)) {
      try {
        await setRemoteUrl(opts.workspace, opts.url, 10_000);
      } catch {
        /* swallow: não mascarar o erro original */
      }
    }
  }

  const id = await configureIdentity({
    cwd: opts.workspace,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
    timeoutMs: 10_000,
  });
  if (!id.ok) throw new GitCloneError(id.message, id.code);

  // Blinda a área de upload do usuário contra o versionamento (idempotente).
  await ensureUploadsExcluded(opts.workspace, 5_000);

  await chownBestEffort(opts.workspace);

  const [branch, head] = await Promise.all([
    readBranch(opts.workspace, 5_000),
    readHead(opts.workspace, 5_000),
  ]);

  return { status, branch, head, remoteUrl: opts.url, workspacePath: opts.workspace };
}
