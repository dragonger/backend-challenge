/** Base for errors raised by use cases (mapped to HTTP / queue outcomes later). */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Same idempotency key (or provider transaction id) with a different payload. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player ${playerId} in ${currency}`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

/**
 * Temporary infrastructure problem (lock timeout, deadlock, serialization
 * failure, connection loss). Safe to retry with backoff.
 */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE';

  constructor(
    message: string,
    public readonly sqlState?: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`Transaction ${reference} not found`);
  }
}

/** Malformed pagination cursor (client error). */
export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('Invalid cursor');
  }
}
