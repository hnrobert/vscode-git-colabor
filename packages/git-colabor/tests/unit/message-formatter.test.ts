import { describe, it, expect } from 'vitest';
import { EOL } from 'node:os';
import { formatMessage, printTrailers } from '../../src/core/message/formatter.js';
import { Author } from '../../src/core/authors/types.js';

describe('formatMessage', () => {
  it('leaves text unchanged when no authors', () => {
    expect(formatMessage('hello', [])).toBe('hello');
  });

  it('appends a trailer with a blank line', () => {
    const out = formatMessage('hello', [new Author('jd', 'Jane', 'j@x.com')]);
    expect(out).toBe(['hello', EOL, EOL, 'Co-authored-by: Jane <j@x.com>'].join(''));
  });

  it('joins multiple trailers with os.EOL', () => {
    const out = formatMessage('hello', [
      new Author('jd', 'Jane', 'j@x.com'),
      new Author('fb', 'Frances', 'f@x.com'),
    ]);
    expect(out).toBe(
      ['hello', EOL, EOL, 'Co-authored-by: Jane <j@x.com>', EOL, 'Co-authored-by: Frances <f@x.com>'].join(''),
    );
  });

  it('replaces existing trailers', () => {
    const txt = ['m', EOL, EOL, 'Co-authored-by: Jane <j@x.com>'].join('');
    expect(formatMessage(txt, [new Author('fb', 'Frances', 'f@x.com')])).toBe(
      ['m', EOL, EOL, 'Co-authored-by: Frances <f@x.com>'].join(''),
    );
  });

  it('strips trailers when authors empty', () => {
    const txt = ['m', EOL, EOL, 'Co-authored-by: Jane <j@x.com>'].join('');
    expect(formatMessage(txt, [])).toBe('m');
  });
});

describe('printTrailers', () => {
  it('empty authors → empty string', () => {
    expect(printTrailers([])).toBe('');
  });

  it('two leading EOLs then trailers', () => {
    expect(printTrailers([new Author('jd', 'Jane', 'j@x.com')])).toBe(
      `${EOL}${EOL}Co-authored-by: Jane <j@x.com>`,
    );
  });
});
