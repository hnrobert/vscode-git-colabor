import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

/**
 * Which GitHub account does an SSH key belong to?
 *
 * GitHub's REST API has NO fingerprint→user reverse lookup (GET
 * /users/{u}/keys is forward-only), but the SSH handshake itself answers:
 * `ssh -i <key> -T git@github.com` makes GitHub reply
 * "Hi <username>! You've successfully authenticated…" before closing
 * (always exit code 1). We probe that, with a port-443 fallback for hosts
 * that block outbound 22.
 *
 * Unencrypted keys and keys held in ssh-agent resolve (IdentitiesOnly
 * matches the agent copy by the file); an encrypted key with no agent copy
 * and no askpass just fails fast — the row simply stays unlabeled.
 * Results are cached per (path, mtime) for the session.
 */

const OWNER_RE = /Hi ([A-Za-z0-9-]+)!/;

/** session cache keyed by key path; value keyed to the file's mtime */
const cache = new Map<string, { mtimeMs: number; login: string | undefined }>();

const active = new Map<string, Promise<string | undefined>>();
let inFlight = 0;
const waiters: Array<() => void> = [];
const MAX_CONCURRENT = 4;

function withSlot<T>(fn: () => Promise<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const run = (): void => {
      inFlight++;
      fn().then(
        (v) => {
          inFlight--;
          waiters.shift()?.();
          resolve(v);
        },
        () => {
          inFlight--;
          waiters.shift()?.();
          resolve(undefined);
        },
      );
    };
    if (inFlight < MAX_CONCURRENT) run();
    else waiters.push(run);
  });
}

function attempt(args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      // GitHub's "Hi <username>!" greeting arrives on STDERR (exit is always 1)
      child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(undefined);
      return;
    }
    let out = '';
    const done = (v: string | undefined): void => {
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => {
      child.kill();
      done(undefined);
    }, timeoutMs);
    const feed = (d: Buffer): void => {
      out += d.toString('utf8');
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', () => done(undefined));
    child.on('close', () => {
      const m = OWNER_RE.exec(out);
      done(m?.[1]);
    });
  });
}

/**
 * The GitHub login owning `keyPath`, or undefined (unknown / not on GitHub /
 * probe failed). Never rejects and never hangs past ~20 s total.
 */
export async function githubOwnerOfKey(keyPath: string): Promise<string | undefined> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(keyPath)).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(keyPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.login;
  const running = active.get(keyPath);
  if (running) return running;
  const p = withSlot(async () => {
    const common = [
      '-i',
      keyPath,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'NumberOfPasswordPrompts=0',
      '-o',
      'PasswordAuthentication=no',
      '-T',
    ];
    const login =
      (await attempt([...common, 'git@github.com'], 12_000)) ??
      (await attempt([...common, '-p', '443', 'git@ssh.github.com'], 12_000));
    cache.set(keyPath, { mtimeMs, login });
    active.delete(keyPath);
    return login;
  });
  active.set(keyPath, p);
  return p;
}
