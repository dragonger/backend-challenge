import { HttpException } from '@nestjs/common';

import {
  IdempotencyConflictError,
  InvalidCursorError,
  TransientInfrastructureError,
  WagerTransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../application/errors.js';
import {
  DomainError,
  InvalidTransactionStateError,
} from '../../../domain/errors/domain-error.js';
import { toTransientIfNeeded } from '../../../infrastructure/database/transient-errors.js';
import { RequestValidationError } from '../validation/zod.pipe.js';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    failureCode?: string;
    details?: unknown;
  };
}

export interface HttpErrorResponse {
  status: number;
  body: ErrorBody;
  /** Seconds, sent as Retry-After for retryable failures. */
  retryAfterSeconds?: number;
  /** True for unexpected errors that must be logged with their stack. */
  unexpected?: boolean;
}

const body = (code: string, message: string, details?: unknown): ErrorBody => ({
  error: { code, message, ...(details !== undefined ? { details } : {}) },
});

const HTTP_CODE_NAMES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/**
 * Single place that turns any thrown value into an HTTP answer, so every
 * endpoint answers errors the same way and no known error leaks as a 500.
 *
 *  400 invalid payload / domain validation   409 idempotency or duplicate wallet
 *  404 wallet / transaction not found        503 transient infrastructure failure
 *  anything else                             500 (generic message, logged)
 */
export function mapExceptionToHttp(exception: unknown): HttpErrorResponse {
  if (exception instanceof RequestValidationError) {
    return { status: 400, body: body(exception.code, exception.message, exception.issues) };
  }

  if (exception instanceof InvalidCursorError) {
    return { status: 400, body: body(exception.code, exception.message) };
  }

  if (exception instanceof IdempotencyConflictError) {
    return { status: 409, body: body(exception.code, exception.message) };
  }

  if (exception instanceof WalletAlreadyExistsError) {
    return { status: 409, body: body(exception.code, exception.message) };
  }

  if (
    exception instanceof WalletNotFoundError ||
    exception instanceof WagerTransactionNotFoundError
  ) {
    return { status: 404, body: body(exception.code, exception.message) };
  }

  if (exception instanceof InvalidTransactionStateError) {
    // Programming error, not a client error.
    return {
      status: 500,
      body: body('INTERNAL_ERROR', 'Internal server error'),
      unexpected: true,
    };
  }

  if (exception instanceof DomainError) {
    return { status: 400, body: body(exception.code, exception.message) };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      status,
      body: body(HTTP_CODE_NAMES[status] ?? 'HTTP_ERROR', exception.message),
      ...(status >= 500 ? { unexpected: true } : {}),
    };
  }

  // body-parser (invalid JSON, payload too large) throws plain errors that
  // carry an HTTP status and are safe to expose.
  const parserError = exception as { status?: unknown; expose?: unknown; type?: unknown };

  if (
    typeof parserError?.status === 'number' &&
    parserError.status >= 400 &&
    parserError.status < 500 &&
    parserError.expose === true
  ) {
    return {
      status: parserError.status,
      body: body(
        parserError.type === 'entity.parse.failed'
          ? 'INVALID_JSON'
          : (HTTP_CODE_NAMES[parserError.status] ?? 'BAD_REQUEST'),
        parserError.type === 'entity.parse.failed'
          ? 'Request body is not valid JSON'
          : 'Invalid request',
      ),
    };
  }

  const classified = toTransientIfNeeded(exception);

  if (classified instanceof TransientInfrastructureError) {
    return {
      status: 503,
      body: body(classified.code, 'Temporary failure, retry later'),
      retryAfterSeconds: 1,
    };
  }

  return {
    status: 500,
    body: body('INTERNAL_ERROR', 'Internal server error'),
    unexpected: true,
  };
}
