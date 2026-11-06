import type { FailureCode } from '../../../domain/errors/failure-code.js';
import { Money } from '../../../domain/money/money.js';
import { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';

export const WagerTransactionMapper = {
  toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,
      createdAt: entity.createdAt,
      status: entity.status,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode: (entity.failureCode ?? undefined) as FailureCode | undefined,
      processedAt: entity.processedAt ?? undefined,
      balanceAfter:
        entity.balanceAfter === null || entity.balanceAfter === undefined
          ? undefined
          : Money.from({
              amount: entity.balanceAfter,
              currency: entity.currency,
            }),
      attempts: entity.attempts,
      nextAttemptAt: entity.nextAttemptAt ?? undefined,
    });
  },

  /** Columns for a new row, with the full current state of the aggregate. */
  toEntityData(tx: WagerTransaction) {
    const money = tx.money.toJSON();

    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: money.amount,
      currency: money.currency,
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt,
      balanceAfter: tx.balanceAfter?.toJSON().amount,
      attempts: tx.attempts,
      nextAttemptAt: tx.nextAttemptAt,
    };
  },

  /** Updates a managed entity with the state reached by the aggregate. */
  applyToEntity(tx: WagerTransaction, entity: WagerTransactionEntity): void {
    entity.status = tx.status;
    entity.referenceTransactionId = tx.referenceTransactionId;
    entity.failureCode = tx.failureCode;
    entity.processedAt = tx.processedAt;
    entity.balanceAfter = tx.balanceAfter?.toJSON().amount;
    entity.attempts = tx.attempts;
    entity.nextAttemptAt = tx.nextAttemptAt;
  },
};
