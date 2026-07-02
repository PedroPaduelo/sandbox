import { Type, Static } from '@sinclair/typebox';

export const GitFileChange = Type.Object({
  path: Type.String(),
  status: Type.Union([
    Type.Literal('A'), Type.Literal('M'), Type.Literal('D'),
    Type.Literal('R'), Type.Literal('C'),
    Type.Literal('?'), Type.Literal('!'),
    Type.Literal('U'),  // unmerged
  ]),
  oldPath: Type.Optional(Type.String()),
});

export const GitStatus = Type.Object({
  branch: Type.String(),
  upstream: Type.Optional(Type.String()),
  ahead: Type.Integer(),
  behind: Type.Integer(),
  staged: Type.Array(GitFileChange),
  unstaged: Type.Array(GitFileChange),
  untracked: Type.Array(Type.String()),
});

export const GitBranches = Type.Object({
  current: Type.String(),
  local: Type.Array(Type.String()),
  remote: Type.Array(Type.String()),
});

export const GitCommit = Type.Object({
  hash: Type.String(),
  short: Type.String(),
  author: Type.Object({ name: Type.String(), email: Type.String() }),
  date: Type.String({ format: 'date-time' }),
  subject: Type.String(),
  parents: Type.Array(Type.String()),
});

export const GitLogReq = Type.Object({
  path: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
  ref: Type.Optional(Type.String()),
});
export const GitLogRes = Type.Array(GitCommit);

export const GitDiffReq = Type.Object({
  path: Type.Optional(Type.String()),
  staged: Type.Optional(Type.Boolean({ default: false })),
  ref: Type.Optional(Type.String()),
});
// resposta é text/x-diff (raw)

export const GitBlameLine = Type.Object({
  line: Type.Integer(),
  hash: Type.String(),
  author: Type.String(),
  date: Type.String(),
  summary: Type.String(),
});
export const GitBlameReq = Type.Object({ path: Type.String() });
export const GitBlameRes = Type.Object({ lines: Type.Array(GitBlameLine) });

export const GitShowReq = Type.Object({ ref: Type.String(), path: Type.String() });
// resposta é raw

export const GitCloneReq = Type.Object({
  url: Type.String({ minLength: 1 }),
  ref: Type.Optional(Type.String()),
  token: Type.Optional(Type.String()),
  depth: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  authorName: Type.Optional(Type.String()),
  authorEmail: Type.Optional(Type.String()),
  cleanIfDirty: Type.Optional(Type.Boolean({ default: false })),
});

export const GitCloneHead = Type.Object({
  hash: Type.String(),
  short: Type.String(),
  subject: Type.String(),
  author: Type.String(),
  date: Type.String(),
});

export const GitCloneRes = Type.Object({
  status: Type.Union([Type.Literal('cloned'), Type.Literal('updated')]),
  branch: Type.String(),
  head: GitCloneHead,
  remoteUrl: Type.String(),
  workspacePath: Type.String(),
});

// ─── Git Sync (pull/push/fetch) ───────────────────────────────────────────
// Pull com --ff-only (merge fora do escopo). Token injetado por chamada.
export const GitPullReq = Type.Object({
  token: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()), // default: branch atual
  ffOnly: Type.Optional(Type.Boolean({ default: true })),
});

export const GitPullRes = Type.Object({
  ok: Type.Literal(true),
  mode: Type.Union([Type.Literal('fast-forward'), Type.Literal('up-to-date')]),
  branch: Type.String(),
  ahead: Type.Integer(),
  behind: Type.Integer(),
  head: GitCloneHead,
});

// Push — `setUpstream=true` (default) faz `-u origin <branch>` quando upstream missing.
export const GitPushReq = Type.Object({
  token: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()), // default: branch atual
  setUpstream: Type.Optional(Type.Boolean({ default: true })),
});

