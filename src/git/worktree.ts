/**
 * Helpers de `git worktree` (Fase 2 — worktree-feature).
 *
 * Cada chat ativo (não-legacy) tem seu próprio worktree em
 * `/wt/<conversationId>`. O .git central fica em `MAIN_WORKTREE/.git`;
 * cada worktree tem um arquivo `.git` que aponta pra
 * `MAIN_WORKTREE/.git/worktrees/<conversationId>`.
 *
 * O app-core orquestra create/remove via REST quando o user cria/arquiva
 * o chat. Aqui são só as primitivas — não sabem nada de Conversation.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  MAIN_WORKTREE,
  resolveWorktreePath,
  SANDBOX_GID,
  SANDBOX_UID,
  WORKTREES_BASE,
} from '../workspace.js';

export type WorktreeErrorCode =
  | 'NOT_A_REPO'
  | 'ALREADY_EXISTS'
  | 'BRANCH_NOT_FOUND'
  | 'BRANCH_IN_USE'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export class WorktreeError extends Error {
  constructor(message: string, public code: WorktreeErrorCode) {
    super(message);
    this.name = 'WorktreeError';
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new WorktreeError('git timeout', 'TIMEOUT'));
    }, timeoutMs);
    p.on('error', (err) => {
      clearTimeout(t);
      reject(new WorktreeError(err.message, 'GIT_FAILED'));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function classify(stderr: string): WorktreeErrorCode {
  if (/not a git repository/i.test(stderr)) return 'NOT_A_REPO';
  if (/already exists|is already (?:checked out|registered)/i.test(stderr))
    return 'ALREADY_EXISTS';
  if (/already used by worktree|is already checked out at/i.test(stderr))
    return 'BRANCH_IN_USE';
  if (
    /invalid reference|not a valid object name|did not match any|unknown revision/i.test(stderr)
  )
    return 'BRANCH_NOT_FOUND';
  return 'GIT_FAILED';
}

export interface CreateWorktreeOpts {
  conversationId: string;
  branchName: string;
  /** Branch ou ref de origem. Ex.: 'main' ou 'origin/main'. */
  baseBranch: string;
}

export interface WorktreeInfo {
  conversationId: string;
  worktreePath: string;
  branch: string;
  head: string;
}

/**
 * Cria worktree em `/wt/<conversationId>` com uma branch nova `branchName`
 * baseada em `baseBranch`. Opera contra o MAIN_WORKTREE (onde vive o .git
 * central).
 *
 * O `git worktree add` é executado como root (sandbox-agent roda como root)
 * — mas os subprocessos do agente caem pra uid=1001 via bwrap+setpriv pra
 * isolamento. Sem o chown abaixo, esses subprocessos não conseguem escrever
 * `.git/index.lock` no worktree (root:root) e qualquer `git commit` falha
 * com "Permission denied".
 */
export async function createWorktree(
  opts: CreateWorktreeOpts,
): Promise<{ worktreePath: string; branch: string }> {
  const wtPath = resolveWorktreePath(opts.conversationId);
  const r = await runGit(
    ['worktree', 'add', '-b', opts.branchName, wtPath, opts.baseBranch],
    MAIN_WORKTREE,
  );
  if (r.code !== 0) {
    throw new WorktreeError(r.stderr.trim() || 'git worktree add falhou', classify(r.stderr));
  }

  // Chown de TODOS os paths que o git toca quando o agente (uid 1001 via
  // bwrap+setpriv) faz commit/push/branch ops:
  //
  //   /wt/<id>/                                 — working tree do worktree
  //   /workspace/.git/worktrees/<id>/           — gitdir do worktree (HEAD, index, etc.)
  //   /workspace/.git/refs/heads/<branchName>   — ref da branch
  //   /workspace/.git/logs/refs/heads/<branchName> — reflog da branch (criado on first commit)
  //   /workspace/.git/logs/HEAD                 — reflog do main HEAD (git às vezes append)
  //
  // Bug original: faltavam refs/heads/<branch> + logs/refs/heads/<branch>.
  // `git commit` falhava com:
  //   fatal: cannot update the ref 'refs/heads/<branch>':
  //     unable to append to '/workspace/.git/logs/refs/heads/<branch>': Permission denied
  //
  // Pra branches com `/` (ex.: feat/login) o branchName vira subdir;
  // chownRecursive cobre o arquivo independente.
  const gitdir = path.join(MAIN_WORKTREE, '.git', 'worktrees', opts.conversationId);
  const branchRef = path.join(MAIN_WORKTREE, '.git', 'refs', 'heads', opts.branchName);
  const branchReflog = path.join(MAIN_WORKTREE, '.git', 'logs', 'refs', 'heads', opts.branchName);
  const headReflog = path.join(MAIN_WORKTREE, '.git', 'logs', 'HEAD');
  await Promise.all([
    chownRecursive(wtPath),
    chownRecursive(gitdir),
    chownRecursive(branchRef),
    chownRecursive(branchReflog),
    chownRecursive(headReflog),
  ]);

  return { worktreePath: wtPath, branch: opts.branchName };
}

function chownRecursive(target: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(
      'chown',
      ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, target],
      { stdio: 'ignore' },
    );
    p.on('error', () => resolve());
    p.on('close', () => resolve());
  });
}

export interface RemoveWorktreeOpts {
  conversationId: string;
  /** Se true, `git worktree remove --force`. Usado quando há mudanças não-commitadas. */
  force?: boolean;
}

/**
 * Remove o worktree de `/wt/<conversationId>`. Por default não força:
 * se houver mudanças locais, git recusa — caller decide se passa `force`.
 */
export async function removeWorktree(opts: RemoveWorktreeOpts): Promise<void> {
  const wtPath = resolveWorktreePath(opts.conversationId);
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(wtPath);
  const r = await runGit(args, MAIN_WORKTREE);
  if (r.code !== 0) {
    // Se o worktree já foi removido manualmente (path não existe), git
    // devolve erro mas o resultado desejado já está alcançado — tolera.
    if (/is not a working tree|does not exist/i.test(r.stderr)) return;
    throw new WorktreeError(r.stderr.trim() || 'git worktree remove falhou', classify(r.stderr));
  }
}

/**
 * Lista todos os worktrees do repo central. Inclui o MAIN_WORKTREE.
 */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const r = await runGit(['worktree', 'list', '--porcelain'], MAIN_WORKTREE);
  if (r.code !== 0) {
    throw new WorktreeError(r.stderr.trim() || 'git worktree list falhou', classify(r.stderr));
  }
  return parsePorcelain(r.stdout);
}

function parsePorcelain(out: string): WorktreeInfo[] {
  const blocks = out.split(/\n\n+/).filter(Boolean);
  const result: WorktreeInfo[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let wtPath = '';
    let head = '';
    let branch = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length);
    }
    if (!wtPath) continue;
    // Só são "chat worktrees" os que ficam embaixo de /wt/. MAIN_WORKTREE
    // também aparece na lista; o caller filtra se quiser.
    const isChatWorktree = wtPath.startsWith(WORKTREES_BASE + '/');
    const conversationId = isChatWorktree ? path.basename(wtPath) : '';
    result.push({
      conversationId,
      worktreePath: wtPath,
      branch: branch.replace(/^refs\/heads\//, ''),
      head,
    });
  }
  return result;
}
