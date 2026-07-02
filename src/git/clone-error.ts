import type { GitCloneCode } from './clone.js';

export class GitCloneError extends Error {
  constructor(
    message: string,
    public readonly code: GitCloneCode,
  ) {
    super(message);
    this.name = 'GitCloneError';
  }
}