export const GitPushRes = Type.Object({
  ok: Type.Literal(true),
  pushed: Type.Integer(), // num de commits empurrados (estimado a partir do stderr)
  upstreamCreated: Type.Boolean(), // true quando rodou com -u e set up to track
  branch: Type.String(),
  head: GitCloneHead,
});

// Fetch — `--prune` por default; `--all` opcional.
export const GitFetchReq = Type.Object({
  token: Type.Optional(Type.String()),
  all: Type.Optional(Type.Boolean({ default: false })), // --all
  prune: Type.Optional(Type.Boolean({ default: true })), // --prune
});

export const GitFetchRes = Type.Object({
  ok: Type.Literal(true),
  branch: Type.String(),
  ahead: Type.Integer(),
  behind: Type.Integer(),
  refsUpdated: Type.Array(Type.String()),
});

export type GitFileChangeT = Static<typeof GitFileChange>;
export type GitStatusT = Static<typeof GitStatus>;
export type GitBranchesT = Static<typeof GitBranches>;
export type GitCommitT = Static<typeof GitCommit>;
export type GitLogReqT = Static<typeof GitLogReq>;
export type GitLogResT = Static<typeof GitLogRes>;
export type GitDiffReqT = Static<typeof GitDiffReq>;
export type GitBlameLineT = Static<typeof GitBlameLine>;
export type GitBlameReqT = Static<typeof GitBlameReq>;
export type GitBlameResT = Static<typeof GitBlameRes>;
export type GitShowReqT = Static<typeof GitShowReq>;
export type GitCloneReqT = Static<typeof GitCloneReq>;
export type GitCloneResT = Static<typeof GitCloneRes>;
export type GitPullReqT = Static<typeof GitPullReq>;
export type GitPullResT = Static<typeof GitPullRes>;
export type GitPushReqT = Static<typeof GitPushReq>;
export type GitPushResT = Static<typeof GitPushRes>;
export type GitFetchReqT = Static<typeof GitFetchReq>;
export type GitFetchResT = Static<typeof GitFetchRes>;

// ─── Git Write API (stage / unstage / commit / branch CRUD / publish) ─────

export const GitStageReq = Type.Object({
  paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export const GitUnstageReq = Type.Object({
  paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export const GitCommitReq = Type.Object({
  message: Type.String({ minLength: 1 }),
  author: Type.Optional(
    Type.Object({
      name: Type.String({ minLength: 1 }),
      // Não usar `format: 'email'` — Fastify ajv não tem formats registrados
      // por default e a validação falha silenciosamente, retornando 500 em ~5ms.
      // Email vem injetado server-side pelo app-core (do auth-service),
      // já é confiável.
      email: Type.String({ minLength: 3 }),
    }),
  ),
  /** Quando true, reescreve o último commit via `git commit --amend`. */
  amend: Type.Optional(Type.Boolean({ default: false })),
});

export const GitCommitRes = Type.Object({
  ok: Type.Literal(true),
  hash: Type.String(),
  short: Type.String(),
  branch: Type.String(),
  filesChanged: Type.Integer(),
});

export const GitBranchCreateReq = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  checkout: Type.Optional(Type.Boolean({ default: false })),
});

export const GitBranchCheckoutReq = Type.Object({
  name: Type.String({ minLength: 1 }),
});

export const GitBranchDeleteParams = Type.Object({
  name: Type.String({ minLength: 1 }),
});

export const GitBranchDeleteQuery = Type.Object({
  force: Type.Optional(Type.Boolean({ default: false })),
  /**
   * Quando true, usa `git branch -D` (force delete) em vez de `-d`. Só é
   * permitido quando a branch existe em origin/<name> — ou seja, o trabalho
   * já está pushed pro remote e perder local é seguro. Se a branch não
   * estiver no remote, sandbox rejeita com UNSAFE_FORCE_DELETE pra evitar
   * perda de commits sem backup.
   */
  allowUnmerged: Type.Optional(Type.Boolean({ default: false })),
});

export const GitBranchPublishReq = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  token: Type.String({ minLength: 1 }),
});

