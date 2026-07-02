import { spawn } from 'node:child_process';
import { getWorktreePath } from '../workspace.js';
import { parseGitBlamePorcelain, type BlameLine } from '../lib/git-blame-parser.js';

export type GitErrorCode = 'NOT_A_REPO' | 'TIMEOUT' | 'GIT_FAILED' | 'NOT_FOUND';

export class GitError extends Error {
  constructor(message: string, public code: GitErrorCode) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitFileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | '?' | '!' | 'U';
  oldPath?: string;
}
export interface GitStatusResult {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
}
export interface GitCommit {
  hash: string;
  short: string;
  author: { name: string; email: string };
  date: string;
  subject: string;
  parents: string[];
}
export type GitBlameLine = BlameLine;

interface RunOpts { timeoutMs?: number; cwd?: string }

function run(args: string[], opts: RunOpts = {}): Promise<string> {
  // Default = worktree contextual do request (ALS populado pelo middleware
  // em bootstrap/plugins.ts). Caller pode sobrescrever via opts.cwd quando
  // quiser operar em MAIN_WORKTREE explicitamente (ex.: merge).
  const cwd = opts.cwd ?? getWorktreePath();
  const timeout = opts.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    let out = '', errOut = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (errOut += d.toString()));
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new GitError('git timeout', 'TIMEOUT')); }, timeout);
    p.on('error', (err) => { clearTimeout(t); reject(new GitError(err.message, 'GIT_FAILED')); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) return resolve(out);
      if (/not a git repository/i.test(errOut)) return reject(new GitError('workspace não é um repositório git', 'NOT_A_REPO'));
      // NOT_FOUND amplo: arquivo ausente em ref, ref inválida, path não no
      // index. Vira 404 no error-map (em vez de 500 GIT_FAILED). Sem isso,
      // IDE clicando num arquivo que existe num worktree de chat mas NÃO no
      // MAIN_WORKTREE.HEAD recebe 500 e o painel mostra erro feio.
      if (
        /exists on disk, but not in/i.test(errOut) ||
        /unknown revision/i.test(errOut) ||
        /does (not |n't )exist in ['"]/i.test(errOut) ||
        /path .* does not exist/i.test(errOut) ||
        /bad object/i.test(errOut)
      ) {
        return reject(new GitError(errOut.trim(), 'NOT_FOUND'));
      }
      reject(new GitError(errOut.trim() || `git exit ${code}`, 'GIT_FAILED'));
    });
  });
}

export async function status(): Promise<GitStatusResult> {
  const out = await run(['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
  return parseStatusV2(out);
}

function parseStatusV2(out: string): GitStatusResult {
  const lines = out.split('\n');
  let branch = '';
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length);
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10); }
    } else if (line.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = line.split(' ');
      const xy = parts[1];
      const path = parts.slice(8).join(' ');
      const X = xy[0], Y = xy[1];
      if (X !== '.') staged.push({ path, status: mapXY(X) });
      if (Y !== '.') unstaged.push({ path, status: mapXY(Y) });
    } else if (line.startsWith('2 ')) {
      // rename/copy
      const parts = line.split(' ');
      const xy = parts[1];
      const rest = parts.slice(9).join(' ');
      const tabIdx = rest.indexOf('\t');
      const path = tabIdx >= 0 ? rest.slice(0, tabIdx) : rest;
      const oldPath = tabIdx >= 0 ? rest.slice(tabIdx + 1) : undefined;
      const X = xy[0], Y = xy[1];
      if (X !== '.') staged.push({ path, status: mapXY(X), oldPath });
      if (Y !== '.') unstaged.push({ path, status: mapXY(Y), oldPath });
    } else if (line.startsWith('? ')) {
      untracked.push(line.slice(2));
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      const path = parts.slice(10).join(' ');
      unstaged.push({ path, status: 'U' });
    }
  }

  return { branch, upstream, ahead, behind, staged, unstaged, untracked };
}

function mapXY(c: string): GitFileChange['status'] {
  if (c === 'A' || c === 'M' || c === 'D' || c === 'R' || c === 'C' || c === 'U') return c;
  return 'M';
}

export async function branches(): Promise<{ current: string; local: string[]; remote: string[] }> {
  const out = await run(['branch', '-a', '--format=%(HEAD)|%(refname)|%(refname:short)']);
  const local: string[] = [];
  const remote: string[] = [];
  let current = '';
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [head, refname, short] = line.split('|');
    const isHead = head.trim() === '*';
    if (refname.startsWith('refs/heads/')) {
      local.push(short.trim());
      if (isHead) current = short.trim();
    } else if (refname.startsWith('refs/remotes/')) {
      if (!short.includes(' -> ')) remote.push(short.trim());
    }
  }
  return { current, local, remote };
}

export async function log(opts: { path?: string; limit?: number; ref?: string } = {}): Promise<GitCommit[]> {
  const sep = '\x1f';
  const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%P'].join(sep);
  const args = ['log', `--pretty=format:${fmt}`, '-n', String(opts.limit ?? 50)];
  if (opts.ref) args.push(opts.ref);
  if (opts.path) args.push('--', opts.path);
  const out = await run(args);
  return out.split('\n').filter(Boolean).map((line): GitCommit => {
    const [hash, short, name, email, date, subject, parents] = line.split(sep);
    return {
      hash, short,
      author: { name, email },
      date, subject,
      parents: (parents ?? '').split(' ').filter(Boolean),
    };
  });
}

export async function diff(opts: { path?: string; staged?: boolean; ref?: string } = {}): Promise<string> {
  const args = ['diff', '--no-color'];
  if (opts.staged) args.push('--cached');
  if (opts.ref) args.push(opts.ref);
  if (opts.path) args.push('--', opts.path);
  return run(args, { timeoutMs: 30_000 });
}

export async function blame(p: string): Promise<GitBlameLine[]> {
  const out = await run(['blame', '--porcelain', '--', p]);
  return parseGitBlamePorcelain(out);
}

export async function show(ref: string, p: string): Promise<string> {
  return run(['show', `${ref}:${p}`]);
}
