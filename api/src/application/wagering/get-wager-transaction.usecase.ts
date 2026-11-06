import { Injectable } from '@nestjs/common';

import type { FailureCode } from '../../domain/errors/failure-code.js';
import type { MoneyProps } from '../../domain/money/money.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';
import { WagerTransactionMapper } from '../../infrastructure/database/mappers/wager-transaction.mapper.js';
import { TransactionRunner } from '../../infrastructure/database/transaction-runner.js';
import { WagerTransactionNotFoundError } from '../errors.js';

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  /** Balance observed when the transaction was resolved (null while pending). */
  balance?: MoneyProps;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  processedAt?: string;
}

/** Read side: finds a transaction by internal id or by provider identity. */
@Injectable()
export class GetWagerTransaction {
  constructor(private readonly runner: TransactionRunner) {}

  byId(transactionId: string): Promise<WagerTransactionView> {
    return this.find({ id: transactionId }, transactionId);
  }

  byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.find(
      { providerId, externalTransactionId },
      `${providerId}/${externalTransactionId}`,
    );
  }

  private find(
    where: { id: string } | { providerId: string; externalTransactionId: string },
    label: string,
  ): Promise<WagerTransactionView> {
    return this.runner.read(async (em) => {
      const entity = await em.findOne(WagerTransactionEntity, where);

      if (!entity) {
        throw new WagerTransactionNotFoundError(label);
      }

      const tx = WagerTransactionMapper.toDomain(entity);

      return {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        status: tx.status,
        ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
        ...(tx.referenceExternalTransactionId !== undefined
          ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
          : {}),
        ...(tx.referenceTransactionId
          ? { referenceTransactionId: tx.referenceTransactionId }
          : {}),
        ...(tx.balanceAfter ? { balance: tx.balanceAfter.toJSON() } : {}),
        attempts: tx.attempts,
        ...(tx.nextAttemptAt ? { nextAttemptAt: tx.nextAttemptAt.toISOString() } : {}),
        createdAt: tx.createdAt.toISOString(),
        ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
      };
    });
  }
}
