import type {
  KindHandler,
  KindHandlerContext,
  KindHandlerOutcome,
} from './handler.js';
import { resolveReference } from './reference-flow.js';

/**
 * LOSS: records the outcome without touching the balance (no ledger entry).
 * Same optional reference rule as WIN.
 */
export class LossHandler implements KindHandler {
  async handle(context: KindHandlerContext): Promise<KindHandlerOutcome> {
    const step = await resolveReference(context);

    if (step.settled) {
      return {};
    }

    const { transaction, wallet, now } = context;
    transaction.markProcessed(step.reference?.id, now, wallet.balance);

    return {};
  }
}
