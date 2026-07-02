/**
 * Primitivas write-side LOCAIS (sem rede): stage / unstage / commit / reset-soft.
 *
 * Mesma arquitetura de `sync-ops.ts`: `runGit` direto + classifyStderr para
 * mapear stderr em códigos tipados. NUNCA usa `--hard` em qualquer função.
 *
 * Segurança: todo array de paths recebido do usuário é filtrado para rejeitar
 * entradas que comecem com `-` (defesa contra flag injection — `git add -f`,
 * `git reset --hard`, etc.). O separador `--` é sempre usado para garantir
 * que o git trate o resto como pathspec.
 */

import { runGit } from './clone.js';
import { GitCommitError, type GitCommitCode } from './commit-error.js';

function classifyCommitStderr(stderr: string): GitCommitCode {
  if (/nothing to commit|no changes added to commit/i.test(stderr)) return 'EMPTY_COMMIT';
  if (/did not match any files|pathspec.*did not match/i.test(stderr))
    return 'NOTHING_TO_STAGE';
  if (/unmerged|conflict/i.test(stderr)) return 'MERGE_CONFLICT';
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  return 'GIT_FAILED';
}

/** Filtra paths que poderiam ser interpretados como flags pelo git. */
export function sanitizePaths(paths: string[]): string[] {
  return paths.filter((p) => p && !p.startsWith('-'));
}

// ─── Stage / Unstage ──────────────────────────────────────────────────────

export interface StageOpts {
  cwd: string;
  paths: string[];
  timeoutMs: number;
}

export async function stagePaths(opts: StageOpts): Promise<void> {
  const clean = sanitizePaths(opts.paths);
  if (clean.length === 0) {
    throw new GitCommitError('no valid paths to stage', 'NOTHING_TO_STAGE');
  }
  const r = await runGit(['add', '--', ...clean], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  if (r.ok) return;
  if (r.code === 'TIMEOUT') throw new GitCommitError(r.message, 'TIMEOUT');
  throw new GitCommitError(r.message, classifyCommitStderr(r.message));
}

export async function unstagePaths(opts: StageOpts): Promise<void> {
  const clean = sanitizePaths(opts.paths);
  if (clean.length === 0) {
    throw new GitCommitError('no valid paths to unstage', 'NOTHING_TO_STAGE');
  }
  const r = await runGit(['reset', 'HEAD', '--', ...clean], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  if (r.ok) return;
  if (r.code === 'TIMEOUT') throw new GitCommitError(r.message, 'TIMEOUT');
  throw new GitCommitError(r.message, classifyCommitStderr(r.message));
}

// ─── Commit ───────────────────────────────────────────────────────────────

export interface CreateCommitOpts {
  cwd: string;
  message: string;
  author?: { name: string; email: string };
  /** Quando true, roda `git commit --amend -m <msg>` reescrevendo o último commit. */
  amend?: boolean;
  timeoutMs: number;
}

export interface CreateCommitResult {
  hash: string;
  short: string;
  branch: string;
  filesChanged: number;
}

// Fallback de identidade quando o app-core não consegue hidratar o user
// (ex.: user sem nome/email cadastrado no auth-service). Sem isso, o git
// falha com "Author identity unknown" porque o container não tem identity
// configurada globalmente.
const FALLBACK_AUTHOR = {
  name: 'Sandbox User',
  email: 'sandbox@nommand.local',
};

export async function createCommit(opts: CreateCommitOpts): Promise<CreateCommitResult> {
  const author = opts.author ?? FALLBACK_AUTHOR;
  const args: string[] = [];
  // `-c key=value` aplica a config apenas para esta invocação;
  // não persiste em nenhum git config.
  args.push('-c', `user.name=${author.name}`);
  args.push('-c', `user.email=${author.email}`);
  args.push('commit');
  if (opts.amend) {
    // Mantém o comportamento conservador: só `--amend -m`. Sem
    // `--allow-empty` — falhar é melhor que reescrever silenciosamente.
    args.push('--amend');
  }
  args.push('-m', opts.message);

  const r = await runGit(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  if (!r.ok) {
    if (r.code === 'TIMEOUT') throw new GitCommitError(r.message, 'TIMEOUT');
    throw new GitCommitError(r.message, classifyCommitStderr(r.message));
  }
  return readLastCommitMeta(opts.cwd, opts.timeoutMs);
}

async function readLastCommitMeta(
  cwd: string,
  timeoutMs: number,
): Promise<CreateCommitResult> {
  const sep = '\x1f';
  const fmt = ['%H', '%h'].join(sep);
  const head = await runGit(['log', '-1', `--pretty=format:${fmt}`], {
    cwd,
    timeoutMs,
  });
  if (!head.ok) throw new GitCommitError(head.message, 'GIT_FAILED');
  const [hash, short] = head.stdout.split(sep);

  const branchR = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    timeoutMs,
  });
  if (!branchR.ok) throw new GitCommitError(branchR.message, 'GIT_FAILED');
  const branch = branchR.stdout.trim();

  // `git show --stat --format=` lista as linhas tipo " path | N +++--" para
  // cada arquivo alterado no commit. Contagem dessas linhas = filesChanged.
  const stat = await runGit(['show', '--stat', '--format=', 'HEAD'], {
    cwd,
    timeoutMs,
  });
  const filesChanged = stat.ok
    ? stat.stdout.split('\n').filter((l) => l.includes('|')).length
    : 0;

  return { hash, short, branch, filesChanged };
}

// ─── Reset soft (helper interno; NUNCA expor --hard) ──────────────────────

export interface ResetSoftOpts {
  cwd: string;
  ref: string;
  timeoutMs: number;
}

export async function resetSoft(opts: ResetSoftOpts): Promise<void> {
  const r = await runGit(['reset', '--soft', opts.ref], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  if (r.ok) return;
  if (r.code === 'TIMEOUT') throw new GitCommitError(r.message, 'TIMEOUT');
  throw new GitCommitError(r.message, classifyCommitStderr(r.message));
}
