import { describe, expect, it } from 'vitest';
import { appendTrailer, parseAuthorString, parseCoAuthors, removeTrailerOnce } from '../../src/scm/trailers.js';

const jd = { name: 'Jamie Doe', email: 'jamie@example.com' };
const rk = { name: 'Richard Kotze', email: 'rkotze@example.com' };

describe('parseCoAuthors', () => {
  it('collects trailers in order', () => {
    const text = 'fix: thing\n\nCo-authored-by: Jamie Doe <jamie@example.com>\nCo-authored-by: Richard Kotze <rkotze@example.com>';
    expect(parseCoAuthors(text)).toEqual([jd, rk]);
  });

  it('returns empty for a message without trailers', () => {
    expect(parseCoAuthors('fix: thing\n\nbody')).toEqual([]);
  });

  it('tolerates CRLF line endings and extra spaces', () => {
    expect(parseCoAuthors('msg\r\n\r\nCo-authored-by:   Jamie Doe   <jamie@example.com>  ')).toEqual([jd]);
  });
});

describe('parseAuthorString', () => {
  it('parses a Name <email> entry', () => {
    expect(parseAuthorString('Jamie Doe <jamie@example.com>')).toEqual(jd);
  });

  it('tolerates missing spaces and extra inner spaces', () => {
    expect(parseAuthorString('Jamie Doe<jamie@example.com>')).toEqual(jd);
    expect(parseAuthorString('  Jamie Doe   <jamie@example.com>')?.name).toBe('Jamie Doe');
  });

  it('returns undefined for malformed entries', () => {
    expect(parseAuthorString('jamie@example.com')).toBeUndefined();
    expect(parseAuthorString('Jamie Doe')).toBeUndefined();
    expect(parseAuthorString('')).toBeUndefined();
  });
});

describe('appendTrailer', () => {
  it('appends directly under an existing trailer block', () => {
    const text = 'fix: thing\n\nCo-authored-by: Jamie Doe <jamie@example.com>';
    expect(appendTrailer(text, rk)).toBe(
      'fix: thing\n\nCo-authored-by: Jamie Doe <jamie@example.com>\nCo-authored-by: Richard Kotze <rkotze@example.com>',
    );
  });

  it('creates the block with a blank line after plain text', () => {
    expect(appendTrailer('fix: thing', jd)).toBe('fix: thing\n\nCo-authored-by: Jamie Doe <jamie@example.com>');
  });

  it('handles an empty input', () => {
    expect(appendTrailer('', jd)).toBe('Co-authored-by: Jamie Doe <jamie@example.com>');
  });

  it('collapses trailing newlines before appending', () => {
    expect(appendTrailer('fix: thing\n\n\n', jd)).toBe('fix: thing\n\nCo-authored-by: Jamie Doe <jamie@example.com>');
  });
});

describe('removeTrailerOnce', () => {
  it('removes one occurrence of a duplicated author (the last)', () => {
    const text = 'msg\n\nCo-authored-by: Jamie Doe <jamie@example.com>\nCo-authored-by: Jamie Doe <jamie@example.com>';
    expect(removeTrailerOnce(text, 'jamie@example.com')).toBe('msg\n\nCo-authored-by: Jamie Doe <jamie@example.com>');
  });

  it('removes only the matching author and drops the separator when the block is gone', () => {
    const text = 'msg\n\nCo-authored-by: Jamie Doe <jamie@example.com>';
    expect(removeTrailerOnce(text, 'jamie@example.com')).toBe('msg');
  });

  it('keeps other trailers', () => {
    const text = 'msg\n\nCo-authored-by: Jamie Doe <jamie@example.com>\nCo-authored-by: Richard Kotze <rkotze@example.com>';
    expect(removeTrailerOnce(text, 'jamie@example.com')).toBe(
      'msg\n\nCo-authored-by: Richard Kotze <rkotze@example.com>',
    );
  });

  it('matches case-insensitively and returns input unchanged on no match', () => {
    const text = 'msg\n\nCo-authored-by: Jamie Doe <jamie@example.com>';
    expect(removeTrailerOnce(text, 'JAMIE@EXAMPLE.COM')).toBe('msg');
    expect(removeTrailerOnce(text, 'nobody@example.com')).toBe(text);
  });
});
