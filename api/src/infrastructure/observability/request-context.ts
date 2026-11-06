import { AsyncLocalStorage } from 'node:async_hooks';

/** Identifiers that accompany every log line of a request or a message. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `work` inside a fresh context (one per HTTP request / SQS message). */
export function runWithContext<T>(initial: LogContext, work: () => T): T {
  return storage.run({ ...initial }, work);
}

export function currentContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Adds identifiers to the current context (no-op outside one). Undefined
 * values are ignored so callers can pass optional fields freely.
 */
export function bindContext(extra: LogContext): void {
  const store = storage.getStore();

  if (!store) {
    return;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      (store as Record<string, string>)[key] = value as string;
    }
  }
}
