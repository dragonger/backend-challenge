import type {
  KindHandler,
  KindHandlerContext,
  KindHandlerOutcome,
} from './handler.js';
import { resolveReference } from './reference-flow.js';

/**
 * WIN: credit. The reference is optional; when informed it must be a
 * PROCESSED BET of the same round (a WIN without BET is accepted).
 */
export class WinHandler implements KindHandler {
  async handle(context: KindHandlerContext): Promise<KindHandlerOutcome> {
    const step = await resolveReference(context);

    if (step.settled) {
      return {};
    }

    const { transaction, wallet, now, newId } = context;

    const ledgerEntry = wallet.credit({
      entryId: newId(),
      transactionId: transaction.id,
      money: transaction.money,
      at: now,
    });

    transaction.markProcessed(step.reference?.id, now, wallet.balance);

    return { ledgerEntry };
  }
}
