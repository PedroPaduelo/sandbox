/**
 * Primitivas de `git stash`: push / list / pop / apply / drop.
 *
 * Notas:
 * - `push` usa `--include-untracked` quando solicitado.
 * - `list` chama `git stash list --date=iso` e parseia cada linha
 *   `stash@{N}: WIP on branch: <subject>` ou `stash@{N}: On branch: <msg>`.
 *   Não usamos `--pretty=format:` para evitar parsing duplo da linha;
 *   o formato default já é estável.
 * - Refs aceitas: `stash@{N}` apenas. Validação client-side espelha o
 *   formato esperado e bloqueia injection.
 */

import { runGit } from './clone.js';
import { GitStashError, type GitStashCode } from './stash-error.js';

const STASH_REF_RE = /^stash@\{\d+\}$/;

function validateRef(ref: string): void {
  if (!STASH_REF_RE.test(ref)) {
    throw new GitStashError(`invalid stash ref: ${ref}`, 'INVALID_REF');
  }
}

function classifyStashStderr(stderr: string): GitStashCode {
  if (/no stash entries found|is not a valid reference|log for .* is empty/i.test(stderr))
    return 'NO_STASH';
  if (/no local changes to save|nothing to stash/i.test(stderr)) return 'NO_CHANGES';
  if (/conflict|merge conflict/i.test(stderr)) return 'CONFLICT';
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  return 'GIT_FAILED';
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface StashEntry {
  ref: string;       // ex.: "stash@{0}"
  index: number;     // 0, 1, 2…
  message: string;   // mensagem capturada (sem o prefixo "stash@{N}: ")
  branch: string;    // branch onde o stash foi criado, se identificável
}

// ─── Push ─────────────────────────────────────────────────────────────────

export interface StashPushOpts {
  cwd: string;
  message?: string;
  includeUntracked?: boolean;
  timeoutMs: number;
}

export async function stashPush(opts: StashPushOpts): Promise<{ created: boolean }> {
  const args = ['stash', 'push'];
  if (opts.includeUntracked) args.push('--include-untracked');
  if (opts.message) {
    args.push('-m', opts.message);
  }
  const r = await runGit(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  if (r.ok) {
    // `git stash push` retorna "No local changes to save" no stdout (exit 0)
    // quando não havia nada pra guardar — tratamos como created=false.
    const created = !/no local changes to save/i.test(r.stdout);
    return { created };
  }
  if (r.code === 'TIMEOUT') throw new GitStashError(r.message, 'TIMEOUT');
  throw new GitStashError(r.message, classifyStashStderr(r.message));
}

// ─── List ─────────────────────────────────────────────────────────────────

export interface StashListOpts {
  cwd: string;
  timeoutMs: number;
}

/**
 * Parseia uma linha de `git stash list`. Formatos comuns:
 *   `stash@{0}: WIP on main: 1a2b3c4 commit subject`
 *   `stash@{2}: On feat/x: meu rotulo`
 */
function parseStashLine(line: string, index: number): StashEntry | null {
  const m = line.match(/^stash@\{(\d+)\}:\s+(.*)$/);
  if (!m) return null;
  const rest = m[2];
  // Tenta extrair branch — primeira ocorrência de "WIP on <branch>:" ou "On <branch>:"
  const branchMatch = rest.match(/^(?:WIP on|On)\s+([^:]+):\s+(.*)$/);
  const branch = branchMatch ? branchMatch[1].trim() : '';
  const message = branchMatch ? branchMatch[2] : rest;
  return {
    ref: `stash@{${m[1]}}`,
    index: Number(m[1]) >= 0 ? Number(m[1]) : index,
    message,
    branch,
  };
}

export async function stashList(opts: StashListOpts): Promise<StashEntry[]> {
  const r = await runGit(['stash', 'list'], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  if (!r.ok) {
    if (r.code === 'TIMEOUT') throw new GitStashError(r.message, 'TIMEOUT');
    throw new GitStashError(r.message, classifyStashStderr(r.message));
  }
  const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
  const entries: StashEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseStashLine(lines[i], i);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

// ─── Pop / Apply ──────────────────────────────────────────────────────────

export interface StashRefOpts {
  cwd: string;
  ref?: string; // default stash@{0}
  timeoutMs: number;
}

async function runStashRefCmd(
  subcommand: 'pop' | 'apply' | 'drop',
  opts: StashRefOpts,
): Promise<void> {
  const ref = opts.ref ?? 'stash@{0}';
  validateRef(ref);
  const r = await runGit(['stash', subcommand, ref], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  if (r.ok) return;
  if (r.code === 'TIMEOUT') throw new GitStashError(r.message, 'TIMEOUT');
  throw new GitStashError(r.message, classifyStashStderr(r.message));
}

export function stashPop(opts: StashRefOpts): Promise<void> {
  return runStashRefCmd('pop', opts);
}

export function stashApply(opts: StashRefOpts): Promise<void> {
  return runStashRefCmd('apply', opts);
}

// ─── Drop ─────────────────────────────────────────────────────────────────

export interface StashDropOpts {
  cwd: string;
  ref: string; // obrigatório para drop (segurança)
  timeoutMs: number;
}

export function stashDrop(opts: StashDropOpts): Promise<void> {
  return runStashRefCmd('drop', { cwd: opts.cwd, ref: opts.ref, timeoutMs: opts.timeoutMs });
}