export const GitBranchOpRes = Type.Object({
  ok: Type.Literal(true),
  branch: Type.String(),
  upstreamCreated: Type.Optional(Type.Boolean()),
  /**
   * Só preenchido pelo /branch/checkout: true quando a branch estava em
   * uso por outro worktree e caímos no fallback `checkout --detach`. UI
   * usa esse flag pra avisar o user que está em modo read-only.
   */
  detached: Type.Optional(Type.Boolean()),
});

// ─── Discard (per-path / all) ─────────────────────────────────────────────

export const GitDiscardReq = Type.Object({
  paths: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 5000,
  }),
});

export const GitDiscardRes = Type.Object({
  ok: Type.Literal(true),
  discarded: Type.Array(Type.String()),
  skipped: Type.Array(Type.String()),
});

export type GitStageReqT = Static<typeof GitStageReq>;
export type GitUnstageReqT = Static<typeof GitUnstageReq>;
export type GitCommitReqT = Static<typeof GitCommitReq>;
export type GitCommitResT = Static<typeof GitCommitRes>;
export type GitBranchCreateReqT = Static<typeof GitBranchCreateReq>;
export type GitBranchCheckoutReqT = Static<typeof GitBranchCheckoutReq>;
export type GitBranchDeleteParamsT = Static<typeof GitBranchDeleteParams>;
export type GitBranchDeleteQueryT = Static<typeof GitBranchDeleteQuery>;
export type GitBranchPublishReqT = Static<typeof GitBranchPublishReq>;
export type GitBranchOpResT = Static<typeof GitBranchOpRes>;
export type GitDiscardReqT = Static<typeof GitDiscardReq>;
export type GitDiscardResT = Static<typeof GitDiscardRes>;

// ─── Apply (stage/discard hunk e linha) ───────────────────────────────────

export const GitApplyReq = Type.Object({
  // Patch unified-diff. minLength=1; conteúdo é validado pelo próprio git.
  patch: Type.String({ minLength: 1 }),
  cached: Type.Optional(Type.Boolean({ default: false })),
  reverse: Type.Optional(Type.Boolean({ default: false })),
});

export const GitApplyRes = Type.Object({
  ok: Type.Literal(true),
});

export type GitApplyReqT = Static<typeof GitApplyReq>;
export type GitApplyResT = Static<typeof GitApplyRes>;

// ─── Stash ────────────────────────────────────────────────────────────────

export const GitStashPushReq = Type.Object({
  message: Type.Optional(Type.String({ minLength: 1 })),
  includeUntracked: Type.Optional(Type.Boolean({ default: false })),
});

export const GitStashPushRes = Type.Object({
  ok: Type.Literal(true),
  created: Type.Boolean(),
});

export const GitStashEntry = Type.Object({
  ref: Type.String(),
  index: Type.Integer(),
  message: Type.String(),
  branch: Type.String(),
});

export const GitStashListRes = Type.Array(GitStashEntry);

// `ref` opcional para pop/apply (default stash@{0}); obrigatório em drop.
export const GitStashRefReq = Type.Object({
  ref: Type.Optional(Type.String({ minLength: 1 })),
});

export const GitStashDropReq = Type.Object({
  ref: Type.String({ minLength: 1 }),
});

export const GitStashOpRes = Type.Object({
  ok: Type.Literal(true),
});

export type GitStashPushReqT = Static<typeof GitStashPushReq>;
export type GitStashPushResT = Static<typeof GitStashPushRes>;
export type GitStashEntryT = Static<typeof GitStashEntry>;
export type GitStashListResT = Static<typeof GitStashListRes>;
export type GitStashRefReqT = Static<typeof GitStashRefReq>;
export type GitStashDropReqT = Static<typeof GitStashDropReq>;
export type GitStashOpResT = Static<typeof GitStashOpRes>;
