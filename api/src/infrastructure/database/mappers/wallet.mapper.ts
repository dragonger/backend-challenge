import { Money } from '../../../domain/money/money.js';
import { Wallet } from '../../../domain/wallet/wallet.js';
import { WalletEntity } from '../entities/wallet.entity.js';

export const WalletMapper = {
  toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({ amount: entity.balance, currency: entity.currency }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  },

  /** Columns for a brand new row. */
  toEntityData(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },

  /** Copies the mutable state of the aggregate to a managed entity. */
  applyToEntity(wallet: Wallet, entity: WalletEntity): void {
    entity.balance = wallet.balance.toJSON().amount;
    entity.version = wallet.version;
    entity.updatedAt = wallet.updatedAt;
  },
};
