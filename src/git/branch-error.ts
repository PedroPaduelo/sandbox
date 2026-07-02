/**
 * Erro tipado das operações de gestão de branches
 * (create / checkout / delete / publish). Espelha `GitSyncError`.
 */

export type GitBranchCode =
  | 'BRANCH_EXISTS'
  | 'BRANCH_NOT_FOUND'
  | 'BRANCH_PROTECTED'
  | 'BRANCH_IN_USE'
  | 'BRANCH_UNMERGED'
  | 'UNSAFE_FORCE_DELETE'
  | 'DIRTY_WORKING_TREE'
  | 'AUTH_FAILED'
  | 'PROTECTED_BRANCH'
  | 'UPSTREAM_EXISTS'
  | 'NOT_A_REPO'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export class GitBranchError extends Error {
  constructor(
    message: string,
    public readonly code: GitBranchCode,
  ) {
    super(message);
    this.name = 'GitBranchError';
  }
}
