import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '../../application/idempotency/canonical-json.js';
import type { ProcessWagerTransactionCommand } from '../../application/wagering/commands.js';
import { moneySchema, textSchema, uuidSchema } from '../http/dto/common.js';
import { SUBMITTABLE_KINDS } from '../http/dto/wager.dto.js';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';
/** Fixed inbox namespace of this consumer: the dedup key is (consumerName, messageId). */
export const CONSUMER_NAME = 'wager-transaction-consumer';

/** Stable reasons stored on the DLQ message and used as the metric label. */
export type PermanentFailureReason =
  | 'MALFORMED_JSON'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'INVALID_SCHEMA'
  | 'INVALID_COMMAND';

/** The message can never succeed: redelivering it is pointless. */
export class PermanentMessageError extends Error {
  constructor(
    readonly reason: PermanentFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

/** README section 10: the body of `wager-transactions.fifo`. */
export const wagerMessageSchema = z.object({
  messageId: textSchema(255),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.iso.datetime(),
  data: z.strictObject({
    providerId: textSchema(100),
    externalTransactionId: textSchema(150),
    idempotencyKey: textSchema(255),
    playerId: uuidSchema,
    walletId: uuidSchema,
    roundId: textSchema(150),
    gameId: textSchema(150),
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: textSchema(150).optional(),
  }),
});

export type WagerMessage = z.output<typeof wagerMessageSchema>;

export interface ParsedWagerMessage {
  message: WagerMessage;
  /** SHA-256 (hex) of the canonical JSON of the whole body. */
  payloadHash: string;
}

/** Parses and validates a queue body; throws PermanentMessageError. */
export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  let raw: unknown;

  try {
    raw = JSON.parse(body ?? '');
  } catch {
    throw new PermanentMessageError('MALFORMED_JSON', 'Body is not valid JSON');
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PermanentMessageError('MALFORMED_JSON', 'Body is not a JSON object');
  }

  const type = (raw as { type?: unknown }).type;

  if (typeof type === 'string' && type !== WAGER_MESSAGE_TYPE) {
    throw new PermanentMessageError('UNKNOWN_MESSAGE_TYPE', `Unknown type ${type.slice(0, 80)}`);
  }

  const parsed = wagerMessageSchema.safeParse(raw);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'body';

    throw new PermanentMessageError('INVALID_SCHEMA', `${where}: ${issue?.message ?? 'invalid'}`);
  }

  return {
    message: parsed.data,
    payloadHash: createHash('sha256').update(canonicalJson(raw)).digest('hex'),
  };
}

/** The same command the HTTP controller builds, plus the inbox identity. */
export function toCommand({
  message,
  payloadHash,
}: ParsedWagerMessage): ProcessWagerTransactionCommand {
  return {
    ...message.data,
    correlationId: message.messageId,
    causationId: message.messageId,
    inbox: { consumerName: CONSUMER_NAME, messageId: message.messageId, payloadHash },
  };
}
