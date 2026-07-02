/**
 * Primitivas de gestão de branches: create / checkout / delete / publish.
 *
 * As 3 primeiras são puramente locais (sem rede). `publishBranch` envolve
 * `withAuthenticatedRemote` para garantir que o token nunca persista em
 * `.git/config`.
 *
 * Segurança:
 * - Nome de branch passa por `validateBranchName` (rejeita meta-caracteres
 *   git-perigosos e `-` no início que poderia ser interpretado como flag).
 * - `deleteBranch` SEMPRE usa `-d` (safe delete; git rejeita se houver
 *   commits unmerged). NUNCA `-D`.
 * - `force=true` no payload só libera o bypass de proteção a `main`/`master`/
 *   `develop`; a flag CLI continua sendo `-d` — proibido perder trabalho.
 */

import { runGit } from './clone.js';
import { redactToken } from './redact.js';
import { withAuthenticatedRemote } from './remote-auth.js';
import { GitBranchError, type GitBranchCode } from './branch-error.js';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop']);

/** Caracteres proibidos em ref names (git-check-ref-format reduzido). */
const INVALID_NAME_RE = /[\s~^:?*[\\]|\.\.|^-/;

function validateBranchName(name: string): void {
  if (!name || INVALID_NAME_RE.test(name)) {
    throw new GitBranchError(`invalid branch name: ${name}`, 'GIT_FAILED');
  }
}

function classifyBranchStderr(stderr: string): GitBranchCode {
  // Fase 2: branch já checked out em outro worktree (chat com /wt/<id>).
  // Git rejeita o checkout no MAIN_WORKTREE com "is already used by worktree".
  // Mapeia pra BRANCH_IN_USE → 409 no error-map (em vez de 500 GIT_FAILED).
  if (/already (?:used by|checked out at)|cannot delete branch.*checked out at/i.test(stderr))
    return 'BRANCH_IN_USE';
  if (/branch.*already exists|a branch named.*already exists/i.test(stderr))
    return 'BRANCH_EXISTS';
  if (/not a valid object name|no such ref|did not match any|not found/i.test(stderr))
    return 'BRANCH_NOT_FOUND';
  // `git branch -d X` rejeita branches com commits não mergeados. Mensagem:
  // "error: The branch 'X' is not fully merged.
  //  If you are sure you want to delete it, run 'git branch -D X'."
  // Antes caía em GIT_FAILED (500) e o frontend mostrava erro críptico.
  if (/not fully merged|the branch.*is not fully merged/i.test(stderr))
    return 'BRANCH_UNMERGED';
  if (
    /your local changes.*would be overwritten|please commit your changes or stash/i.test(stderr)
  )
    return 'DIRTY_WORKING_TREE';
  if (
    /authentication failed|invalid username or token|could not read username/i.test(stderr)
  )
    return 'AUTH_FAILED';
  if (/protected branch|gh006|gh007/i.test(stderr)) return 'PROTECTED_BRANCH';
  if (/already exists.*upstream|already has upstream/i.test(stderr))
    return 'UPSTREAM_EXISTS';
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  return 'GIT_FAILED';
}

async function currentBranch(cwd: string, timeoutMs: number): Promise<string> {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs });
  if (!r.ok) throw new GitBranchError(r.message, 'GIT_FAILED');
  return r.stdout.trim();
}

// ─── Create ───────────────────────────────────────────────────────────────

export interface CreateBranchOpts {
  cwd: string;
  name: string;
  checkout?: boolean;
  timeoutMs: number;
}

