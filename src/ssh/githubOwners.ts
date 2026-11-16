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
/** the key GitHub actually accepted: "Server accepts key: … SHA256:xxx" */
const ACCEPTED_FP_RE = /Server accepts key:.*?(SHA256:[A-Za-z0-9+/=]+)/g;

/**
 * A probe result: the login GitHub greeted, and the fingerprint of the key
 * it accepted (from `ssh -v` debug output) — the login only counts when the
 * fingerprint matches the probed key (ssh-config IdentityFile entries are
 * cumulative and can ride along, authenticating as someone else).
 */
type Probe = { login: string | undefined; acceptedFp: string | undefined };

/** session cache keyed by key path; value keyed to the file's mtime */
const cache = new Map<string, { mtimeMs: number; login: string | undefined }>();

const active = new Map<string, Promise<string | undefined>>();
let inFlight = 0;
const waiters: Array<() => void> = [];
const MAX_CONCURRENT = 8;

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

function attempt(args: string[], timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    let child;
    try {
      // GitHub's "Hi <username>!" greeting arrives on STDERR (exit is always 1);
      // -v puts the accepted key's fingerprint there too
      child = spawn('ssh', [...args, '-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ login: undefined, acceptedFp: undefined });
      return;
    }
    let out = '';
    const done = (v: Probe): void => {
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => {
      child.kill();
      done({ login: undefined, acceptedFp: undefined });
    }, timeoutMs);
    const feed = (d: Buffer): void => {
      out += d.toString('utf8');
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', () => done({ login: undefined, acceptedFp: undefined }));
    child.on('close', () => {
      const login = OWNER_RE.exec(out)?.[1];
      let acceptedFp: string | undefined;
      for (const m of out.matchAll(ACCEPTED_FP_RE)) acceptedFp = m[1]; // last one wins
      done({ login, acceptedFp });
    });
  });
}

/** The probed key's own fingerprint — `.pub` sibling first, then the private file. */
function localFingerprint(keyPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh-keygen', ['-lf', `${keyPath}.pub`], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(undefined);
      return;
    }
    let out = '';
    const t = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 5000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(t);
      const m = /SHA256:[A-Za-z0-9+/=]+/.exec(out);
      resolve(m?.[0]);
    });
  });
}

/**
 * The GitHub login owning `keyPath`, or undefined (unknown / not on GitHub /
 * probe failed). NEVER a wrong label: when ssh-config's cumulative
 * IdentityFile entries authenticate as someone else, the accepted-key
 * fingerprint won't match the probed key and the login is dropped.
 * Never rejects and never hangs past ~20 s total.
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
      '-o',
      'IdentityFile=none',
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
    // RACE both routes (direct 22 and ssh.github.com:443) — a proxy that
    // black-holes port 22 makes the first attempt hang to its full timeout,
    // and a SERIAL fallback then makes every key resolve at the same moment
    // (12 s hang + 443 RTT each). First route to greet wins; if neither
    // greets, resolve when both have finished.
    const race = (a: Promise<Probe>, b: Promise<Probe>): Promise<Probe> =>
      new Promise((resolve) => {
        let done = false;
        let remaining = 2;
        const win = (p: Probe): void => {
          if (!done && p.login) {
            done = true;
            resolve(p);
          }
        };
        const oneDone = (): void => {
          if (!done && --remaining === 0) resolve({ login: undefined, acceptedFp: undefined });
        };
        a.then((p) => {
          win(p);
          oneDone();
        }).catch(oneDone);
        b.then((p) => {
          win(p);
          oneDone();
        }).catch(oneDone);
      });
    const result = await race(
      attempt([...common, 'git@github.com'], 12_000),
      attempt([...common, '-p', '443', 'git@ssh.github.com'], 12_000),
    );
    let login = result.login;
    // verify GitHub authenticated THE PROBED KEY, not a config-borrowed one
    if (login && result.acceptedFp) {
      const local = await localFingerprint(keyPath);
      if (local && local !== result.acceptedFp) login = undefined;
    }
    cache.set(keyPath, { mtimeMs, login });
    active.delete(keyPath);
    return login;
  });
  active.set(keyPath, p);
  return p;
}
