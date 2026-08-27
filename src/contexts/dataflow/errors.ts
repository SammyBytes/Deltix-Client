export class TicketAuthenticationError extends Error {
  constructor() {
    super('Not authenticated. Run `deltix login` first.');
    this.name = 'TicketAuthenticationError';
  }
}

export class TicketIssuanceError extends Error {
  constructor(status: number) {
    super(`Server rejected the ticket request (HTTP ${status})`);
    this.name = 'TicketIssuanceError';
  }
}

export class TicketNotFoundOrInactiveError extends Error {
  constructor() {
    super('Ticket not found or not active');
    this.name = 'TicketNotFoundOrInactiveError';
  }
}

export class TransferAbortedError extends Error {
  constructor(reason: string) {
    super(`Transfer aborted: ${reason}`);
    this.name = 'TransferAbortedError';
  }
}

export class LocalFileNotFoundError extends Error {
  constructor(path: string) {
    super(`Local file not found: ${path}`);
    this.name = 'LocalFileNotFoundError';
  }
}

export class ChecksumMismatchError extends Error {
  constructor() {
    super('Checksum mismatch after transfer — data integrity could not be verified');
    this.name = 'ChecksumMismatchError';
  }
}
