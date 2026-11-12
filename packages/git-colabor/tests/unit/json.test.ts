import { describe, it, expect } from 'vitest';
import { ok, failFromError } from '../../src/cli/json.js';
import { Errors } from '../../src/core/errors.js';

describe('json envelope', () => {
  it('ok without warnings omits warnings', () => {
    const r = ok({ a: 1 });
    expect(r.ok).toBe(true);
    expect((r as { data: unknown }).data).toEqual({ a: 1 });
    expect((r as { warnings?: unknown }).warnings).toBeUndefined();
  });

  it('ok with warnings keeps them', () => {
    const r = ok({ a: 1 }, [{ code: 'x', message: 'm' }]);
    expect(r.ok).toBe(true);
    expect((r as { warnings?: unknown[] }).warnings?.length).toBe(1);
  });

  it('failFromError maps an AppError to its exitCode', () => {
    const r = failFromError(Errors.authorNotFound('zz'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('AUTHOR_NOT_FOUND');
      expect(r.error.exitCode).toBe(5);
    }
  });

  it('failFromError wraps unknown errors as INTERNAL', () => {
    const r = failFromError(new Error('boom'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INTERNAL');
      expect(r.error.exitCode).toBe(1);
    }
  });
});
