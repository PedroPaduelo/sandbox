import { spawn } from 'node:child_process';
import { runGitWithAuth } from './credential-helper.js';
import { wrapWithDropPriv } from '../util/sandbox.js';
import { gitCredEnv } from './cred-context.js';

export type GitCloneCode =
  | 'AUTH_FAILED'
  | 'REPO_NOT_FOUND'
  | 'TIMEOUT'
  | 'WORKSPACE_DIRTY'
  | 'REMOTE_MISMATCH'
  | 'GIT_FAILED';

export interface DoCloneOpts {
  url: string;          // URL ja com x-access-token se token presente
  dest: string;
  depth?: number;       // default 1
  ref?: string;         // branch/tag, opcional
  timeoutMs: number;
}

export interface DoOk { ok: true; stdout: string; stderr: string }
export interface DoFail { ok: false; code: GitCloneCode; message: string }

function classifyStderr(stderr: string): GitCloneCode {
  if (/authentication failed|invalid username or token|could not read username/i.test(stderr))
    return 'AUTH_FAILED';
  if (/repository not found|does not exist|could not read from remote/i.test(stderr))
    return 'REPO_NOT_FOUND';
  return 'GIT_FAILED';
}

export async function runGit(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; stdin?: string },
): Promise<DoOk | DoFail> {
  // Roda git como uid 1001 (user `sandbox`), o MESMO dono de /workspace e dos
  // comandos via shell/MCP. Antes as ops git "oficiais" rodavam como root e
  // deixavam refs/objetos root-owned no .git que o usuário 1001 não conseguia
  // mexer depois → locks "Permission denied", refs corrompidas, push/branch
  // delete quebrados. Fallback gracioso: sem setpriv, roda como antes (root).
  const [bin, ...binArgs] = await wrapWithDropPriv(['git', ...args]);
  return new Promise((resolve) => {
    const p = spawn(bin, binArgs, {
      cwd: opts.cwd,
      // HOME/USER do sandbox-user: git roda como 1001 e precisa de um HOME
      // acessível (config, caches) — /root não é legível por 1001.
      env: {
        ...process.env,
        // C-11: credencial git do contexto async atual (per-request, não global).
        ...gitCredEnv(),
        HOME: '/home/sandbox',
        USER: 'sandbox',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
      // Mantém stdin pipe sempre que houver payload — pra rotas como
      // `git apply -` que precisam ler patch via stdin.
      stdio: opts.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, opts.timeoutMs);

    p.stdout?.on('data', (d) => (stdout += d.toString()));
    p.stderr?.on('data', (d) => (stderr += d.toString()));
    p.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'GIT_FAILED', message: err.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, code: 'TIMEOUT', message: 'git timeout' });
      if (code === 0) return resolve({ ok: true, stdout, stderr });
      const errCode = classifyStderr(stderr);
      resolve({ ok: false, code: errCode, message: stderr.trim() || `git exit ${code}` });
    });

    if (opts.stdin !== undefined && p.stdin) {
      p.stdin.end(opts.stdin);
    }
  });
}

export async function doClone(opts: DoCloneOpts): Promise<DoOk | DoFail> {
  const args = ['clone', `--depth=${opts.depth ?? 1}`];
  if (opts.ref) args.push('--branch', opts.ref);
  args.push(opts.url, opts.dest);
  return runGit(args, { timeoutMs: opts.timeoutMs });
}

/** Wrapper que usa git credential helper quando token é fornecido (URL plain). */
export async function doCloneWithAuth(
  opts: DoCloneOpts & { token: string },
): Promise<DoOk | DoFail> {
  const args = ['clone', `--depth=${opts.depth ?? 1}`];
  if (opts.ref) args.push('--branch', opts.ref);
  args.push(opts.url, opts.dest);
  return runGitWithAuth(args, {
    cwd: opts.dest,
    timeoutMs: opts.timeoutMs,
    token: opts.token,
    url: opts.url,
  });
}

