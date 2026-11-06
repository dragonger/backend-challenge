import type { FailureCode } from '../../domain/errors/failure-code.js';
import type { MoneyProps } from '../../domain/money/money.js';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';

/**
 * aggregateId is always the walletId: the wallet is the unit of concurrency and
 * of ordering (it can be used as the FIFO MessageGroupId when publishing).
 */

export interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  /** Balance observed when the transaction was resolved. */
  balance: MoneyProps;
  referenceExternalTransactionId?: string;
}

const baseData = (tx: WagerTransaction): WagerTransactionEventData => {
  if (!tx.balanceAfter) {
    throw new Error('Transaction has no balance snapshot');
  }

  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    balance: tx.balanceAfter.toJSON(),
    ...(tx.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
};

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: baseData(tx),
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) {
      throw new Error('Rejected transaction has no failure code');
    }

    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...baseData(tx), failureCode: tx.failureCode },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: baseData(tx),
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
