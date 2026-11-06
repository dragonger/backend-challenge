import { intFromEnv } from '../../config/env.js';

export const PENDING_REFERENCE_CONFIG = Symbol('PENDING_REFERENCE_CONFIG');

export interface PendingReferenceConfig {
  /** Delay before the first re-resolution attempt. */
  initialBackoffMs: number;
  /** Ceiling of the exponential delay. */
  maxBackoffMs: number;
  /** Failed re-resolution attempts before giving up. */
  maxAttempts: number;
  /** Time since created_at before giving up. */
  ttlMs: number;
  /** Random spread applied to each delay, 0.2 = +/-20%. */
  jitterRatio: number;
}

export const DEFAULT_PENDING_REFERENCE_CONFIG: PendingReferenceConfig = {
  initialBackoffMs: 1000,
  maxBackoffMs: 60_000,
  maxAttempts: 10,
  ttlMs: 15 * 60 * 1000,
  jitterRatio: 0.2,
};

export const pendingReferenceConfigFromEnv = (): PendingReferenceConfig => ({
  initialBackoffMs: intFromEnv(
    'PENDING_REFERENCE_INITIAL_BACKOFF_MS',
    DEFAULT_PENDING_REFERENCE_CONFIG.initialBackoffMs,
  ),
  maxBackoffMs: intFromEnv(
    'PENDING_REFERENCE_MAX_BACKOFF_MS',
    DEFAULT_PENDING_REFERENCE_CONFIG.maxBackoffMs,
  ),
  maxAttempts: intFromEnv(
    'PENDING_REFERENCE_MAX_ATTEMPTS',
    DEFAULT_PENDING_REFERENCE_CONFIG.maxAttempts,
  ),
  ttlMs: intFromEnv(
    'PENDING_REFERENCE_TTL_MS',
    DEFAULT_PENDING_REFERENCE_CONFIG.ttlMs,
  ),
  jitterRatio: DEFAULT_PENDING_REFERENCE_CONFIG.jitterRatio,
});

/**
 * Retry schedule of PENDING_REFERENCE transactions: exponential backoff with a
 * ceiling and jitter (so many pending rows do not retry in lockstep).
 *
 * A transaction gives up when EITHER limit is reached, whichever comes first:
 * `maxAttempts` failed re-resolutions or `ttlMs` since it was created. Both
 * bounds keep the pending set finite even if the worker is slow or fast.
 */
export class PendingReferencePolicy {
  constructor(
    private readonly config: PendingReferenceConfig = DEFAULT_PENDING_REFERENCE_CONFIG,
    private readonly random: () => number = Math.random,
  ) {}

  /** Delay before attempt number `attempt` (0 = first re-resolution). */
  backoffMs(attempt: number): number {
    const exponential = Math.min(
      this.config.maxBackoffMs,
      this.config.initialBackoffMs * 2 ** Math.min(attempt, 30),
    );
    const spread = (this.random() * 2 - 1) * this.config.jitterRatio;

    return Math.max(1, Math.round(exponential * (1 + spread)));
  }

  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + this.backoffMs(attempt));
  }

  /** `failedAttempts` already includes the attempt that just failed. */
  isExhausted(failedAttempts: number, createdAt: Date, now: Date): boolean {
    return (
      failedAttempts >= this.config.maxAttempts ||
      now.getTime() - createdAt.getTime() >= this.config.ttlMs
    );
  }
}