export interface DoUpdateOpts {
  cwd: string;
  ref?: string;       // branch alvo. Se ausente, usa branch atual
  depth?: number;
  cleanIfDirty?: boolean;
  authUrl?: string;   // se passado, faz `git remote set-url origin <authUrl>` antes do fetch
  timeoutMs: number;
}

async function getCurrentBranch(cwd: string, timeoutMs: number): Promise<string | null> {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs });
  if (!r.ok) return null;
  const b = r.stdout.trim();
  return b === 'HEAD' ? null : b;
}

export async function doUpdate(opts: DoUpdateOpts): Promise<DoOk | DoFail> {
  if (opts.authUrl) {
    const setUrl = await runGit(['remote', 'set-url', 'origin', opts.authUrl], {
      cwd: opts.cwd,
      timeoutMs: 5_000,
    });
    if (!setUrl.ok) return setUrl;
  }

  const fetchArgs = ['fetch', '--depth', String(opts.depth ?? 1), 'origin'];
  if (opts.ref) fetchArgs.push(opts.ref);
  const fetched = await runGit(fetchArgs, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  if (!fetched.ok) return fetched;

  const branch = opts.ref ?? (await getCurrentBranch(opts.cwd, 5_000)) ?? 'HEAD';
  const reset = await runGit(['reset', '--hard', `origin/${branch}`], {
    cwd: opts.cwd,
    timeoutMs: 30_000,
  });
  if (!reset.ok) return reset;

  if (opts.cleanIfDirty) {
    const cleaned = await runGit(['clean', '-fdx'], { cwd: opts.cwd, timeoutMs: 30_000 });
    if (!cleaned.ok) return cleaned;
  }

  return { ok: true, stdout: '', stderr: '' };
}

/** Wrapper que usa git credential helper para doUpdate (URL plain). */
export async function doUpdateWithAuth(
  opts: DoUpdateOpts & { token: string },
): Promise<DoOk | DoFail> {
  // Configura remote com a URL plain (sem credenciais embutidas).
  const plainUrl = opts.authUrl
    ? opts.authUrl.replace(/^https:\/\/[^:]+:[^@]+@/, 'https://')
    : opts.authUrl;

  if (opts.authUrl) {
    const setUrl = await runGit(['remote', 'set-url', 'origin', plainUrl ?? opts.authUrl], {
      cwd: opts.cwd,
      timeoutMs: 5_000,
    });
    if (!setUrl.ok) return setUrl;
  }

  // Fetches & demais ops usam o credential helper via env
  const fetchArgs = ['fetch', '--depth', String(opts.depth ?? 1), 'origin'];
  if (opts.ref) fetchArgs.push(opts.ref);
  const fetched = await runGitWithAuth(fetchArgs, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    token: opts.token,
    url: plainUrl ?? opts.authUrl ?? '',
  });
  if (!fetched.ok) return fetched;

  const branch = opts.ref ?? (await getCurrentBranch(opts.cwd, 5_000)) ?? 'HEAD';
  const reset = await runGit(['reset', '--hard', `origin/${branch}`], {
    cwd: opts.cwd,
    timeoutMs: 30_000,
  });
  if (!reset.ok) return reset;

  if (opts.cleanIfDirty) {
    const cleaned = await runGit(['clean', '-fdx'], { cwd: opts.cwd, timeoutMs: 30_000 });
    if (!cleaned.ok) return cleaned;
  }

  return { ok: true, stdout: '', stderr: '' };
}

export interface ConfigureIdentityOpts {
  cwd: string;
  authorName?: string;
  authorEmail?: string;
  timeoutMs: number;
}

export async function configureIdentity(opts: ConfigureIdentityOpts): Promise<DoOk | DoFail> {
  if (opts.authorName) {
    const r = await runGit(['config', '--local', 'user.name', opts.authorName], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (!r.ok) return r;
  }
  if (opts.authorEmail) {
    const r = await runGit(['config', '--local', 'user.email', opts.authorEmail], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (!r.ok) return r;
  }
  return { ok: true, stdout: '', stderr: '' };
}
