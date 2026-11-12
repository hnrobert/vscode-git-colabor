export const CO_AUTHOR_TRAILER = 'Co-authored-by:';

/** A co-author entry for trailer formatting. */
export class Author {
  constructor(
    public readonly key: string,
    public readonly name: string,
    public readonly email: string,
  ) {}

  /** `NAME <EMAIL>` */
  toString(): string {
    return `${this.name} <${this.email}>`;
  }

  /** `Co-authored-by: NAME <EMAIL>` */
  format(): string {
    return `${CO_AUTHOR_TRAILER} ${this.toString()}`;
  }
}

/**
 * Generate a catalogue key (initials + first 2 chars of email).
 * e.g. "Richard Kotze" + "rkotze@x.com" → "rkrk"
 */
export function genKey(name: string, email: string): string {
  const initials = name
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] ?? '')
    .join('');
  return `${initials}${email.slice(0, 2)}`;
}
