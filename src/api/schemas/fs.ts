import { Type, Static } from '@sinclair/typebox';
import { WorkspacePath, FileEntry, InlineTreeNode } from './common.js';

// GET /fs/list
export const ListReq = Type.Object({
  path: Type.Optional(WorkspacePath),
});
export const ListRes = Type.Object({
  path: Type.String(),
  entries: Type.Array(FileEntry),
});

// GET /fs/file
export const FileReadReq = Type.Object({
  path: WorkspacePath,
});
// resposta é raw — não precisa de schema; só o erro.

// PUT /fs/file (JSON body)
export const FileWriteJsonReq = Type.Object({
  path: WorkspacePath,
  content: Type.String({ description: 'Conteúdo do arquivo (UTF-8)' }),
});
export const FileWriteRes = Type.Object({
  ok: Type.Literal(true),
  path: Type.String(),
  bytes: Type.Integer(),
  etag: Type.String(),
});

// PUT /fs/file/raw (querystring só — body é raw)
export const FileWriteRawReq = Type.Object({
  path: WorkspacePath,
});
export type FileWriteRawReqT = Static<typeof FileWriteRawReq>;

// PATCH /fs/file
export const FileEditReq = Type.Object({
  path: WorkspacePath,
  oldText: Type.String({ minLength: 1 }),
  newText: Type.String(),
});
export const FileEditRes = Type.Object({
  ok: Type.Literal(true),
  path: Type.String(),
  etag: Type.String(),
});

// DELETE /fs/file
export const FileDeleteReq = Type.Object({
  path: WorkspacePath,
  recursive: Type.Optional(Type.Boolean({ default: false })),
});

// POST /fs/mkdir
export const MkdirReq = Type.Object({ path: WorkspacePath });
export const MkdirRes = Type.Object({ ok: Type.Literal(true), path: Type.String() });

// POST /fs/move
export const MoveReq = Type.Object({ from: WorkspacePath, to: WorkspacePath });
export const MoveRes = Type.Object({ ok: Type.Literal(true), from: Type.String(), to: Type.String() });

// GET /fs/stat
export const StatReq = Type.Object({ path: WorkspacePath });
export const StatRes = Type.Object({
  path: Type.String(),
  type: Type.Union([Type.Literal('file'), Type.Literal('dir'), Type.Literal('other')]),
  size: Type.Integer(),
  mtime: Type.String({ format: 'date-time' }),
});

// GET /fs/tree
export const TreeReq = Type.Object({
  path: Type.Optional(WorkspacePath),
  depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3 })),
  maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 500 })),
  hidden: Type.Optional(Type.Boolean({ default: false })),
});
export const TreeRes = Type.Object({
  root: Type.String(),
  totalEntries: Type.Integer(),
  truncated: Type.Boolean(),
  tree: Type.Array(InlineTreeNode),
});

// POST /fs/search
export const SearchReq = Type.Object({
  pattern: Type.String({ minLength: 1, maxLength: 500 }),
  onlyNames: Type.Optional(Type.Boolean({ default: false })),
  path: Type.Optional(WorkspacePath),
  caseInsensitive: Type.Optional(Type.Boolean({ default: false })),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 200 })),
});
export const SearchMatch = Type.Object({
  file: Type.String(),
  line: Type.Optional(Type.Integer()),
  column: Type.Optional(Type.Integer()),
  text: Type.Optional(Type.String()),
});
export const SearchRes = Type.Object({
  matches: Type.Array(SearchMatch),
  truncated: Type.Boolean(),
  tool: Type.Union([Type.Literal('ripgrep'), Type.Literal('grep/find')]),
});

// GET /fs/file/range
export const RangeReq = Type.Object({
  path: WorkspacePath,
  from: Type.Integer({ minimum: 1 }),
  to:   Type.Integer({ minimum: 1, maximum: 100_000 }),
});
export const RangeRes = Type.Object({
  path: Type.String(),
  fromLine: Type.Integer(),
  toLine: Type.Integer(),
  totalLines: Type.Integer(),
  truncated: Type.Boolean(),
  content: Type.String(),
});

// WS /fs/watch (querystring)
export const WatchReq = Type.Object({
  paths: Type.Optional(Type.String({ description: 'CSV de paths relativos. Vazio = workspace root.' })),
  events: Type.Optional(Type.String({ description: 'CSV de tipos: created,modified,deleted' })),
  token: Type.Optional(Type.String({ description: 'Auth alternativa (browser não manda header em new WebSocket)' })),
});

export type ListReqT = Static<typeof ListReq>;
export type ListResT = Static<typeof ListRes>;
export type FileReadReqT = Static<typeof FileReadReq>;
export type FileWriteJsonReqT = Static<typeof FileWriteJsonReq>;
export type FileWriteResT = Static<typeof FileWriteRes>;
export type FileEditReqT = Static<typeof FileEditReq>;
export type FileEditResT = Static<typeof FileEditRes>;
export type FileDeleteReqT = Static<typeof FileDeleteReq>;
export type MkdirReqT = Static<typeof MkdirReq>;
export type MkdirResT = Static<typeof MkdirRes>;
export type MoveReqT = Static<typeof MoveReq>;
export type MoveResT = Static<typeof MoveRes>;
export type StatReqT = Static<typeof StatReq>;
export type StatResT = Static<typeof StatRes>;
export type TreeReqT = Static<typeof TreeReq>;
export type TreeResT = Static<typeof TreeRes>;
export type SearchReqT = Static<typeof SearchReq>;
export type SearchMatchT = Static<typeof SearchMatch>;
export type SearchResT = Static<typeof SearchRes>;
export type RangeReqT = Static<typeof RangeReq>;
export type RangeResT = Static<typeof RangeRes>;
export type WatchReqT = Static<typeof WatchReq>;
