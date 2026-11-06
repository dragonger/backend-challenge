import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../errors/domain-error.js';
import { FailureCode } from '../errors/failure-code.js';
import { Money } from '../money/money.js';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * Valid transitions:
 *
 *   PENDING            -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE  -> PENDING_REFERENCE (new attempt) | PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED are terminal: any transition is a programming
 *   error and throws InvalidTransactionStateError.
 */
const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface WagerTransactionIdentity {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id in the provider, not the internal id */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionIdentity,
  'createdAt'
> & { createdAt?: Date };

export interface WagerTransactionState extends WagerTransactionIdentity {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Balance observed right after the transaction was resolved (replay snapshot). */
  balanceAfter?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida a exigencia de referencia por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING is internal and cannot be submitted',
      );
    }

    return WagerTransaction.build(props);
  }

  /** Internal factory for the wallet opening credit. */
  static createOpening(props: CreateWagerTransactionProps): WagerTransaction {
    return WagerTransaction.build({
      ...props,
      kind: WagerTransactionKind.Opening,
      referenceExternalTransactionId: undefined,
    });
  }

  /** Rebuilds a persisted transaction. Does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.attempts,
      state.nextAttemptAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const required: Array<[string, string]> = [
      ['id', props.id],
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['idempotencyKey', props.idempotencyKey],
      ['payloadHash', props.payloadHash],
      ['walletId', props.walletId],
      ['playerId', props.playerId],
      ['roundId', props.roundId],
      ['gameId', props.gameId],
    ];

    for (const [name, value] of required) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new InvalidWagerTransactionError(`${name} is required`);
      }
    }

    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('Amount cannot be negative');
    }

    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError('Amount must be positive');
    }

    const reference = props.referenceExternalTransactionId?.trim();

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !reference
    ) {
      throw new InvalidWagerTransactionError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    if (
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Opening) &&
      props.referenceExternalTransactionId !== undefined
    ) {
      throw new InvalidWagerTransactionError(
        `${props.kind} cannot have a reference`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transitions (throw InvalidTransactionStateError from a terminal state)

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    balanceAfter: Money,
  ): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextAttemptAt = undefined;
  }

  /**
   * Waits for the referenced transaction. `attempts` counts the re-resolution
   * attempts that failed: the first call (from PENDING) leaves it at 0 and
   * every further call, made while already waiting, counts one more.
   */
  markPendingReference(nextAttemptAt: Date, balanceObserved: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);

    if (this._status === WagerTransactionStatus.PendingReference) {
      this._attempts += 1;
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
    this._balanceAfter = balanceObserved;
  }

  reject(code: FailureCode, at: Date, balanceObserved: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._balanceAfter = balanceObserved;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date, balanceObserved?: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._balanceAfter = balanceObserved ?? this._balanceAfter;
    this._nextAttemptAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  isPendingReference(): boolean {
    return this._status === WagerTransactionStatus.PendingReference;
  }

  /** false for LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true for REFUND and ROLLBACK. */
  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the ledger entry this transaction produces.
   * ROLLBACK is the inverse of the direction of the transaction it reverses.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError(
            'ROLLBACK needs the reference to define the direction',
          );
        }

        const original = reference.ledgerDirectionFor();

        return original === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not affect balance');
    }
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }
}
