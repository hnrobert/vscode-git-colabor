import { hostname, userInfo } from 'node:os';
import { readState } from './state.js';
import type { HeldBy, Source } from '../types.js';

export type ConflictInfo = { heldBy: HeldBy };

export function isStale(heldBy: HeldBy, staleMinutes: number): boolean {
  const ageMs = Date.now() - new Date(heldBy.since).getTime();
  return ageMs > staleMinutes * 60_000;
}

/**
 * Advisory multi-session coordination. Returns a conflict if another non-stale session
 * currently holds the repo. Never blocks (caller decides via --no-override).
 */
export async function detectConflict(
  session: string,
  cwd?: string,
  // no threshold by default: another session's lock never silently expires —
  // staleness is opt-in via `--stale-minutes` / the extension setting
  staleMinutes = Infinity,
): Promise<ConflictInfo | null> {
  const st = await readState(cwd);
  const hb = st.heldBy;
  if (!hb || hb.session === session) return null;
  if (isStale(hb, staleMinutes)) return null;
  return { heldBy: hb };
}

export function cliSessionId(): string {
  return `cli:${process.pid}@${hostname()}`;
}

export function nowHeldBy(session: string, source: Source): HeldBy {
  return {
    session,
    since: new Date().toISOString(),
    host: hostname(),
    osUser: userInfo().username,
    source,
  };
}
