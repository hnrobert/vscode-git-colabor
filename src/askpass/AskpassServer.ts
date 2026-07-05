import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, unlink, chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliLogger } from '../cli/CliClient.js';

export type AskpassDeps = {
  sessionId: string;
  /** Look up a passphrase for an SSH key fingerprint from VS Code SecretStorage. */
  secretLookup: (fingerprint: string) => Promise<string | undefined>;
  log?: CliLogger;
};

/**
 * UNIX-domain socket server that serves SSH key passphrases from VS Code SecretStorage to the
 * CLI's SSH_ASKPASS helper (and to ssh-add). Matches the CLI's `askSocket` protocol:
 * request = one JSON line `{token, fingerprint}`; response = the passphrase bytes (then close).
 * On any failure, close without writing so the helper falls through to passphraseCommand/tty.
 */
export class AskpassServer {
  private readonly token = randomBytes(32).toString('hex');
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
        const pass = await this.deps.secretLookup(req.fingerprint);
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
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
  const file = join(colaborDir(), `session-${process.pid}.json`);
  await writeFile(file, JSON.stringify({ sessionId, socketPath, token, pid: process.pid }) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}
