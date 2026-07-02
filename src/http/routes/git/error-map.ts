import type { FastifyReply } from 'fastify';
import { GitError } from '@/git/service.js';
import { GitCloneError } from '@/git/clone-error.js';
import { GitSyncError } from '@/git/sync-error.js';
import { GitCommitError } from '@/git/commit-error.js';
import { GitBranchError } from '@/git/branch-error.js';
import { GitApplyError } from '@/git/apply-error.js';
import { GitStashError } from '@/git/stash-error.js';
import { redactToken } from '@/git/redact.js';

export const GIT_STATUS_MAP: Record<string, number> = {
  NOT_A_REPO: 409,
  TIMEOUT: 408,
  NOT_FOUND: 404,
  GIT_FAILED: 500,
} as const;

export function mapGitError(e: unknown, reply: FastifyReply): void {
  if (e instanceof GitError) {
    const status = GIT_STATUS_MAP[e.code] ?? 500;
    reply.code(status).send({ error: e.message, code: e.code });
    return;
  }
  throw e;
}

export const GIT_CLONE_STATUS_MAP: Record<string, number> = {
  AUTH_FAILED: 401,
  REPO_NOT_FOUND: 404,
  TIMEOUT: 408,
  WORKSPACE_DIRTY: 409,
  REMOTE_MISMATCH: 409,
  GIT_FAILED: 500,
} as const;

export function mapGitCloneError(e: unknown, reply: FastifyReply): void {
  if (e instanceof GitCloneError) {
    const status = GIT_CLONE_STATUS_MAP[e.code] ?? 500;
    reply.code(status).send({ error: redactToken(e.message), code: e.code });
    return;
  }
  throw e;
}

// ─── Sync (pull/push/fetch) ────────────────────────────────────────────────
// `ALREADY_UP_TO_DATE` é tratado no orquestrador (vira `mode: 'up-to-date'`),
// nunca chega aqui. Mantemos a chave 200 só pra documentar.
export const GIT_SYNC_STATUS_MAP: Record<string, number> = {
  ALREADY_UP_TO_DATE: 200,
  AUTH_FAILED: 401,
  PROTECTED_BRANCH: 403,
  TIMEOUT: 408,
  NOT_A_REPO: 409,
  NON_FF_NEEDS_MERGE: 409,
  NON_FF: 409,
  DIRTY_WORKING_TREE: 409,
  UPSTREAM_MISSING: 409,
  // Arquivo acima do limite do GitHub (100MB). 413 Payload Too Large é o
  // status semanticamente correto e permite UI dedicada (sugerir LFS/.gitignore).
  FILE_TOO_LARGE: 413,
  GIT_FAILED: 500,
} as const;

export function mapGitSyncError(e: unknown, reply: FastifyReply): void {
  if (e instanceof GitSyncError) {
    const status = GIT_SYNC_STATUS_MAP[e.code] ?? 500;
    reply.code(status).send({ error: redactToken(e.message), code: e.code });
    return;
  }
  throw e;
}

// ─── Commit (stage / unstage / commit / reset-soft) ───────────────────────
export const GIT_COMMIT_STATUS_MAP: Record<string, number> = {
  EMPTY_COMMIT: 409,
  NOTHING_TO_STAGE: 409,
  MERGE_CONFLICT: 409,
  NOT_A_REPO: 409,
  TIMEOUT: 408,
  GIT_FAILED: 500,
} as const;

export function mapGitCommitError(e: unknown, reply: FastifyReply): void {
  if (e instanceof GitCommitError) {
    const status = GIT_COMMIT_STATUS_MAP[e.code] ?? 500;
    reply.code(status).send({ error: redactToken(e.message), code: e.code });
    return;
  }
  throw e;
}

// ─── Branch (create / checkout / delete / publish) ────────────────────────
export const GIT_BRANCH_STATUS_MAP: Record<string, number> = {
  BRANCH_EXISTS: 409,
  BRANCH_NOT_FOUND: 404,
  BRANCH_PROTECTED: 403,
  PROTECTED_BRANCH: 403,
  // Fase 2 worktree: branch já em uso por outro worktree (chat com /wt/<id>).
  // Git rejeita checkout no MAIN_WORKTREE. UX: o user precisa fechar o chat
  // que usa essa branch, ou usar outra branch.
  BRANCH_IN_USE: 409,
  // `git branch -d X` rejeitou X porque tem commits não mergeados em
  // HEAD/upstream. Comum em chat-branches pré-merge: o trabalho está
  // pushed pro GitHub mas a branch local não está mergeada no main.
  // 409 (Conflict) é semanticamente correto + UI consegue mostrar
  // mensagem clara em vez de 500 críptico.
  BRANCH_UNMERGED: 409,
  // Sandbox recusou `-D` porque a branch não está em origin/<name>.
  // Force delete só é seguro quando o trabalho está preservado no
  // remote (PR, push direto). Sem isso, perderia commits sem backup.
  UNSAFE_FORCE_DELETE: 409,
  DIRTY_WORKING_TREE: 409,
  UPSTREAM_EXISTS: 409,
  AUTH_FAILED: 401,
  NOT_A_REPO: 409,
  TIMEOUT: 408,
  GIT_FAILED: 500,
} as const;

export function mapGitBranchError(e: unknown, reply: FastifyReply): void {
  if (e instanceof GitBranchError) {
    const status = GIT_BRANCH_STATUS_MAP[e.code] ?? 500;
    reply.code(status).send({ error: redactToken(e.message), code: e.code });
    return;
  }
  throw e;
}

// ─── Apply (stage/discard hunk e linha) ───────────────────────────────────
export const GIT_APPLY_STATUS_MAP: Record<string, number> = {
  PATCH_INVALID: 400,
  PATCH_DOES_NOT_APPLY: 400,
  NOT_A_REPO: 409,
  TIMEOUT: 408,
  GIT_FAILED: 500,
} as const;

export function mapGitApplyError(e: unknown, reply: FastifyReply): void {
  if (e instanceof GitApplyError) {
    const status = GIT_APPLY_STATUS_MAP[e.code] ?? 500;
    reply.code(status).send({ error: redactToken(e.message), code: e.code });
    return;
  }
  throw e;
}

// ─── Stash ─────────────────────────────────────────────────────────────────
export const GIT_STASH_STATUS_MAP: Record<string, number> = {
  NO_STASH: 404,
  NO_CHANGES: 409,
  CONFLICT: 409,
  INVALID_REF: 400,
  NOT_A_REPO: 409,
  TIMEOUT: 408,
  GIT_FAILED: 500,
} as const;

export function mapGitStashError(e: unknown, reply: FastifyReply): void {
  if (e instanceof GitStashError) {
    const status = GIT_STASH_STATUS_MAP[e.code] ?? 500;
    reply.code(status).send({ error: redactToken(e.message), code: e.code });
    return;
  }
  throw e;
}
