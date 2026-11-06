import { FailureCode } from '../../../domain/errors/failure-code.js';
import type {
  KindHandler,
  KindHandlerContext,
  KindHandlerOutcome,
} from './handler.js';

/** BET: debit, rejected when the balance is not enough. */
export class BetHandler implements KindHandler {
  handle({
    transaction,
    wallet,
    now,
    newId,
  }: KindHandlerContext): Promise<KindHandlerOutcome> {
    if (!wallet.canDebit(transaction.money)) {
      transaction.reject(FailureCode.InsufficientBalance, now, wallet.balance);
      return Promise.resolve({});
    }

    const ledgerEntry = wallet.debit({
      entryId: newId(),
      transactionId: transaction.id,
      money: transaction.money,
      at: now,
    });

    transaction.markProcessed(undefined, now, wallet.balance);

    return Promise.resolve({ ledgerEntry });
  }
}
