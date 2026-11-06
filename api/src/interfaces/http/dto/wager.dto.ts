import { z } from 'zod';

import { moneySchema, textSchema, uuidSchema } from './common.js';

/** OPENING is internal and is intentionally not part of the enum. */
export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export const submitTransactionSchema = z.strictObject({
  providerId: textSchema(100),
  externalTransactionId: textSchema(150),
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: textSchema(150),
  gameId: textSchema(150),
  kind: z.enum(SUBMITTABLE_KINDS),
  money: moneySchema,
  referenceExternalTransactionId: textSchema(150).optional(),
});

export type SubmitTransactionDto = z.output<typeof submitTransactionSchema>;

export const providerIdParamSchema = textSchema(100);
export const externalTransactionIdParamSchema = textSchema(150);
