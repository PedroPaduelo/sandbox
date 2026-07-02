/**
 * Erro tipado da primitiva `git apply` (stage/discard hunk e linha).
 */

export type GitApplyCode =
  | 'PATCH_INVALID'        // patch mal formado / corrompido
  | 'PATCH_DOES_NOT_APPLY' // contexto não bate ('does not apply', 'patch failed')
  | 'NOT_A_REPO'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export class GitApplyError extends Error {
  constructor(
    message: string,
    public readonly code: GitApplyCode,
  ) {
    super(message);
    this.name = 'GitApplyError';
  }
}
