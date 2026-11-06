import type {
  KindHandler,
  KindHandlerContext,
  KindHandlerOutcome,
} from './handler.js';
import { applyReversal } from './reversal.js';

/** REFUND: credit that reverts a PROCESSED BET, once. */
export class RefundHandler implements KindHandler {
  handle(context: KindHandlerContext): Promise<KindHandlerOutcome> {
    return applyReversal(context);
  }
}
