/**
 * Base class for every error raised by the pure domain layer.
 * `code` is a stable machine-readable identifier.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor() {
    super('Currency mismatch');
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';

  constructor() {
    super('Amount must be positive');
  }
}

export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';

  constructor() {
    super('Insufficient balance');
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

/** Programming error: tried to transition a transaction out of a terminal state. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(from: string, to: string) {
    super(`Invalid transaction state transition: ${from} -> ${to}`);
  }
}
