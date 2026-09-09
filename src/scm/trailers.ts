/**
 * Pure text helpers for the `Co-authored-by:` trailer block in the SCM
 * commit-message input. No vscode imports — unit-testable.
 */

export type ParsedAuthor = { name: string; email: string };

const TRAILER_RE = /^Co-authored-by:[ \t]*(.*?)[ \t]*<([^>]+)>[ \t]*$/;

const trailerLine = (a: ParsedAuthor): string => `Co-authored-by: ${a.name} <${a.email}>`;

/** Parse a `Name <email>` memory entry; undefined when malformed. */
export function parseAuthorString(s: string): ParsedAuthor | undefined {
  const m = s.match(/^(.*?)\s*<([^>]+)>$/);
  return m ? { name: m[1].trim(), email: m[2] } : undefined;
}

/** All co-author trailers in the message, in order (duplicates kept). */
export function parseCoAuthors(text: string): ParsedAuthor[] {
  const out: ParsedAuthor[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(TRAILER_RE);
    if (m) out.push({ name: m[1], email: m[2] });
  }
  return out;
}

/**
 * Append one trailer for the author at the end of the message, formatted
 * into the trailer block: directly under existing trailers, or after a
 * blank line when none exist yet.
 */
export function appendTrailer(text: string, author: ParsedAuthor): string {
  const base = text.replace(/[\r\n]+$/, '');
  if (base === '') return trailerLine(author);
  const lastLine = base.split(/\r?\n/).pop() ?? '';
  return TRAILER_RE.test(lastLine) ? `${base}\n${trailerLine(author)}` : `${base}\n\n${trailerLine(author)}`;
}

/**
 * Remove ONE occurrence (the last) of a trailer for `email`. Returns the
 * input unchanged when no trailer matches.
 */
export function removeTrailerOnce(text: string, email: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(TRAILER_RE);
    if (m && m[2].toLowerCase() === email.toLowerCase()) {
      lines.splice(i, 1);
      // drop the now-dangling blank separator if the block is gone
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines.join('\n');
    }
  }
  return text;
}
