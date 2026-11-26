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
 * Serves session-scoped SSH key passphrases to the CLI's SSH_ASKPASS helper
 * (and to ssh-add) over a UNIX-domain socket — a NAMED PIPE on Windows, see
 * `askpassEndpoint`. Matches the CLI's `askSocket` protocol:
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
  /** what `socketPath` is on disk: a socket file we own and must remove, or a pipe (nothing to remove) */
  private endpointKind: 'socket' | 'pipe' | undefined = 'socket';

  constructor(private readonly deps: AskpassDeps) {}

  async start(): Promise<{ socketPath: string; token: string }> {
    const dir = colaborDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const sock = askpassEndpoint(this.deps.sessionId);
    this.endpointKind = askpassEndpointKind(dir, sock);
    if (this.endpointKind !== 'pipe') {
      // clean any stale socket file at this path (a named pipe leaves no file)
      await unlink(sock).catch(() => {});
    }

    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      srv.once('error', reject);
      srv.listen(sock, () => {
        srv.removeListener('error', reject);
        resolve();
      });
    });
    // 0600 is the socket FILE's access control. A pipe has no file: access
    // is its OS security descriptor plus the token (constant-time compared)
    if (this.endpointKind !== 'pipe') await chmod(sock, 0o600).catch(() => {});
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
        const banked = await this.deps.secretLookup(req.fingerprint);
        this.deps.log?.info(`askpass query fp=${req.fingerprint} → ${banked ? 'banked' : 'not banked, prompting'}`);
        const pass = banked
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
    // a pipe vanishes with its server; only a socket file needs removing
    if (this.socketPath && this.endpointKind !== 'pipe') await unlink(this.socketPath).catch(() => {});
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

const SOCKET_NAME_RE = /^askpass-[\w.-]+\.sock$/;
const PIPE_RE = /^\\\\\.\\pipe\\git-colabor-askpass-[\w.-]+$/;

/**
 * The askpass bridge endpoint for a session. Node has no filesystem sockets
 * on Windows: `listen()` on a `.sock` path is an invalid pipe name there and
 * fails with EACCES whatever the directory. So the bridge is a NAMED PIPE on
 * Windows and a UNIX socket file inside the data dir everywhere else.
 */
export function askpassEndpoint(sessionId: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? String.raw`\\.\pipe\git-colabor-askpass-${sessionId}`
    : join(colaborDir(platform), `askpass-${sessionId}.sock`);
}

/**
 * What a session descriptor's endpoint is: OUR socket file inside the data
 * dir, OUR named pipe (Windows only), or `undefined` for anything else —
 * which no sweep or cleanup may ever touch.
 */
export function askpassEndpointKind(
  dir: string,
  endpoint: unknown,
  platform: NodeJS.Platform = process.platform,
): 'socket' | 'pipe' | undefined {
  if (typeof endpoint !== 'string') return undefined;
  if (platform === 'win32' && PIPE_RE.test(endpoint)) return 'pipe';
  if (!SOCKET_NAME_RE.test(basename(endpoint))) return undefined;
  return join(dir, basename(endpoint)) === endpoint ? 'socket' : undefined;
}

/**
 * Best-effort sweep of the data dir: session-*.json whose extension-host pid
 * is gone (window closed / reloaded / crashed) are deleted together with
 * their socket file, and askpass-*.sock files no live session references are
 * removed as crash leftovers. Every extension start runs this, so the dir
 * self-cleans instead of accumulating one token-bearing file per exthost
 * lifetime.
 */
export async function sweepSessionFiles(
  dir = colaborDir(),
  /** this window's OWN socket — never an orphan, even before its session file lands */
  keep?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ sessions: number; sockets: number }> {
  const removed = { sessions: 0, sockets: 0 };
  try {
    const entries = await readdir(dir);
    const liveSockets = new Set<string>();
    for (const f of entries.filter((n) => /^session-.*\.json$/.test(n))) {
      try {
        const parsed = JSON.parse(await readFile(join(dir, f), 'utf8')) as { pid?: unknown; socketPath?: string };
        const endpoint = parsed.socketPath;
        const kind = askpassEndpointKind(dir, endpoint, platform);
        // stale = pid gone, OR an endpoint that is not ours, OR (a socket
        // file) the file no longer exists — the pid was REUSED by an
        // unrelated process. A named pipe has no file to check: it exists
        // exactly as long as its server process does.
        const stale =
          !pidIsAlive(parsed.pid) ||
          kind === undefined ||
          (kind === 'socket' && (endpoint === undefined || !existsSync(endpoint)));
        if (!stale) {
          if (kind === 'socket' && endpoint !== undefined) liveSockets.add(basename(endpoint));
          continue;
        }
        await unlink(join(dir, f)).catch(() => {});
        removed.sockets += await rmIfOurs(dir, endpoint, platform);
        removed.sessions += 1;
      } catch {
        // unreadable session file — leave it to the next sweep
      }
    }
    for (const f of entries.filter((n) => /^askpass-[\w.-]+\.sock$/.test(n))) {
      if (liveSockets.has(f)) continue;
      if (keep && basename(keep) === f) continue; // ours — created before our session file existed
      await unlink(join(dir, f)).catch(() => {});
      removed.sockets += 1;
    }
  } catch {
    // dir missing / unreadable — nothing to sweep
  }
  return removed;
}

async function rmIfOurs(dir: string, path: unknown, platform?: NodeJS.Platform): Promise<number> {
  // a socket file only — a pipe has nothing on disk, a foreign path is not ours to remove
  if (typeof path !== 'string' || askpassEndpointKind(dir, path, platform) !== 'socket') return 0;
  await unlink(path).catch(() => {});
  return 1;
}

export function colaborDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
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
  // Register OURSELVES first, THEN sweep: the askpass socket is created by
  // start() before this file exists, so a sweep that runs in between sees
  // our own socket as an "orphan" and deletes it — after which every
  // askpass query for this window fails with "no Git Colabor session
  // running" while the session file points at a socket that is gone.
  const file = join(colaborDir(), `session-${process.pid}.json`);
  await writeFile(file, JSON.stringify({ sessionId, socketPath, token, pid: process.pid }) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  // sweep AFTER the session file landed, and never touch our own socket
  void sweepSessionFiles(colaborDir(), socketPath).catch(() => {});
}
