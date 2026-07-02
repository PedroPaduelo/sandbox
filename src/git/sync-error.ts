/**
 * Erro tipado dos endpoints de sync (pull/push/fetch). Espelha `GitCloneError`
 * em `clone-error.ts`. O code é union das 3 sub-categorias para que o
 * error-map possa rotear pra HTTP status corretos.
 */

import type { GitPullCode, GitPushCode, GitFetchCode } from './sync-ops.js';

export type GitSyncCode = GitPullCode | GitPushCode | GitFetchCode;

export class GitSyncError extends Error {
  constructor(
    message: string,
    public readonly code: GitSyncCode,
  ) {
    super(message);
    this.name = 'GitSyncError';
  }
}
