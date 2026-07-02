/**
 * Erro tipado das primitivas de write-side local (stage / unstage / commit / reset-soft).
 * Espelha `GitSyncError` em `sync-error.ts`.
 */

export type GitCommitCode =
  | 'EMPTY_COMMIT'
  | 'NOTHING_TO_STAGE'
  | 'MERGE_CONFLICT'
  | 'NOT_A_REPO'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export class GitCommitError extends Error {
  constructor(
    message: string,
    public readonly code: GitCommitCode,
  ) {
    super(message);
    this.name = 'GitCommitError';
  }
}
