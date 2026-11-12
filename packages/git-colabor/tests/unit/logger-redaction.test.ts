import { describe, it, expect } from 'vitest';
import { addRedactable, redact } from '../../src/core/logging/logger.js';

describe('logger redaction', () => {
  it('redacts a registered secret value', () => {
    addRedactable('hunter2-secret');
    expect(redact('password=hunter2-secret ok')).toBe('password=[redacted] ok');
  });

  it('leaves non-secret text intact', () => {
    expect(redact('just a normal log line')).toBe('just a normal log line');
  });

  it('redacts multiple occurrences', () => {
    addRedactable('tok-XYZ');
    expect(redact('tok-XYZ and tok-XYZ again')).toBe('[redacted] and [redacted] again');
  });
});
