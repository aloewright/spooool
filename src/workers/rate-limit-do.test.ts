import { describe, expect, it } from 'vitest';
import { computeTake } from './rate-limit-do';

describe('computeTake — token bucket math', () => {
  it('starts the bucket full when there is no prior state', () => {
    const { result, nextState } = computeTake(null, 10, 1, 1, 1_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
    expect(result.retryAfterMs).toBe(0);
    expect(nextState.tokens).toBe(9);
    expect(nextState.lastRefillMs).toBe(1_000);
  });

  it('refills proportionally to elapsed time', () => {
    // Bucket at 0 tokens, refill 1/sec, 5s later → 5 tokens available.
    const prior = { tokens: 0, lastRefillMs: 0 };
    const { result, nextState } = computeTake(prior, 10, 1, 1, 5_000);
    expect(result.allowed).toBe(true);
    expect(nextState.tokens).toBeCloseTo(4, 5);
  });

  it('caps refill at capacity', () => {
    const prior = { tokens: 5, lastRefillMs: 0 };
    // Long elapsed window — should not exceed capacity.
    const { result, nextState } = computeTake(prior, 10, 1, 1, 1_000_000);
    expect(result.allowed).toBe(true);
    expect(nextState.tokens).toBe(9);
  });

  it('denies when tokens insufficient and reports a positive retryAfterMs', () => {
    const prior = { tokens: 0, lastRefillMs: 0 };
    // No time passed → still 0 tokens → can't take 1.
    const { result, nextState } = computeTake(prior, 10, 1, 1, 0);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(1_000);
    // Tokens stay at 0; lastRefillMs advances so future calls compute the
    // right elapsed window.
    expect(nextState.tokens).toBe(0);
    expect(nextState.lastRefillMs).toBe(0);
  });

  it('does not consume tokens on a denied take', () => {
    const prior = { tokens: 0.4, lastRefillMs: 0 };
    const { nextState } = computeTake(prior, 10, 1, 1, 0);
    expect(nextState.tokens).toBeCloseTo(0.4, 5);
  });

  it('accepts a partial refill that crosses the cost threshold', () => {
    // 0.5 tokens stored, 1/sec refill, 700ms elapsed → 1.2 tokens, take 1.
    const prior = { tokens: 0.5, lastRefillMs: 0 };
    const { result, nextState } = computeTake(prior, 10, 1, 1, 700);
    expect(result.allowed).toBe(true);
    expect(nextState.tokens).toBeCloseTo(0.2, 5);
  });

  it('handles fractional refill rates (5 tokens / 5min)', () => {
    // 5/300 ≈ 0.0167 tokens per second. Bucket starts empty; need 60s for 1 token.
    const prior = { tokens: 0, lastRefillMs: 0 };
    const { result } = computeTake(prior, 5, 5 / 300, 1, 60_000);
    expect(result.allowed).toBe(true);
  });

  it('handles cost > 1', () => {
    const prior = { tokens: 5, lastRefillMs: 0 };
    const { result, nextState } = computeTake(prior, 10, 1, 3, 0);
    expect(result.allowed).toBe(true);
    expect(nextState.tokens).toBe(2);
  });

  it('denies when cost > capacity even for a fresh bucket', () => {
    const { result } = computeTake(null, 10, 1, 11, 0);
    expect(result.allowed).toBe(false);
  });

  it('resetMs reflects time-to-full', () => {
    // Take from a fresh bucket of 10 with refill 1/sec → 9 left → 1s to refill.
    const { result } = computeTake(null, 10, 1, 1, 0);
    expect(result.resetMs).toBe(1_000);
  });

  it('clamps elapsed to 0 if clock goes backwards', () => {
    const prior = { tokens: 5, lastRefillMs: 10_000 };
    const { result, nextState } = computeTake(prior, 10, 1, 1, 5_000);
    // Elapsed clamped to 0 → no refill, just decrement.
    expect(result.allowed).toBe(true);
    expect(nextState.tokens).toBe(4);
  });
});
