export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid username or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class NoActiveSessionError extends Error {
  constructor() {
    super('No active session. Run `deltix login` first.');
    this.name = 'NoActiveSessionError';
  }
}

export class ServerUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Could not reach Deltix-Server: ${String(cause)}`);
    this.name = 'ServerUnreachableError';
  }
}
