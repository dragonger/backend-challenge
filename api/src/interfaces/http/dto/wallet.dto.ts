import { z } from 'zod';

import {
  DEFAULT_LEDGER_PAGE_SIZE,
  MAX_LEDGER_PAGE_SIZE,
} from '../../../application/wallet/list-ledger.usecase.js';
import { moneySchema, uuidSchema } from './common.js';

export const createWalletSchema = z.strictObject({
  playerId: uuidSchema,
  initialBalance: moneySchema,
});

export type CreateWalletDto = z.output<typeof createWalletSchema>;

/**
 * Query string values are always strings; `limit` is parsed explicitly (digits
 * only) instead of using implicit coercion. Out-of-range values are rejected,
 * not clamped, so a client never silently gets a different page size.
 */
export const ledgerQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(100).optional(),
  limit: z
    .string()
    .regex(/^\d{1,4}$/, 'limit must be a positive integer')
    .transform(Number)
    .refine(
      (value) => value >= 1 && value <= MAX_LEDGER_PAGE_SIZE,
      `limit must be between 1 and ${MAX_LEDGER_PAGE_SIZE}`,
    )
    .default(DEFAULT_LEDGER_PAGE_SIZE),
});

export type LedgerQueryDto = z.output<typeof ledgerQuerySchema>;
