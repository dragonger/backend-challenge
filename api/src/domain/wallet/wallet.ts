import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidAmountError,
  InvalidWalletError,
} from '../errors/domain-error.js';
import { Money } from '../money/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export { InsufficientBalanceError };

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  /** Id of the ledger entry that will be generated. */
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. `debit` and `credit` change the balance and return the
 * ledger entry that describes the change, so balance and ledger cannot diverge
 * by construction. `version` starts at 1 and only increments when the balance
 * changes.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (!props.id.trim()) {
      throw new InvalidWalletError('Wallet ID is required');
    }

    if (!props.playerId.trim()) {
      throw new InvalidWalletError('Player ID is required');
    }

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('Initial balance cannot be negative');
    }

    const now = props.now ?? new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Rebuilds a persisted wallet. Does not validate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);

    if (!this.canDebit(movement.money)) {
      throw new InsufficientBalanceError();
    }

    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);

    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(
    direction: LedgerDirection,
    movement: WalletMovement,
  ): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit
        ? before.add(movement.money)
        : before.subtract(movement.money);

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;

    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);

    if (!money.isPositive()) {
      throw new InvalidAmountError();
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
