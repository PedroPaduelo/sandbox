// Custom error classes for sandbox-agent

export class BadRequestError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NotFoundError';
  }
}
