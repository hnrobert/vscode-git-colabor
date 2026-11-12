import { gitRaw } from './exec.js';

export type Committer = { name: string; email: string };

const AUTHOR_LINE = /^(.*)\s<([^<>]+)>$/;

function bump(counts: Map<string, { name: string; email: string; count: number }>, name: string, email: string): void {
  const key = email.toLowerCase();
  const cur = counts.get(key);
  if (cur) cur.count++;
  else counts.set(key, { name, email, count: 1 });
}

/**
 * Distinct people in the repo history — COMMITTERS (`git log
 * --format=%cn%x1f%ce`) plus every `Co-authored-by: Name <email>` trailer
 * author (pairing partners never appear as committers). Most frequent
 * first, deduped by email (case-insensitive).
 */
export async function historyCommitters(cwd?: string): Promise<Committer[]> {
  const counts = new Map<string, { name: string; email: string; count: number }>();
  const r = await gitRaw(['log', '--format=%cn%x1f%ce'], { cwd });
  if (r.exitCode === 0) {
    for (const line of r.stdout.split('\n')) {
      const sep = line.indexOf('\x1f');
      if (sep < 0) continue;
      const name = line.slice(0, sep).trim();
      const email = line.slice(sep + 1).trim();
      if (!name || !email) continue;
      bump(counts, name, email);
    }
  }
  // co-author trailers: valueonly emits each "Name <email>" on its own line
  const t = await gitRaw(['log', '--format=%(trailers:key=Co-authored-by,valueonly)'], { cwd });
  if (t.exitCode === 0) {
    for (const line of t.stdout.split('\n')) {
      const m = line.match(AUTHOR_LINE);
      if (!m) continue;
      bump(counts, m[1].trim(), m[2].trim());
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).map(({ name, email }) => ({ name, email }));
}
