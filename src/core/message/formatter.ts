import { EOL } from 'node:os';
import type { Author } from '../authors/types.js';
import { CO_AUTHOR_TRAILER } from '../authors/types.js';

/**
 * Message formatter: strip every existing `Co-authored-by:` trailer
 * (tolerant of CRLF/CR/LF), then re-append `\n\n` + trailers joined by os.EOL.
 */
export function formatMessage(txt: string, authors: Author[]): string {
  const stripRe = new RegExp(`(\r\n|\r|\n){0,2}${CO_AUTHOR_TRAILER}.*`, 'g');
  const message = txt.replace(stripRe, '');
  if (authors && authors.length > 0) {
    const trailerText = authors.map((a) => a.format()).join(EOL);
    return [message, EOL, EOL, trailerText].join('');
  }
  return message;
}

/** The hook-consumable blob: two leading EOLs + trailers. */
export function printTrailers(authors: Author[]): string {
  if (authors.length === 0) return '';
  return EOL + EOL + authors.map((a) => a.format()).join(EOL);
}
