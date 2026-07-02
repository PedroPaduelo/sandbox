/**
 * Orquestrador de pull/push/fetch.
 *
 * Núcleo de segurança da feature: garante que o token (PAT) nunca persiste
 * em `.git/config`, mesmo que o git falhe no meio da operação. Padrão idêntico
 * ao `cloneRepoIntoSandbox`: lê plainUrl, faz `setRemoteUrl(authUrl)` antes,
 * `setRemoteUrl(plainUrl)` no `finally`.
 */

import { runGit } from './clone.js';
import { redactToken } from './redact.js';
import { GitSyncError, type GitSyncCode } from './sync-error.js';
import { withAuthenticatedRemote } from './remote-auth.js';
import {
  doPull,
  doPush,
  doFetch,
  parsePushedCount,
  detectUpstreamCreated,
  parseRefsUpdated,
  type DoPullOpts,
  type DoPushOpts,
  type DoFetchOpts,
} from './sync-ops.js';

const HEAD_TIMEOUT_MS = 5_000;

export interface SyncHead {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

interface RepoState {
  branch: string;
  ahead: number;
  behind: number;
  head: SyncHead;
}

/**
 * Lê branch, ahead/behind e HEAD do workspace pra compor o response final.
 * Reusa porcelain v2 (mesmo formato usado pelo `git/service.ts`).
 */
async function readRepoState(cwd: string): Promise<RepoState> {
  // Branch + ahead/behind via `git status --porcelain=v2 --branch`.
  const status = await runGit(
    ['status', '--porcelain=v2', '--branch'],
    { cwd, timeoutMs: HEAD_TIMEOUT_MS },
  );
  if (!status.ok) throw new GitSyncError(status.message, 'GIT_FAILED');

  let branch = '';
  let ahead = 0;
  let behind = 0;
  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    }
  }

  // HEAD via log -1 (mesma serialização usada em clone-repo.readHead).
  const sep = '\x1f';
  const fmt = ['%H', '%h', '%s', '%an <%ae>', '%aI'].join(sep);
  const log = await runGit(['log', '-1', `--pretty=format:${fmt}`], {
    cwd,
    timeoutMs: HEAD_TIMEOUT_MS,
  });
  if (!log.ok) throw new GitSyncError(log.message, 'GIT_FAILED');
  const [hash, short, subject, author, date] = log.stdout.split(sep);
  return {
    branch,
    ahead,
    behind,
    head: { hash, short, subject, author, date },
  };
}

// ─── Pull ─────────────────────────────────────────────────────────────────

export interface PullRepoOpts {
  workspace: string;
  token?: string;
  ref?: string;
  ffOnly: boolean;
  timeoutMs: number;
}

export interface PullRepoResult {
  ok: true;
  mode: 'fast-forward' | 'up-to-date';
  branch: string;
  ahead: number;
  behind: number;
  head: SyncHead;
}

export async function pullRepo(opts: PullRepoOpts): Promise<PullRepoResult> {
  const r = await withAuthenticatedRemote(opts.workspace, opts.token, () =>
    doPull({
      cwd: opts.workspace,
      ref: opts.ref,
      ffOnly: opts.ffOnly,
      timeoutMs: opts.timeoutMs,
    }),
  );

  if (!r.ok) {
    if (r.code === 'ALREADY_UP_TO_DATE') {
      // Não é erro — converte em result up-to-date.
      const state = await readRepoState(opts.workspace);
      return { ok: true, mode: 'up-to-date', ...state };
    }
    throw new GitSyncError(redactToken(r.message), r.code);
  }

  const state = await readRepoState(opts.workspace);
  const mode: 'fast-forward' | 'up-to-date' =
    /already up.to.date/i.test(r.stdout) || /already up.to.date/i.test(r.stderr)
      ? 'up-to-date'
      : 'fast-forward';
  return { ok: true, mode, ...state };
}

// ─── Push ─────────────────────────────────────────────────────────────────

export interface PushRepoOpts {
  workspace: string;
  token?: string;
  ref?: string;
  setUpstream: boolean;
  timeoutMs: number;
}

export interface PushRepoResult {
  ok: true;
  pushed: number;
  upstreamCreated: boolean;
  branch: string;
  head: SyncHead;
}

export async function pushRepo(opts: PushRepoOpts): Promise<PushRepoResult> {
  const r = await withAuthenticatedRemote(opts.workspace, opts.token, () =>
    doPush({
      cwd: opts.workspace,
      ref: opts.ref,
      setUpstream: opts.setUpstream,
      timeoutMs: opts.timeoutMs,
    }),
  );

  if (!r.ok) throw new GitSyncError(redactToken(r.message), r.code);

  const pushed = parsePushedCount(r.stderr);
  const upstreamCreated = detectUpstreamCreated(r.stderr);
  const state = await readRepoState(opts.workspace);
  return {
    ok: true,
    pushed,
    upstreamCreated,
    branch: state.branch,
    head: state.head,
  };
}

// ─── Fetch ────────────────────────────────────────────────────────────────

export interface FetchRepoOpts {
  workspace: string;
  token?: string;
  all: boolean;
  prune: boolean;
  timeoutMs: number;
}

export interface FetchRepoResult {
  ok: true;
  branch: string;
  ahead: number;
  behind: number;
  refsUpdated: string[];
}

export async function fetchRepo(opts: FetchRepoOpts): Promise<FetchRepoResult> {
  const r = await withAuthenticatedRemote(opts.workspace, opts.token, () =>
    doFetch({
      cwd: opts.workspace,
      all: opts.all,
      prune: opts.prune,
      timeoutMs: opts.timeoutMs,
    }),
  );

  if (!r.ok) throw new GitSyncError(redactToken(r.message), r.code);

  const refsUpdated = parseRefsUpdated(r.stderr);
  const state = await readRepoState(opts.workspace);
  return {
    ok: true,
    branch: state.branch,
    ahead: state.ahead,
    behind: state.behind,
    refsUpdated,
  };
}

// Re-export pra calling code.
export { GitSyncError, type GitSyncCode };

// Default opts úteis pra rotas/testes
export const DEFAULT_SYNC_TIMEOUTS = {
  pull: 60_000,
  push: 90_000,
  fetch: 60_000,
} as const;
