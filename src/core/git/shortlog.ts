import { gitRaw } from './exec.js';
import { Author, genKey } from '../authors/types.js';

const SHORTLOG_LINE = /^\s*\d+\t(.+)\s<(.+)>$/;
const AUTHOR_LINE = /^(.*)\s<([^<>]+)>$/;

/**
 * Enumerate contributors of the current repo via `git shortlog -seni HEAD`,
 * PLUS every `Co-authored-by: Name <email>` trailer author — pairing
 * partners never show in shortlog but are prime co-author candidates.
 * Optionally filter by substring (applied to both sources).
 */
export async function repoAuthors(filter?: string, cwd?: string): Promise<Author[]> {
  const args = ['shortlog', '-seni', 'HEAD'];
  if (filter) args.splice(1, 0, `--author=${filter}`);
  const out: Author[] = [];
  const seen = new Set<string>();
  const add = (name: string, email: string): void => {
    if (!name || !email) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(new Author(genKey(name, email), name, email));
  };
  const r = await gitRaw(args, { cwd });
  if (r.exitCode === 0) {
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(SHORTLOG_LINE);
      if (m) add(m[1].trim(), m[2].trim());
    }
  }
  const t = await gitRaw(['log', '--format=%(trailers:key=Co-authored-by,valueonly)'], { cwd });
  if (t.exitCode === 0) {
    for (const line of t.stdout.split(/\r?\n/)) {
      const m = line.match(AUTHOR_LINE);
      if (!m) continue;
      if (filter && !`${m[1]} <${m[2]}>`.toLowerCase().includes(filter.toLowerCase())) continue;
      add(m[1].trim(), m[2].trim());
    }
  }
  return out;
}
