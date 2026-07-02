# API REST do sandbox-agent

Esta pasta contém os schemas TypeBox para validação de requests/responses da nova API REST em `/api/v1/*`.

## Mapeamento Endpoint → Schema

| Método | Path | Request Schema | Response Schema | Task |
|--------|------|----------------|-----------------|------|
| GET    | /api/v1/fs/list      | `ListReq`      | `ListRes`       | 02   |
| GET    | /api/v1/fs/file      | `FileReadReq`  | raw             | 02, 04 |
| PUT    | /api/v1/fs/file      | `FileWriteJsonReq` ou raw | `FileWriteRes` | 02, 04 |
| PATCH  | /api/v1/fs/file      | `FileEditReq`  | `FileEditRes`   | 02   |
| DELETE | /api/v1/fs/file      | `FileDeleteReq`| -               | 02   |
| POST   | /api/v1/fs/mkdir     | `MkdirReq`     | `MkdirRes`      | 02   |
| POST   | /api/v1/fs/move      | `MoveReq`      | `MoveRes`       | 02   |
| GET    | /api/v1/fs/stat      | `StatReq`      | `StatRes`       | 02   |
| GET    | /api/v1/fs/tree      | `TreeReq`      | `TreeRes`       | 03   |
| POST   | /api/v1/fs/search    | `SearchReq`    | `SearchRes`     | 03   |
| GET    | /api/v1/fs/file/range| `RangeReq`     | `RangeRes`      | 04   |
| WS     | /api/v1/fs/watch     | `WatchReq`     | eventos JSON    | 05   |
| GET    | /api/v1/git/status   | -              | `GitStatus`     | 06   |
| GET    | /api/v1/git/branches | -              | `GitBranches`   | 06   |
| GET    | /api/v1/git/log      | `GitLogReq`    | `GitLogRes`     | 06   |
| GET    | /api/v1/git/diff     | `GitDiffReq`   | raw             | 06   |
| GET    | /api/v1/git/blame    | `GitBlameReq`  | `GitBlameRes`   | 06   |
| GET    | /api/v1/git/show     | `GitShowReq`   | raw             | 06   |
| GET    | /api/v1/workspace    | -              | `WorkspaceRes`  | 07   |
| GET    | /api/v1/openapi.json | -              | OpenAPI 3.1     | 11   |
| GET    | /api/v1/docs         | -              | HTML UI         | 11   |

## Schemas Compartilhados

- **`common.ts`**: `WorkspacePath`, `ErrorResponse`, `FileEntry`, `TreeNode`
- **`fs.ts`**: Todos os schemas relacionados a filesystem
- **`git.ts`**: Todos os schemas relacionados a git
- **`workspace.ts`**: Schema para informações do workspace

## Validação

Todos os schemas são validados em runtime pelo Fastify quando as rotas são registradas com `schema: { body, querystring, response }`.

## Tipos TypeScript

Cada schema exporta seu tipo TypeScript correspondente (ex: `ListReqT`, `ListResT`) que pode ser usado em código para tipar requests/responses.
