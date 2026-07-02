/**
 * Primitivas de sync com o remote: pull/push/fetch.
 *
 * Camada baixo nível — apenas executa o comando `git` correspondente via
 * `runGit` (compartilhado com `doClone`/`doUpdate`) e classifica erros.
 * NÃO lida com auth (token injection); o orquestrador `git/sync.ts` é
 * responsável por `setRemoteUrl(authUrl)` antes e o `setRemoteUrl(plainUrl)`
 * depois (try/finally).
 */

import { runGit, type DoOk, type DoFail as DoFailClone } from './clone.js';

// ─── Pull ─────────────────────────────────────────────────────────────────

export type GitPullCode =
  | 'ALREADY_UP_TO_DATE'
  | 'NON_FF_NEEDS_MERGE'
  | 'DIRTY_WORKING_TREE'
  | 'NOT_A_REPO'
  | 'AUTH_FAILED'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export interface DoPullFail {
  ok: false;
  code: GitPullCode;
  message: string;
}

export interface DoPullOpts {
  cwd: string;
  ref?: string; // branch/ref no remote (default: branch atual)
  ffOnly: boolean;
  timeoutMs: number;
}

function classifyPullStderr(stderr: string): GitPullCode {
  if (/already up.to.date/i.test(stderr)) return 'ALREADY_UP_TO_DATE';
  if (/non.fast.forward|not possible to fast.forward|cannot fast.forward/i.test(stderr))
    return 'NON_FF_NEEDS_MERGE';
  if (/your local changes.*would be overwritten|please commit your changes or stash/i.test(stderr))
    return 'DIRTY_WORKING_TREE';
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  if (/authentication failed|invalid username or token|could not read username/i.test(stderr))
    return 'AUTH_FAILED';
  return 'GIT_FAILED';
}

export async function doPull(opts: DoPullOpts): Promise<DoOk | DoPullFail> {
  const args = ['pull'];
  if (opts.ffOnly) args.push('--ff-only');
  args.push('origin');
  if (opts.ref) args.push(opts.ref);

  const r = await runGit(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  if (r.ok) return r;
  // `runGit` já classifica TIMEOUT diretamente — preserva quando vier.
  if (r.code === 'TIMEOUT') return { ok: false, code: 'TIMEOUT', message: r.message };
  return { ok: false, code: classifyPullStderr(r.message), message: r.message };
}

// ─── Push ─────────────────────────────────────────────────────────────────

export type GitPushCode =
  | 'AUTH_FAILED'
  | 'NON_FF'
  | 'PROTECTED_BRANCH'
  | 'UPSTREAM_MISSING'
  | 'FILE_TOO_LARGE'
  | 'NOT_A_REPO'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export interface DoPushFail {
  ok: false;
  code: GitPushCode;
  message: string;
}

export interface DoPushOpts {
  cwd: string;
  /** Branch alvo. Se ausente, push da branch atual. */
  ref?: string;
  /** `git push -u origin <ref>` — cria upstream automaticamente quando missing. */
  setUpstream: boolean;
  timeoutMs: number;
}

function classifyPushStderr(stderr: string): GitPushCode {
  if (/authentication failed|invalid username or token|could not read username/i.test(stderr))
    return 'AUTH_FAILED';
  // Arquivo > limite do GitHub (100MB rígido). Vem como `GH001: Large files
  // detected` + `pre-receive hook declined`. Sem esse ramo, caía no GIT_FAILED
  // genérico → 500 → 502 na plataforma, escondendo a causa real do usuário.
  if (/gh001|large files? detected|exceeds github's file size limit|exceeds .* file size limit|file size limit of/i.test(stderr))
    return 'FILE_TOO_LARGE';
  if (/non.fast.forward|updates were rejected|fetch first/i.test(stderr)) return 'NON_FF';
  if (/protected branch|cannot push to.*protected|gh006|gh007/i.test(stderr))
    return 'PROTECTED_BRANCH';
  if (/no upstream branch|set-upstream/i.test(stderr)) return 'UPSTREAM_MISSING';
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  return 'GIT_FAILED';
}

/**
 * `pushed` é estimado a partir do stderr (`<oldHash>..<newHash>  <ref> -> <ref>`).
 * Nem sempre dá pra inferir o número exato; quando não conseguir, retorna 1
 * como aproximação para "houve push".
 */
export function parsePushedCount(stderr: string): number {
  // Linhas tipo:
  //  ! [rejected]        master -> master
  //    9f0de99..3aaf780  master -> master
  //  * [new branch]      foo -> foo
  const lines = stderr.split('\n');
  let pushed = 0;
  for (const line of lines) {
    if (/^\s*[a-f0-9]{4,40}\.\.[a-f0-9]{4,40}\s+\S+\s*->\s*\S+/.test(line)) pushed += 1;
    else if (/\*\s+\[new branch\]/i.test(line)) pushed += 1;
  }
  return pushed;
}

/** Detecta se o push criou upstream (`-u`) — stderr contém "set up to track". */
export function detectUpstreamCreated(stderr: string): boolean {
  return /branch\s+'[^']+'\s+set up to track|set-upstream/i.test(stderr);
}

export async function doPush(opts: DoPushOpts): Promise<DoOk | DoPushFail> {
  const args = ['push'];
  if (opts.setUpstream) args.push('-u');
  args.push('origin');
  if (opts.ref) args.push(opts.ref);

  const r = await runGit(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  if (r.ok) return r;
  if (r.code === 'TIMEOUT') return { ok: false, code: 'TIMEOUT', message: r.message };
  return { ok: false, code: classifyPushStderr(r.message), message: r.message };
}

// ─── Fetch ────────────────────────────────────────────────────────────────

export type GitFetchCode = 'AUTH_FAILED' | 'NOT_A_REPO' | 'TIMEOUT' | 'GIT_FAILED';

export interface DoFetchFail {
  ok: false;
  code: GitFetchCode;
  message: string;
}

export interface DoFetchOpts {
  cwd: string;
  all: boolean; // --all
  prune: boolean; // --prune
  timeoutMs: number;
}

function classifyFetchStderr(stderr: string): GitFetchCode {
  if (/authentication failed|invalid username or token|could not read username/i.test(stderr))
    return 'AUTH_FAILED';
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  return 'GIT_FAILED';
}

/**
 * Parser de refs atualizados a partir do stderr do `git fetch`. Linhas tipo:
 *   "   abc1234..def5678  master      -> origin/master"
 *   " * [new branch]      foo         -> origin/foo"
 *   " - [deleted]         (none)      -> origin/bar"
 */
export function parseRefsUpdated(stderr: string): string[] {
  const refs: string[] = [];
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    // Match ref name após "->"
    const m = /->\s*(\S+)/.exec(line);
    if (m) refs.push(m[1]);
  }
  return refs;
}

export async function doFetch(opts: DoFetchOpts): Promise<DoOk | DoFetchFail> {
  const args = ['fetch'];
  if (opts.all) args.push('--all');
  if (opts.prune) args.push('--prune');
  if (!opts.all) args.push('origin');

  const r = await runGit(args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  if (r.ok) return r;
  if (r.code === 'TIMEOUT') return { ok: false, code: 'TIMEOUT', message: r.message };
  return { ok: false, code: classifyFetchStderr(r.message), message: r.message };
}

// Re-export pra calling code não precisar importar de duas fontes.
export type { DoOk, DoFailClone };