export async function createBranch(
  opts: CreateBranchOpts,
): Promise<{ branch: string }> {
  validateBranchName(opts.name);
  const args = opts.checkout
    ? ['checkout', '-b', opts.name]
    : ['branch', opts.name];
  const r = await runGit(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  if (r.ok) return { branch: opts.name };
  if (r.code === 'TIMEOUT') throw new GitBranchError(r.message, 'TIMEOUT');
  throw new GitBranchError(r.message, classifyBranchStderr(r.message));
}

// ─── Checkout ─────────────────────────────────────────────────────────────

export interface CheckoutBranchOpts {
  cwd: string;
  name: string;
  timeoutMs: number;
}

export interface CheckoutBranchResult {
  /** True quando caiu no fallback detached HEAD (branch ocupada por outro worktree). */
  detached: boolean;
}

/**
 * Checkout normal de branch. Se a branch estiver ocupada por outro worktree
 * (ex: chat-branch em /wt/<id>), git recusa. Nesse caso fazemos fallback pra
 * `git checkout --detach <branch>` no MAIN_WORKTREE: o user consegue ver os
 * arquivos da branch (read-only do ponto de vista da branch — commits novos
 * ficam soltos em detached HEAD, sem mexer na branch ativa do worktree do
 * chat). É o comportamento que o user pediu: "1 chat 1 branch, mas eu quero
 * poder ver a porra dos arquivos".
 */
export async function checkoutBranch(opts: CheckoutBranchOpts): Promise<CheckoutBranchResult> {
  validateBranchName(opts.name);
  const r = await runGit(['checkout', opts.name], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  if (r.ok) return { detached: false };
  if (r.code === 'TIMEOUT') throw new GitBranchError(r.message, 'TIMEOUT');
  const classified = classifyBranchStderr(r.message);
  if (classified === 'BRANCH_IN_USE') {
    // Fallback: detach HEAD no commit que a branch aponta. Read-only do ponto
    // de vista da branch (commits novos não atualizam refs/heads/<name>), mas
    // o user consegue ver/abrir os arquivos no IDE.
    const det = await runGit(['checkout', '--detach', opts.name], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (det.ok) return { detached: true };
    if (det.code === 'TIMEOUT') throw new GitBranchError(det.message, 'TIMEOUT');
    throw new GitBranchError(det.message, classifyBranchStderr(det.message));
  }
  throw new GitBranchError(r.message, classified);
}

// ─── Delete ───────────────────────────────────────────────────────────────

export interface DeleteBranchOpts {
  cwd: string;
  name: string;
  /** Se true, libera bypass de proteção (main/master/develop). NÃO troca para `-D`. */
  force?: boolean;
  /**
   * Se true E a branch existe em `origin/<name>`, usa `git branch -D` (force
   * unmerged delete). Sem isso, branches com commits não mergeados são
   * rejeitadas pelo `-d` safe. Safety rail: se a branch NÃO estiver em
   * origin, rejeita com UNSAFE_FORCE_DELETE — perda de commits sem backup
   * é proibida.
   *
   * Caso típico de uso: chat-branch com PR aberto que o user quer limpar
   * localmente (trabalho está no GitHub via PR, local é disposable).
   */
  allowUnmerged?: boolean;
  timeoutMs: number;
}

/**
 * Verifica se `origin/<name>` existe (branch foi pushed). Retorna true se sim.
 * `git show-ref --verify --quiet refs/remotes/origin/<name>` exit 0 = existe.
 */
async function branchExistsOnOrigin(
  cwd: string,
  name: string,
  timeoutMs: number,
): Promise<boolean> {
  const r = await runGit(
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`],
    { cwd, timeoutMs },
  );
  return r.ok;
}

/**
 * Detecta ref corrompida: a branch existe em `refs/heads/<name>` mas aponta
 * pra um commit object que sumiu do object store (resquício de worktree/push
 * que falhou no meio). `git branch -d/-D` falha porque precisa resolver o
 * commit pra checar merge-status. Ex. de stderr:
 *   "error: Couldn't look up commit object for 'refs/heads/acao-fiscal'"
 */
function isCorruptedRefError(stderr: string): boolean {
  return /couldn'?t look up commit object|couldn'?t look up ref|missing commit object/i.test(
    stderr,
  );
}

/**
 * Remove uma ref corrompida diretamente, sem resolver o commit que ela
 * aponta (`git update-ref -d`). Seguro: a ref já está quebrada — o commit
 * não existe, então não há trabalho recuperável a perder. Só é chamado
 * quando `git branch -d/-D` falhou com `isCorruptedRefError`.
 */
async function deleteCorruptedRef(
  cwd: string,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const r = await runGit(['update-ref', '-d', `refs/heads/${name}`], {
    cwd,
    timeoutMs,
  });
  if (r.ok) return;
  if (r.code === 'TIMEOUT') throw new GitBranchError(r.message, 'TIMEOUT');
  throw new GitBranchError(r.message, classifyBranchStderr(r.message));
}

export async function deleteBranch(opts: DeleteBranchOpts): Promise<void> {
  validateBranchName(opts.name);
  if (PROTECTED_BRANCHES.has(opts.name) && !opts.force) {
    throw new GitBranchError(
      `branch '${opts.name}' is protected — use force=true to confirm`,
      'BRANCH_PROTECTED',
    );
  }

  // Modo "force unmerged": só permite -D quando branch está em origin.
  if (opts.allowUnmerged) {
    const onOrigin = await branchExistsOnOrigin(
      opts.cwd,
      opts.name,
      opts.timeoutMs,
    );
    if (!onOrigin) {
      throw new GitBranchError(
        `branch '${opts.name}' não está em origin/${opts.name} — recusando force delete pra não perder commits locais sem backup`,
        'UNSAFE_FORCE_DELETE',
      );
    }
    const r = await runGit(['branch', '-D', opts.name], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (r.ok) return;
    if (r.code === 'TIMEOUT') throw new GitBranchError(r.message, 'TIMEOUT');
    // Ref corrompida (commit sumiu): -D não resolve. Limpa a ref direto.
    if (isCorruptedRefError(r.message)) {
      return deleteCorruptedRef(opts.cwd, opts.name, opts.timeoutMs);
    }
    throw new GitBranchError(r.message, classifyBranchStderr(r.message));
  }

  // Modo padrão: -d (safe), NUNCA -D.
  const r = await runGit(['branch', '-d', opts.name], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  if (r.ok) return;
  if (r.code === 'TIMEOUT') throw new GitBranchError(r.message, 'TIMEOUT');
  // Ref corrompida (commit sumiu): -d não resolve o commit pra checar merge.
  // Limpa a ref direto — não há trabalho a perder (o commit não existe).
  if (isCorruptedRefError(r.message)) {
    return deleteCorruptedRef(opts.cwd, opts.name, opts.timeoutMs);
  }
  throw new GitBranchError(r.message, classifyBranchStderr(r.message));
}

// ─── Publish (push -u origin <name>) ──────────────────────────────────────

export interface PublishBranchOpts {
  cwd: string;
  name?: string;
  token: string;
  timeoutMs: number;
}

export interface PublishBranchResult {
  branch: string;
  upstreamCreated: boolean;
  pushed: number;
}

export async function publishBranch(
  opts: PublishBranchOpts,
): Promise<PublishBranchResult> {
  const branchName = opts.name ?? (await currentBranch(opts.cwd, opts.timeoutMs));
  validateBranchName(branchName);

  const r = await withAuthenticatedRemote(opts.cwd, opts.token, () =>
    runGit(['push', '-u', 'origin', branchName], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    }),
  );

  if (!r.ok) {
    if (r.code === 'TIMEOUT') {
      throw new GitBranchError(redactToken(r.message), 'TIMEOUT');
    }
    throw new GitBranchError(
      redactToken(r.message),
      classifyBranchStderr(r.message),
    );
  }

  const upstreamCreated = /set up to track|set-upstream/i.test(r.stderr);
  return { branch: branchName, upstreamCreated, pushed: 1 };
}
