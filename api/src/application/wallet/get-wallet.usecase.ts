import { Injectable } from '@nestjs/common';

import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity.js';
import { WalletMapper } from '../../infrastructure/database/mappers/wallet.mapper.js';
import { TransactionRunner } from '../../infrastructure/database/transaction-runner.js';
import { WalletNotFoundError } from '../errors.js';
import type { OpenWalletResult } from '../wagering/commands.js';

/** Current state of a wallet (same shape as the creation answer). */
@Injectable()
export class GetWallet {
  constructor(private readonly runner: TransactionRunner) {}

  execute(walletId: string): Promise<OpenWalletResult> {
    return this.runner.read(async (em) => {
      const entity = await em.findOne(WalletEntity, { id: walletId });

      if (!entity) {
        throw new WalletNotFoundError(walletId);
      }

      const wallet = WalletMapper.toDomain(entity);

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
