import { Type, Static } from '@sinclair/typebox';

// ── Search ──────────────────────────────────────────────────────────────────

export const RipgrepSearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: 'Search pattern (literal or regex)' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory relative to workspace (default: /)' })),
  include: Type.Optional(Type.String({ description: 'Glob pattern to include, e.g. "*.ts"' })),
  exclude: Type.Optional(Type.String({ description: 'Glob pattern to exclude, e.g. "node_modules"' })),
  caseSensitive: Type.Optional(Type.Boolean({ description: 'Case-sensitive matching (default: false)' })),
  regex: Type.Optional(Type.Boolean({ description: 'Treat query as regex (default: false)' })),
  maxResults: Type.Optional(Type.Integer({ description: 'Cap results count (default: 1000)', default: 1000 })),
});

export interface RipgrepSearchParamsT extends Static<typeof RipgrepSearchParams> {}

export const RipgrepResult = Type.Object({
  file: Type.String({ description: 'File path relative to workspace' }),
  line: Type.Integer({ description: '1-based line number' }),
  text: Type.String({ description: 'Full line content' }),
  context: Type.Optional(Type.String({ description: '3 lines before and after as joined string' })),
  absoluteOffset: Type.Integer({ description: 'Byte offset in file' }),
});

export interface RipgrepResultT extends Static<typeof RipgrepResult> {}

export const RipgrepSearchResponse = Type.Array(RipgrepResult);

// ── Replace ─────────────────────────────────────────────────────────────────

export const RipgrepReplaceParams = Type.Object({
  query: Type.String({ minLength: 1, description: 'Search pattern (literal or regex)' }),
  replacement: Type.String({ description: 'Replacement text' }),
  files: Type.Array(Type.String(), { minItems: 1, description: 'File paths relative to workspace' }),
  cwd: Type.Optional(Type.String()),
  caseSensitive: Type.Optional(Type.Boolean()),
  regex: Type.Optional(Type.Boolean()),
  include: Type.Optional(Type.String()),
  exclude: Type.Optional(Type.String()),
  dryRun: Type.Optional(Type.Boolean({ description: 'Preview without modifying files (default: false)' })),
});

export interface RipgrepReplaceParamsT extends Static<typeof RipgrepReplaceParams> {}

export const RipgrepReplaceResult = Type.Object({
  filesModified: Type.Integer({ description: 'Number of files changed' }),
  files: Type.Array(Type.String(), { description: 'List of modified file paths' }),
  replacements: Type.Integer({ description: 'Total replacement count' }),
  dryRun: Type.Optional(Type.Boolean()),
});

export interface RipgrepReplaceResultT extends Static<typeof RipgrepReplaceResult> {}