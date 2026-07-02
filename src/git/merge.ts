/**
 * Merge conflict primitives: list conflicts, resolve per-file, abort/continue.
 *
 * These helpers shell out to git via `spawn`. They are intentionally minimal:
 * the route layer is responsible for validation (path traversal, resolution
 * enum) and mapping errors to HTTP status codes.
 */

import { spawn } from 'node:child_process';
import { wrapWithDropPriv } from '../util/sandbox.js';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { getWorktreePath } from '../workspace.js';
import { parseConflictPaths } from '../lib/git-status-parser.js';

export type MergeErrorCode =
  | 'NOT_IN_MERGE'
  | 'NOT_A_REPO'
  | 'GIT_FAILED'
  | 'TIMEOUT'
  | 'INVALID_PATH'
  | 'IO_FAILED';

export class GitMergeError extends Error {
  constructor(message: string, public code: MergeErrorCode) {
    super(message);
    this.name = 'GitMergeError';
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string = getWorktreePath(), timeoutMs = 30_000): Promise<RunResult> {
  // C-9: git como uid 1001 (drop-priv). Resolução de conflito faz add/checkout/
  // commit-continue — como root deixava index/refs root-owned. Fallback sem setpriv.
  const [bin, ...binArgs] = await wrapWithDropPriv(['git', ...args]);
  return new Promise((resolve, reject) => {
    const p = spawn(bin, binArgs, {
      cwd,
      env: {
        ...process.env,
        HOME: '/home/sandbox',
        USER: 'sandbox',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new GitMergeError('git timeout', 'TIMEOUT'));
    }, timeoutMs);
    p.on('error', (err) => {
      clearTimeout(t);
      reject(new GitMergeError(err.message, 'GIT_FAILED'));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function listConflicts(cwd: string = getWorktreePath()): Promise<string[]> {
  const r = await runGit(['status', '--porcelain'], cwd);
  if (r.code !== 0) {
    if (/not a git repository/i.test(r.stderr)) {
      throw new GitMergeError('workspace is not a git repository', 'NOT_A_REPO');
    }
    throw new GitMergeError(r.stderr.trim() || `git status exit ${r.code}`, 'GIT_FAILED');
  }
  return parseConflictPaths(r.stdout);
}

export type Resolution = 'ours' | 'theirs' | 'both';

export async function resolveConflict(
  filePath: string,
  resolution: Resolution,
  cwd: string = getWorktreePath(),
): Promise<void> {
  if (resolution === 'ours' || resolution === 'theirs') {
    const flag = resolution === 'ours' ? '--ours' : '--theirs';
    const co = await runGit(['checkout', flag, '--', filePath], cwd);
    if (co.code !== 0) {
      throw new GitMergeError(
        co.stderr.trim() || `git checkout ${flag} exit ${co.code}`,
        'GIT_FAILED',
      );
    }
  } else {
    // both: strip conflict markers, keep content from both sides sequentially
    const abs = path.join(cwd, filePath);
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GitMergeError(`failed to read ${filePath}: ${msg}`, 'IO_FAILED');
    }
    const stripped = stripConflictMarkers(content);
    try {
      await writeFile(abs, stripped, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GitMergeError(`failed to write ${filePath}: ${msg}`, 'IO_FAILED');
    }
  }

  const add = await runGit(['add', '--', filePath], cwd);
  if (add.code !== 0) {
    throw new GitMergeError(
      add.stderr.trim() || `git add exit ${add.code}`,
      'GIT_FAILED',
    );
  }
}

/**
 * Removes `<<<<<<<`, `=======` and `>>>>>>>` conflict markers, keeping content
 * from both sides concatenated sequentially. This is a best-effort "both" merge
 * — the user is expected to review the result.
 */
export function stripConflictMarkers(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inConflict = false;
  let seenSeparator = false;
  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      seenSeparator = false;
      continue;
    }
    if (line.startsWith('=======') && inConflict) {
      seenSeparator = true;
      continue;
    }
    if (line.startsWith('>>>>>>>') && inConflict) {
      inConflict = false;
      seenSeparator = false;
      continue;
    }
    // When inside a conflict, both pre-separator (ours) and post-separator
    // (theirs) lines are kept. When not in a conflict, normal lines pass.
    out.push(line);
    void seenSeparator;
  }
  return out.join('\n');
}

async function isInMerge(cwd: string = getWorktreePath()): Promise<boolean> {
  try {
    await access(path.join(cwd, '.git', 'MERGE_HEAD'));
    return true;
  } catch {
    return false;
  }
}

export async function abortMerge(cwd: string = getWorktreePath()): Promise<void> {
  if (!(await isInMerge(cwd))) {
    throw new GitMergeError('no merge in progress', 'NOT_IN_MERGE');
  }
  const r = await runGit(['merge', '--abort'], cwd);
  if (r.code !== 0) {
    throw new GitMergeError(r.stderr.trim() || `git merge --abort exit ${r.code}`, 'GIT_FAILED');
  }
}

export async function continueMerge(cwd: string = getWorktreePath()): Promise<void> {
  if (!(await isInMerge(cwd))) {
    throw new GitMergeError('no merge in progress', 'NOT_IN_MERGE');
  }
  const r = await runGit(['-c', 'core.editor=true', 'merge', '--continue'], cwd);
  if (r.code !== 0) {
    throw new GitMergeError(r.stderr.trim() || `git merge --continue exit ${r.code}`, 'GIT_FAILED');
  }
}
