import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction.js';
import { BetHandler } from './handlers/bet.handler.js';
import type { KindHandler } from './handlers/handler.js';
import { LossHandler } from './handlers/loss.handler.js';
import { RefundHandler } from './handlers/refund.handler.js';
import { RollbackHandler } from './handlers/rollback.handler.js';
import { WinHandler } from './handlers/win.handler.js';

export type {
  KindHandler,
  KindHandlerContext,
  KindHandlerOutcome,
  ReferenceLookup,
} from './handlers/handler.js';

export type KindHandlers = Record<
  Exclude<WagerTransactionKind, WagerTransactionKind.Opening>,
  KindHandler
>;

export function createKindHandlers(): KindHandlers {
  return {
    [WagerTransactionKind.Bet]: new BetHandler(),
    [WagerTransactionKind.Win]: new WinHandler(),
    [WagerTransactionKind.Loss]: new LossHandler(),
    [WagerTransactionKind.Refund]: new RefundHandler(),
    [WagerTransactionKind.Rollback]: new RollbackHandler(),
  };
}
