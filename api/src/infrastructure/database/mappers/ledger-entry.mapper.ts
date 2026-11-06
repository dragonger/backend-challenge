import { Money } from '../../../domain/money/money.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';

export const LedgerEntryMapper = {
  toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    const currency = entity.currency;

    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction,
      money: Money.from({ amount: entity.amount, currency }),
      balanceBefore: Money.from({ amount: entity.balanceBefore, currency }),
      balanceAfter: Money.from({ amount: entity.balanceAfter, currency }),
      createdAt: entity.createdAt,
    });
  },

  toEntityData(entry: WalletLedgerEntry) {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    };
  },
};
