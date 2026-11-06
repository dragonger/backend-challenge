import { z } from 'zod';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same permissive 8-4-4-4-12 shape the use cases accept. */
export const uuidSchema = z.string().regex(UUID_PATTERN, 'must be a UUID');

/** Non-blank text with a length limit (matches the column sizes). */
export const textSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, 'must not be blank');

/**
 * Money on the wire: decimal STRING plus ISO-4217 code. The amount format
 * itself (scale, sign, notation) is enforced by Money.from in the domain.
 */
export const moneySchema = z.strictObject({
  amount: z.string().min(1).max(40),
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter uppercase code'),
});

export const walletIdParamSchema = uuidSchema;
export const transactionIdParamSchema = uuidSchema;

export const idempotencyKeySchema = z
  .string({ error: 'Idempotency-Key header is required' })
  .min(1, 'Idempotency-Key header must not be empty')
  .max(255, 'Idempotency-Key header must have at most 255 characters')
  .refine((value) => value.trim().length > 0, 'Idempotency-Key must not be blank');

/** Optional trace id from the caller; restricted charset (it ends up in logs). */
export const correlationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'X-Correlation-Id has an invalid format')
  .optional();
