import { describe, it, expect } from 'vitest';
import { isStale, nowHeldBy } from '../../src/core/repo/coordination.js';

describe('coordination (pure helpers)', () => {
  it('isStale is true beyond the threshold', () => {
    const old = nowHeldBy('cli:1@h', 'cli');
    old.since = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(isStale(old, 5)).toBe(true);
  });

  it('isStale is false when recent', () => {
    expect(isStale(nowHeldBy('cli:1@h', 'cli'), 5)).toBe(false);
  });

  it('nowHeldBy records source, session, host, osUser', () => {
    const hb = nowHeldBy('cli:42@host', 'cli');
    expect(hb.source).toBe('cli');
    expect(hb.session).toBe('cli:42@host');
    expect(hb.host.length).toBeGreaterThan(0);
    expect(hb.osUser.length).toBeGreaterThan(0);
  });
});
