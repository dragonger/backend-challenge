import { describe, expect, test } from 'bun:test';
import { PendingReferencePolicy } from './pending-reference.policy.js';

const config = {
  initialBackoffMs: 1000,
  maxBackoffMs: 10_000,
  maxAttempts: 5,
  ttlMs: 60_000,
  jitterRatio: 0.2,
};
const t0 = new Date('2026-01-01T00:00:00.000Z');

describe('PendingReferencePolicy', () => {
  test('doubles the delay and stops at the ceiling (no jitter at random=0.5)', () => {
    const policy = new PendingReferencePolicy(config, () => 0.5);

    expect([0, 1, 2, 3, 4, 5].map((n) => policy.backoffMs(n))).toEqual([
      1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });

  test('jitter stays inside +/- ratio', () => {
    const low = new PendingReferencePolicy(config, () => 0);
    const high = new PendingReferencePolicy(config, () => 1);

    expect(low.backoffMs(1)).toBe(1600);
    expect(high.backoffMs(1)).toBe(2400);
  });

  test('nextAttemptAt adds the delay to now', () => {
    const policy = new PendingReferencePolicy(config, () => 0.5);

    expect(policy.nextAttemptAt(0, t0).getTime()).toBe(t0.getTime() + 1000);
  });

  test('exhausted by attempts OR by TTL, whichever comes first', () => {
    const policy = new PendingReferencePolicy(config, () => 0.5);
    const early = new Date(t0.getTime() + 1000);

    expect(policy.isExhausted(4, t0, early)).toBe(false);
    expect(policy.isExhausted(5, t0, early)).toBe(true);
    expect(policy.isExhausted(1, t0, new Date(t0.getTime() + 59_999))).toBe(false);
    expect(policy.isExhausted(1, t0, new Date(t0.getTime() + 60_000))).toBe(true);
  });
});
