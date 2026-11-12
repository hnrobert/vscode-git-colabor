/**
 * SSH_ASKPASS helper for git-colabor. Invoked by `ssh-add`, `ssh-keygen` and
 * `ssh` (at push/fetch time via the SSH_ASKPASS prefix baked into
 * core.sshCommand) when SSH_ASKPASS=<this> + SSH_ASKPASS_REQUIRE=force.
 *
 * Two modes:
 *  - bridge env present (GIT_COLABOR_ASKPASS_SOCK/TOKEN/FINGERPRINT, set by
 *    identity/agent.ts for the ssh-add flow) → query the extension socket
 *    directly;
 *  - bare mode (push-time `ssh -i <key>` knows nothing about us) → parse the
 *    key path out of the prompt, fingerprint it with ssh-keygen, and discover
 *    the newest session-*.json for the socket/token.
 *
 * Bundled separately to dist/askpass.cjs (see tsup.config.ts).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { askSocket } from '../core/secrets/askpass-protocol.js';
import { discoverSessionBridge, discoverSessionBridges } from '../core/secrets/session-bridge.js';
import { dataDir as colaborDir } from '../core/paths.js';

/** Fingerprint of a key file via `ssh-keygen -lf`, or undefined. */
function fingerprintOf(path: string): string | undefined {
  const r = spawnSync('ssh-keygen', ['-lf', path], { encoding: 'utf8' });
  const m = r.stdout.match(/SHA256:[A-Za-z0-9+/=]+/);
  return m?.[0];
}

async function main(): Promise<void> {
  let socketPath = process.env.GIT_COLABOR_ASKPASS_SOCK;
  let token = process.env.GIT_COLABOR_ASKPASS_TOKEN;
  let fingerprint = process.env.GIT_COLABOR_FINGERPRINT;

  // bare mode: the prompt is argv[2]. Its key-path format depends on the
  // caller — ssh says `Enter passphrase for key '/path': ` (single quotes),
  // some ssh-keygen builds say `Enter passphrase for "/path": ` (double
  // quotes), others a BARE "Enter passphrase: " with no path at all. Accept
  // both prompt forms, then fall back to GIT_COLABOR_SIGNING_KEY (exported by
  // the sign wrapper, which sees -f <key> in its own argv).
  if (!fingerprint) {
    const prompt = process.argv[2] ?? '';
    const keyPath =
      prompt.match(/for key '([^']+)'/)?.[1] ??
      prompt.match(/for "([^"]+)"/)?.[1] ??
      process.env.GIT_COLABOR_SIGNING_KEY;
    if (keyPath) fingerprint = fingerprintOf(keyPath);
    if (!socketPath || !token) {
      const session = discoverSessionBridge();
      if (session) {
        socketPath ??= session.socketPath;
        token ??= session.token;
      }
    }
  }

  if (socketPath && token && fingerprint) {
    const got = await askSocket(socketPath, token, fingerprint);
    if (got) {
      process.stdout.write(got);
      process.exit(0);
    }
  }
  if (fingerprint) {
    // bare mode with multiple instances: several windows / restarted exthosts
    // each hold their OWN session store — the newest bridge may be an
    // instance that never saw this key's passphrase. Try every bridge,
    // newest first; dead sockets refuse instantly, empty ones close silently.
    for (const b of discoverSessionBridges()) {
      if (b.socketPath === socketPath) continue; // already tried above
      const got = await askSocket(b.socketPath, b.token, fingerprint);
      if (got) {
        process.stdout.write(got);
        process.exit(0);
      }
    }
  }
  // failure trace (no secrets): makes "no passphrase available" diagnosable —
  // which prompt we saw, whether the key fingerprinted, how many bridges answered
  const bridges = discoverSessionBridges();
  try {
    appendFileSync(
      join(colaborDir(), 'askpass-debug.log'),
      `${new Date().toISOString()} prompt="${(process.argv[2] ?? '').slice(0, 120)}" fp=${fingerprint ?? 'none'} envSock=${!!socketPath} bridges=${bridges.length}\n`,
    );
  } catch {
    // never fail the askpass because of its own debug log
  }
  // actionable message instead of a bare "no passphrase available": no session
  // at all means no window is connected; sessions present but no passphrase
  // means the key's identity was never used / the prompt was dismissed
  process.stderr.write(
    bridges.length === 0
      ? 'git-colabor askpass: no Git Colabor session running — reload the VS Code window or select an identity first\n'
      : 'git-colabor askpass: no passphrase for this key — click your identity in the Git Colabor view (or select an identity)\n',
  );
  process.exit(1);
}

main().catch((e: unknown) => {
  process.stderr.write(`git-colabor askpass error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
