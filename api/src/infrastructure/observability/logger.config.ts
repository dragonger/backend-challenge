import type { Params } from 'nestjs-pino';

import { stringFromEnv } from '../../config/env.js';
import { correlationIdOf } from './context.middleware.js';
import { currentContext } from './request-context.js';

/**
 * Structured JSON logs (pino). Every line carries the AsyncLocalStorage
 * context (correlationId, messageId, transactionId, walletId, providerId).
 * Request/response bodies are never logged; auth headers and any money-like
 * field are redacted as a second line of defence.
 */
export function loggerParams(): Params {
  const level = stringFromEnv('LOG_LEVEL', process.env.NODE_ENV === 'test' ? 'silent' : 'info');

  return {
    pinoHttp: {
      level,
      mixin: () => ({ ...currentContext() }),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'money',
          '*.money',
          'balance',
          '*.balance',
          'payload',
          '*.payload',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req: (req: { id?: string; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      // pino-http runs before contextMiddleware, so the request id chosen here
      // (caller's X-Correlation-Id or a UUID) becomes the correlationId.
      genReqId: (request) => correlationIdOf(request.headers['x-correlation-id']),
      autoLogging: {
        ignore: (request) => {
          const url = request.url ?? '';
          return url.startsWith('/metrics') || url.startsWith('/health/live');
        },
      },
      quietReqLogger: true,
    },
  };
}
