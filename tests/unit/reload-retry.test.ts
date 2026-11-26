import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReloadRetry } from '../../src/tree/ReloadRetry.js';

describe('ReloadRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing until a failure arms it', () => {
    const retry = vi.fn();
    const r = new ReloadRetry(retry);
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
    expect(r.armed).toBe(false);
  });

  it('retries once, 5 s after the failure', () => {
    const retry = vi.fn();
    const r = new ReloadRetry(retry);
    r.arm();
    expect(r.armed).toBe(true);
    vi.advanceTimersByTime(4_999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(r.armed).toBe(false); // armed again only by the next FAILURE
  });

  it('keeps retrying every 5 s while every attempt fails', () => {
    let attempts = 0;
    // each attempt fails → the provider would call arm() again
    const r = new ReloadRetry(() => {
      attempts++;
      r.arm();
    });
    r.arm();
    vi.advanceTimersByTime(5_000 * 10 - 1);
    expect(attempts).toBe(9);
    vi.advanceTimersByTime(1);
    expect(attempts).toBe(10); // exactly one attempt per interval — never a storm
  });

  it('several failures inside one interval share ONE pending attempt', () => {
    const retry = vi.fn();
    const r = new ReloadRetry(retry);
    r.arm();
    vi.advanceTimersByTime(1_000);
    r.arm(); // a UI refresh failed too
    r.arm();
    vi.advanceTimersByTime(4_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a success cancels the pending attempt', () => {
    const retry = vi.fn();
    const r = new ReloadRetry(retry);
    r.arm();
    vi.advanceTimersByTime(2_000);
    r.cancel();
    expect(r.armed).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
    r.cancel(); // idempotent
  });

  it('a failure arriving after a success starts a NEW streak, a full interval later', () => {
    const retry = vi.fn();
    const r = new ReloadRetry(retry);
    r.arm();
    vi.advanceTimersByTime(5_000); // attempt fires
    expect(retry).toHaveBeenCalledTimes(1);
    r.cancel(); // …and succeeds
    r.arm(); // a failure that was computed BEFORE that success arrives late
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(2); // one more attempt, a full interval later — still no storm
  });
});
