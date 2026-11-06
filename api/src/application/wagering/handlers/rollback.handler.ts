import type {
  KindHandler,
  KindHandlerContext,
  KindHandlerOutcome,
} from './handler.js';
import { applyReversal } from './reversal.js';

/**
 * ROLLBACK: applies the inverse of a PROCESSED BET (credit), WIN or REFUND
 * (debit), once.
 */
export class RollbackHandler implements KindHandler {
  handle(context: KindHandlerContext): Promise<KindHandlerOutcome> {
    return applyReversal(context);
  }
}
