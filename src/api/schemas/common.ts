import { Type, Static } from '@sinclair/typebox';

/**
 * Path relativo ao workspace. Recusa:
 *   - paths absolutos (`/etc/passwd`)
 *   - traversal (`../foo`)
 *   - null bytes
 *   - vazio ou > 4096 chars
 */
export const WorkspacePath = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: '^(?!/)(?!.*\\.\\.)(?!.*\\x00).+$',
  description: 'Path relativo ao workspace (sem leading /, sem ..).',
  examples: ['src/index.ts', 'docs/README.md', '.'],
});

export const ErrorResponse = Type.Object({
  error: Type.String(),
  code: Type.Optional(Type.String()),
});

export const FileEntry = Type.Object({
  name: Type.String(),
  type: Type.Union([Type.Literal('file'), Type.Literal('dir'), Type.Literal('other')]),
  size: Type.Optional(Type.Integer()),
  mtime: Type.Optional(Type.String({ format: 'date-time' })),
});

// Recursivo: TreeNode com children que aponta pra si mesmo via $id
// O OpenAPI bundler resolve isso corretamente
export const TreeNode = Type.Recursive((Self) =>
  Type.Object({
    name: Type.String(),
    type: Type.Union([Type.Literal('file'), Type.Literal('dir')]),
    size: Type.Optional(Type.Integer()),
    children: Type.Optional(Type.Array(Self)),
  }),
  { $id: 'TreeNode' },
);

// Inline tree type sem recursão explícita (evita $ref problemático no OpenAPI bundler)
// Usado no response real
export const InlineTreeNode = Type.Object({
  name: Type.String(),
  type: Type.Union([Type.Literal('file'), Type.Literal('dir')]),
  size: Type.Optional(Type.Integer()),
  children: Type.Optional(Type.Array(Type.Any())),
});

export type WorkspacePathT = Static<typeof WorkspacePath>;
export type FileEntryT    = Static<typeof FileEntry>;
export type TreeNodeT     = Static<typeof TreeNode>;
export type InlineTreeNodeT = Static<typeof InlineTreeNode>;
export type ErrorResponseT = Static<typeof ErrorResponse>;
