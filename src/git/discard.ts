/**
 * Primitiva LOCAL: descarta mudanças num conjunto de paths.
 *
 * Classifica cada path em UM bucket (staged / unstaged / untracked) usando o
 * `status` já lido pelo chamador e aplica a operação certa:
 *   - untracked → `fs.rm(absPath, { force: true })` com path-traversal guard
 *   - unstaged  → `git checkout HEAD -- <paths>` (batch)
 *   - staged    → `git reset HEAD -- <paths>` + `git checkout HEAD -- <paths>`
 *
 * Regra inegociável: NUNCA usa `git reset --hard`. Discard é sempre
 * arquivo-a-arquivo via `checkout` + `reset` com pathspec.
 *
 * Segurança:
 *   - `sanitizePaths` filtra paths começando com `-` (anti flag-injection).
 *   - Path-traversal guard usa `opts.root` (default = WORKSPACE_ROOT) e
 *     rejeita qualquer path que escape do root depois de `path.resolve`.
 *   - O separador `--` é sempre usado nas chamadas git.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './clone.js';
import { GitCommitError, type GitCommitCode } from './commit-error.js';
import { sanitizePaths } from './commit.js';
import { status as gitStatus } from './service.js';

export interface StatusBuckets {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * Lê o status atual do repo e devolve só os paths agrupados em buckets.
 * `service.ts → status()` usa o cwd global do processo (== WORKSPACE_ROOT
 * em prod), então não recebemos `cwd` aqui — mas mantemos o parâmetro pra
 * deixar a assinatura honesta sobre a dependência.
 */
export async function readStatusBuckets(_cwd: string): Promise<StatusBuckets> {
  const s = await gitStatus();
  return {
    staged: s.staged.map((f) => f.path),
    unstaged: s.unstaged.map((f) => f.path),
    untracked: [...s.untracked],
  };
}

export interface DiscardOpts {
  cwd: string;
  paths: string[];
  status: {
    staged: string[];
    unstaged: string[];
    untracked: string[];
  };
  timeoutMs: number;
  /**
   * Root para o path-traversal guard. Default: WORKSPACE_ROOT.
   * Testes passam `cwd` aqui para evitar dependência do env global.
   */
  root?: string;
}

export interface DiscardResult {
  discarded: string[];
  skipped: string[];
}

function classifyDiscardStderr(stderr: string): GitCommitCode {
  if (/did not match any files|pathspec.*did not match/i.test(stderr))
    return 'NOTHING_TO_STAGE';
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  return 'GIT_FAILED';
}

/**
 * Resolve `rel` contra `root` e rejeita qualquer escape (`..`, absoluto
 * apontando pra fora). Retorna o caminho absoluto resolvido.
 */
function resolveWithGuard(rel: string, root: string): string {
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
  const relCheck = path.relative(root, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new GitCommitError(`path fora do workspace: ${rel}`, 'GIT_FAILED');
  }
  return abs;
}

export async function discardPaths(opts: DiscardOpts): Promise<DiscardResult> {
  // Lazy import: workspace.js depende de env.ts (que valida `SANDBOX_TOKEN`).
  // Testes passam `root` explícito e não precisam carregar o env.
  // Default = worktree contextual do request (ALS).
  let root = opts.root;
  if (root === undefined) {
    const ws = await import('../workspace.js');
    root = ws.getWorktreePath();
  }
  const clean = sanitizePaths(opts.paths);
  const cleanSet = new Set(clean);

  const stagedSet = new Set(opts.status.staged);
  const unstagedSet = new Set(opts.status.unstaged);
  const untrackedSet = new Set(opts.status.untracked);

  const buckets = {
    staged: [] as string[],
    unstaged: [] as string[],
    untracked: [] as string[],
  };
  const skipped: string[] = [];

  // Ordem de prioridade: staged → unstaged → untracked → skipped.
  for (const p of clean) {
    if (stagedSet.has(p)) buckets.staged.push(p);
    else if (unstagedSet.has(p)) buckets.unstaged.push(p);
    else if (untrackedSet.has(p)) buckets.untracked.push(p);
    else skipped.push(p);
  }

  // Paths filtrados por sanitizePaths (começam com '-' ou vazios) também
  // entram em `skipped` pra dar observability ao chamador.
  for (const p of opts.paths) {
    if (!cleanSet.has(p)) skipped.push(p);
  }

  const discarded: string[] = [];

  // 1) Untracked: apaga do disco, com path-traversal guard por arquivo.
  for (const rel of buckets.untracked) {
    const abs = resolveWithGuard(rel, root);
    await fs.rm(abs, { force: true });
    discarded.push(rel);
  }

  // 2) Unstaged: git checkout HEAD -- <paths> em batch único.
  if (buckets.unstaged.length > 0) {
    const r = await runGit(['checkout', 'HEAD', '--', ...buckets.unstaged], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (!r.ok) {
      if (r.code === 'TIMEOUT') throw new GitCommitError(r.message, 'TIMEOUT');
      throw new GitCommitError(r.message, classifyDiscardStderr(r.message));
    }
    discarded.push(...buckets.unstaged);
  }

  // 3) Staged: reset HEAD -- <paths> (unstage) + checkout HEAD -- <paths> (revert).
  if (buckets.staged.length > 0) {
    const r1 = await runGit(['reset', 'HEAD', '--', ...buckets.staged], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (!r1.ok) {
      if (r1.code === 'TIMEOUT') throw new GitCommitError(r1.message, 'TIMEOUT');
      throw new GitCommitError(r1.message, classifyDiscardStderr(r1.message));
    }
    const r2 = await runGit(['checkout', 'HEAD', '--', ...buckets.staged], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    if (!r2.ok) {
      if (r2.code === 'TIMEOUT') throw new GitCommitError(r2.message, 'TIMEOUT');
      throw new GitCommitError(r2.message, classifyDiscardStderr(r2.message));
    }
    discarded.push(...buckets.staged);
  }

  return { discarded, skipped };
}
