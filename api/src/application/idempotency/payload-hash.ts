import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../domain/money/money.js';
import { canonicalJson } from './canonical-json.js';

/** Business fields that identify a wagering operation. */
export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** Normalized (scale 2) money. */
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = hex(SHA-256(canonicalJson(business fields))).
 *
 * Only business fields take part: the idempotency key, transport headers,
 * message ids and timestamps never do. `referenceExternalTransactionId` is
 * included only when present. Money is serialized as { amount, currency }
 * with the amount as a scale-2 string.
 */
export function computePayloadHash(input: PayloadHashInput): string {
  const business = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    ...(input.referenceExternalTransactionId
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
  };

  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}
