/**
 * Erro tipado das primitivas de stash.
 */

export type GitStashCode =
  | 'NO_STASH'             // stash list vazio / ref inexistente
  | 'NO_CHANGES'           // nothing to stash
  | 'CONFLICT'             // pop/apply gerou conflito
  | 'INVALID_REF'          // ref mal formada
  | 'NOT_A_REPO'
  | 'TIMEOUT'
  | 'GIT_FAILED';

export class GitStashError extends Error {
  constructor(
    message: string,
    public readonly code: GitStashCode,
  ) {
    super(message);
    this.name = 'GitStashError';
  }
}
