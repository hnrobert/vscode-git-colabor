import { describe, it, expect } from 'vitest';
import { keyFileName, keyFilePath, mapPath } from '../../src/core/paths.js';

describe('paths', () => {
  it('mapPath honors GIT_COLABOR_MAP', () => {
    const prev = process.env.GIT_COLABOR_MAP;
    process.env.GIT_COLABOR_MAP = '/tmp/foo/identities.json';
    try {
      expect(mapPath()).toBe('/tmp/foo/identities.json');
    } finally {
      if (prev === undefined) delete process.env.GIT_COLABOR_MAP;
      else process.env.GIT_COLABOR_MAP = prev;
    }
  });

  it('keyFileName sanitizes fingerprint into a safe filename', () => {
    expect(keyFileName('SHA256:abcDEF+/')).toBe('SHA256_abcDEF_.key');
  });

  it('keyFilePath lives under keys dir', () => {
    expect(keyFilePath('SHA256:abcd')).toMatch(/keys\/SHA256_abcd\.key$/);
  });
});
