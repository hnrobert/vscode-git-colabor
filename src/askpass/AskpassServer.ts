import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, unlink, chmod, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { CliLogger } from '../cli/CliClient.js';

export type AskpassDeps = {
  sessionId: string;
  /** Look up a session-scoped passphrase for an SSH key fingerprint (in-memory). */
  secretLookup: (fingerprint: string) => Promise<string | undefined>;
  /**
   * Push-time fallback: called when the session map misses — ask the USER
   * (input box). May bank the answer into the session store. Returning
   * undefined closes silently and git's own flow surfaces whatever error
   * it produces, unchanged.
   */
  promptFor?: (fingerprint: string) => Promise<string | undefined>;
  log?: CliLogger;
};

/**
 * UNIX-domain socket server that serves session-scoped SSH key passphrases to the
 * CLI's SSH_ASKPASS helper (and to ssh-add). Matches the CLI's `askSocket` protocol:
 * request = one JSON line `{token, fingerprint}`; response = the passphrase bytes (then close).
 * On any failure, close without writing so the helper falls through to tty.
 */
export class AskpassServer {
  private readonly token = randomBytes(32).toString('hex');
  /** one prompt per fingerprint at a time — ssh retries would spam otherwise */
  private readonly promptInFlight = new Map<string, Promise<string | undefined>>();

  private promptSingleFlight(fingerprint: string): Promise<string | undefined> {
    if (!this.deps.promptFor) return Promise.resolve(undefined);
    const existing = this.promptInFlight.get(fingerprint);
    if (existing) return existing;
    const p = this.deps.promptFor(fingerprint).finally(() => {
      this.promptInFlight.delete(fingerprint);
    });
    this.promptInFlight.set(fingerprint, p);
    return p;
  }
  private server?: Server;
  private socketPath?: string;

  constructor(private readonly deps: AskpassDeps) {}

  async start(): Promise<{ socketPath: string; token: string }> {
    const dir = colaborDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const sock = join(dir, `askpass-${this.deps.sessionId}.sock`);
    // clean any stale socket at this path
    await unlink(sock).catch(() => {});

    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      srv.once('error', reject);
      srv.listen(sock, () => {
        srv.removeListener('error', reject);
        resolve();
      });
    });
    await chmod(sock, 0o600).catch(() => {});
    this.socketPath = sock;
    this.deps.log?.info(`askpass server listening on ${sock}`);
    return { socketPath: sock, token: this.token };
  }

  private handle(socket: Socket): void {
    let buf = '';
    let handled = false;
    socket.on('data', async (d) => {
      if (handled) return;
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      handled = true;
      const line = buf.slice(0, nl);
      try {
        const req = JSON.parse(line) as { token?: string; fingerprint?: string };
        if (!req.token || !req.fingerprint || !constantTimeEqual(req.token, this.token)) {
          socket.end(); // forbidden → empty response → helper falls through
          return;
        }
        const pass = (await this.deps.secretLookup(req.fingerprint))
          // push-time: ask the user instead of failing — a cancelled prompt
          // returns nothing and git's default flow / error pass through
          ?? (await this.promptSingleFlight(req.fingerprint));
        if (!pass) {
          socket.end(); // not found → fall through
          return;
        }
        socket.end(pass, 'utf8');
      } catch {
        socket.end();
      }
    });
    socket.on('error', () => socket.destroy());
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      if (!srv) return resolve();
      srv.close(() => resolve());
    });
    if (this.socketPath) await unlink(this.socketPath).catch(() => {});
    this.socketPath = undefined;
    // this exthost's session descriptor dies with its server
    await unlink(join(colaborDir(), `session-${process.pid}.json`)).catch(() => {});
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

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

/** only ever unlink sock FILES WE OWN, inside our dir, by our naming pattern */
const isOurSocket = (dir: string, path: unknown): path is string =>
  typeof path === 'string' && /^askpass-[\w.-]+\.sock$/.test(basename(path)) && join(dir, basename(path)) === path;

/**
 * Best-effort sweep of the data dir: session-*.json whose extension-host pid
 * is gone (window closed / reloaded / crashed) are deleted together with
 * their socket file, and askpass-*.sock files no live session references are
 * removed as crash leftovers. Every extension start runs this, so the dir
 * self-cleans instead of accumulating one token-bearing file per exthost
 * lifetime.
 */
export async function sweepSessionFiles(dir = colaborDir()): Promise<{ sessions: number; sockets: number }> {
  const removed = { sessions: 0, sockets: 0 };
  try {
    const entries = await readdir(dir);
    const liveSockets = new Set<string>();
    for (const f of entries.filter((n) => /^session-.*\.json$/.test(n))) {
      try {
        const parsed = JSON.parse(await readFile(join(dir, f), 'utf8')) as { pid?: unknown; socketPath?: string };
        const ours = isOurSocket(dir, parsed.socketPath);
        // stale = pid gone, OR the pid was REUSED by an unrelated process and
        // the bridge socket it pointed at no longer exists
        const stale = !pidIsAlive(parsed.pid) || !ours || (parsed.socketPath !== undefined && !existsSync(parsed.socketPath));
        if (!stale && ours) {
          liveSockets.add(basename(parsed.socketPath!));
          continue;
        }
        await unlink(join(dir, f)).catch(() => {});
        removed.sockets += await rmIfOurs(dir, parsed.socketPath);
        removed.sessions += 1;
      } catch {
        // unreadable session file — leave it to the next sweep
      }
    }
    for (const f of entries.filter((n) => /^askpass-[\w.-]+\.sock$/.test(n))) {
      if (liveSockets.has(f)) continue;
      await unlink(join(dir, f)).catch(() => {});
      removed.sockets += 1;
    }
  } catch {
    // dir missing / unreadable — nothing to sweep
  }
  return removed;
}

async function rmIfOurs(dir: string, path: unknown): Promise<number> {
  if (!isOurSocket(dir, path)) return 0;
  await unlink(path).catch(() => {});
  return 1;
}

export function colaborDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'git-colabor');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'git-colabor');
}

/**
 * Persist a per-session descriptor so a user-invoked terminal CLI can discover the bridge
 * while the extension is running. (The bundled CLI reads this when GIT_COLABOR_ASKPASS_SOCK is
 * not in its env — terminal invocation path.)
 */
export async function writeSessionFile(sessionId: string, socketPath: string, token: string): Promise<void> {
  // every new session sweeps the corpses of previous ones (crash leftovers included)
  void sweepSessionFiles().catch(() => {});
  const file = join(colaborDir(), `session-${process.pid}.json`);
  await writeFile(file, JSON.stringify({ sessionId, socketPath, token, pid: process.pid }) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}
