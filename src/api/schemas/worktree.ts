import { Type } from '@sinclair/typebox';

/**
 * Schemas REST da gestão de worktrees (Fase 2 — worktree-feature).
 * Consumidos pelo app-core via gateway proxy, na criação/arquivamento de
 * conversas.
 */

export const WorktreeCreateReq = Type.Object({
  conversationId: Type.String({ minLength: 1, maxLength: 64 }),
  branchName: Type.String({ minLength: 1, maxLength: 255 }),
  baseBranch: Type.String({ minLength: 1, maxLength: 255 }),
});

export const WorktreeCreateRes = Type.Object({
  worktreePath: Type.String(),
  branch: Type.String(),
});

export const WorktreeIdParams = Type.Object({
  conversationId: Type.String({ minLength: 1, maxLength: 64 }),
});

export const WorktreeRemoveQuery = Type.Object({
  force: Type.Optional(Type.Boolean()),
});

export const WorktreeInfoItem = Type.Object({
  conversationId: Type.String(),
  worktreePath: Type.String(),
  branch: Type.String(),
  head: Type.String(),
});

export const WorktreeListRes = Type.Object({
  worktrees: Type.Array(WorktreeInfoItem),
});

// ── main sync ─────────────────────────────────────────────────────────

export const MainSyncReq = Type.Object({
  /** Token GitHub pra remote auth. Opcional pra repos sem auth. */
  token: Type.Optional(Type.String()),
  /** Pra fetch: `--all`. Pra pull: irrelevante. */
  all: Type.Optional(Type.Boolean()),
  /** Pra fetch: `--prune`. Default true. */
  prune: Type.Optional(Type.Boolean()),
});

const SyncHead = Type.Object({
  hash: Type.String(),
  short: Type.String(),
  subject: Type.String(),
  author: Type.String(),
  date: Type.String(),
});

/**
 * Espelha `FetchRepoResult` / `PullRepoResult` de git/sync.ts.
 * `head` só vem no pull (fetch só atualiza refs). `refsUpdated` só no fetch.
 * `mode` só no pull. Todos opcionais via additionalProperties + Optional.
 */
export const MainSyncRes = Type.Object(
  {
    branch: Type.String(),
    head: Type.Optional(SyncHead),
    ahead: Type.Integer(),
    behind: Type.Integer(),
    mode: Type.Optional(
      Type.Union([
        Type.Literal('fast-forward'),
        Type.Literal('up-to-date'),
      ]),
    ),
    refsUpdated: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);
