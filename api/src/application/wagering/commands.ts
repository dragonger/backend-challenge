import type { FailureCode } from '../../domain/errors/failure-code.js';
import type { MoneyProps } from '../../domain/money/money.js';
import type { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction.js';

/** Present only when the command arrived through a queue (inbox dedup). */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  /** Hash of the queue message payload; a redelivery must carry the same one. */
  payloadHash: string;
}

/** Channel independent command (HTTP and SQS build the same object). */
export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  /** BET | WIN | LOSS | REFUND | ROLLBACK (OPENING is internal). */
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  causationId?: string;
  inbox?: InboxContext;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the transaction was resolved. */
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  /** Optional, mostly for tests. Generated when omitted. */
  walletId?: string;
  correlationId?: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}
