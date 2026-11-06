import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { currentContext, runWithContext, type LogContext } from './request-context.js';

const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The caller's X-Correlation-Id when well formed, otherwise a fresh UUID. */
export function correlationIdOf(header: string | string[] | undefined): string {
  return typeof header === 'string' && CORRELATION_PATTERN.test(header) ? header : randomUUID();
}

/** Request carrying the context object so the access log can read it back. */
export type ContextualRequest = Request & { logContext?: LogContext };

/**
 * Opens the AsyncLocalStorage scope of a request. The correlation id is
 * correlationIdOf(X-Correlation-Id) (or the id pino-http already assigned). Use
 * cases add walletId / providerId / transactionId as they learn them.
 */
export function contextMiddleware(
  request: ContextualRequest,
  _response: Response,
  next: NextFunction,
): void {
  // pino-http (when present) already generated request.id from the same rule.
  const existing = (request as Request & { id?: unknown }).id;
  const correlationId =
    typeof existing === 'string' && CORRELATION_PATTERN.test(existing)
      ? existing
      : correlationIdOf(request.headers['x-correlation-id']);

  runWithContext({ correlationId }, () => {
    request.logContext = currentContext();
    next();
  });
}
