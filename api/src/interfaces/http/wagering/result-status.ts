import type { ProcessWagerTransactionResult } from '../../../application/wagering/commands.js';
import { WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.js';

/**
 * HTTP status of POST /wagering/transactions (the other error codes come from
 * the exception filter):
 *
 *   result                         first time   replay (idempotentReplay)
 *   PROCESSED                      201          200
 *   REJECTED (business rule)       422          422  (same code as the original)
 *   PENDING_REFERENCE              202          202
 *   FAILED (permanent tech error)  500          500
 */
export function statusForResult(result: ProcessWagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}
