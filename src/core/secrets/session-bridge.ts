import { readdirSync, readFileSync, statSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dataDir } from '../paths.js';

function pidIsAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but owned by another user; ESRCH = dead
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * All live candidate bridges from session-*.json in the data dir, NEWEST
 * first: {socketPath, token} per running extension instance. Several
 * instances coexist routinely — multiple windows, exthost restarts — each
 * with its OWN in-memory session store, so the newest bridge is not
 * necessarily the one holding a given passphrase. Callers fall through the
 * list until one answers.
 *
 * Descriptors whose extension-host pid is gone (window closed / reloaded /
 * crashed) are skipped AND deleted on the spot together with their socket —
 * the dir self-cleans on every CLI run instead of accumulating one
 * token-bearing file per exthost lifetime.
 */
export function discoverSessionBridges(): { socketPath: string; token: string }[] {
  try {
    const dir = dataDir();
    const sessions = readdirSync(dir)
      .filter((f) => /^session-.*\.json$/.test(f))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const out: { socketPath: string; token: string }[] = [];
    for (const s of sessions) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, s.f), 'utf8')) as {
          socketPath?: string;
          token?: string;
          pid?: unknown;
        };
        if (!parsed.socketPath || !parsed.token) continue;
        const ourSock =
          /^askpass-[\w.-]+\.sock$/.test(basename(parsed.socketPath)) &&
          join(dir, basename(parsed.socketPath)) === parsed.socketPath;
        // stale = pid gone (or reused by an unrelated process — the socket it
        // pointed at no longer exists); such descriptors cannot answer anyway
        const stale =
          (parsed.pid !== undefined && !pidIsAlive(parsed.pid)) || !ourSock || !existsSync(parsed.socketPath);
        if (stale) {
          // only ever remove sock FILES WE OWN, inside our dir, by our pattern
          if (ourSock && existsSync(parsed.socketPath)) {
            try {
              rmSync(parsed.socketPath);
            } catch {
              // already gone
            }
          }
          try {
            unlinkSync(join(dir, s.f));
          } catch {
            // already gone
          }
          continue;
        }
        out.push({ socketPath: parsed.socketPath, token: parsed.token });
      } catch {
        // unreadable session file — skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Newest session-*.json in the data dir: {socketPath, token} of the extension's
 * askpass bridge, if one is running on this host. Shared by apply (decide
 * whether baking the SSH_ASKPASS prefix into core.sshCommand can ever pay off).
 */
export function discoverSessionBridge(): { socketPath: string; token: string } | undefined {
  return discoverSessionBridges()[0];
}
