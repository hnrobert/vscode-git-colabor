import { getEffectiveConfig } from '../git/config.js';
import { runBin } from '../git/exec.js';
import { AppError } from '../errors.js';

export type GpgKey = {
  /** primary key fingerprint — the value written to `user.signingKey` */
  fingerprint: string;
  /** long key id (last 16 hex digits) */
  keyId: string;
  /** valid user ids, e.g. "Alice <alice@x.com>" */
  uids: string[];
  /** lowercased emails taken from the user ids */
  emails: string[];
};

// key / uid validity flags that make an entry unusable: invalid, disabled, revoked, expired, not valid
const UNUSABLE = new Set(['i', 'd', 'r', 'e', 'n']);

/** gpg escapes ':' and control bytes in colon output as `\xNN`. */
function unescape(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function emailOf(uid: string): string | undefined {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(uid) ?? /^([^<>\s]+@[^<>\s]+)$/.exec(uid.trim());
  return m?.[1]?.toLowerCase();
}

/**
 * Parse `gpg --list-secret-keys --with-colons` into the secret keys usable for
 * signing (the key as a whole carries the `S` capability and is neither
 * revoked, expired nor disabled). Subkey (`ssb`) records are skipped.
 */
export function parseSecretKeys(colons: string): GpgKey[] {
  const keys: GpgKey[] = [];
  let cur: GpgKey | undefined;
  let usable = false;
  let inSubkey = false;
  const flush = () => {
    if (cur && usable && cur.fingerprint) keys.push(cur);
  };
  for (const line of colons.split('\n')) {
    const f = line.split(':');
    switch (f[0]) {
      case 'sec': {
        flush();
        const caps = f[11] ?? '';
        cur = { fingerprint: '', keyId: f[4] ?? '', uids: [], emails: [] };
        usable = !UNUSABLE.has(f[1] ?? '') && caps.includes('S') && !caps.includes('D');
        inSubkey = false;
        break;
      }
      case 'ssb':
        inSubkey = true;
        break;
      case 'fpr':
        if (cur && !inSubkey && !cur.fingerprint) cur.fingerprint = f[9] ?? '';
        break;
      case 'uid': {
        if (!cur || UNUSABLE.has(f[1] ?? '')) break;
        const uid = unescape(f[9] ?? '');
        cur.uids.push(uid);
        const email = emailOf(uid);
        if (email) cur.emails.push(email);
        break;
      }
    }
  }
  flush();
  return keys;
}

/** The gpg binary git itself would run (`gpg.program`, default `gpg`). */
async function gpgProgram(cwd?: string): Promise<string> {
  return (await getEffectiveConfig('gpg.program', cwd))?.value || 'gpg';
}

/**
 * Secret keys usable for commit signing, optionally narrowed by `query`
 * (fingerprint / key id / email — anything gpg accepts). A query that matches
 * nothing yields []; a missing gpg binary is a clear error.
 */
export async function listSigningKeys(cwd?: string, query?: string): Promise<GpgKey[]> {
  const program = await gpgProgram(cwd);
  let r;
  try {
    r = await runBin(program, ['--batch', '--list-secret-keys', '--with-colons', ...(query ? [query] : [])], { cwd });
  } catch {
    throw new AppError({
      code: 'GPG_UNAVAILABLE',
      message: `cannot run "${program}"`,
      exitCode: 1,
      hints: ['install GnuPG, or point git at it: git config --global gpg.program <path>'],
    });
  }
  // gpg exits 2 when the query matches no secret key — that is simply "none"
  return r.exitCode === 0 ? parseSecretKeys(r.stdout) : [];
}
