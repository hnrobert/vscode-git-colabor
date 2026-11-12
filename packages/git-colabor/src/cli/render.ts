import type { Author } from '../core/authors/types.js';

export type AuthorJson = { key: string; name: string; email: string };

export function authorToJson(a: Author): AuthorJson {
  return { key: a.key, name: a.name, email: a.email };
}

export function renderAuthors(authors: AuthorJson[]): string {
  if (authors.length === 0) return '(none)';
  const keyW = Math.max(2, ...authors.map((a) => a.key.length));
  const nameW = Math.max(4, ...authors.map((a) => a.name.length));
  return authors
    .map((a) => `${a.key.padEnd(keyW)}  ${a.name.padEnd(nameW)}  ${a.email}`)
    .join('\n');
}
