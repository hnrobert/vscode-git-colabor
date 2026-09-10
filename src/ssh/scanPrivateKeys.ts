/**
 * Scan a directory for SSH private key files. Pure node — no vscode imports,
 * unit-testable.
 *
 * Detection is content-based: every readable regular file's head is checked
 * for a `-----BEGIN … PRIVATE KEY-----` armor header, which all private key
 * formats carry (OpenSSH, PKCS#1 RSA/EC/DSA, PKCS#8, encrypted). This
 * automatically excludes `.pub` files, `config`, `known_hosts`, scripts and
 * anything else that isn't a key.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ScannedKey = {
  /** absolute path of the key file */
  path: string;
  /** file name */
  name: string;
  /** short human-readable key format, e.g. "OpenSSH", "RSA" */
  kind: string;
};

const HEADER_RE = /-----BEGIN ([A-Z ]*?) ?PRIVATE KEY-----/;

const KINDS: Record<string, string> = {
  OPENSSH: 'OpenSSH',
  RSA: 'RSA',
  EC: 'EC',
  DSA: 'DSA',
  ENCRYPTED: 'PKCS#8 (encrypted)',
  '': 'PrivateKey',
};

/** Private keys found in `dir` (empty when the dir is missing/unreadable), sorted by name. */
export async function scanPrivateKeys(dir: string): Promise<ScannedKey[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: ScannedKey[] = [];
  for (const name of [...entries].sort()) {
    if (name.endsWith('.pub') || name.endsWith('.bak')) continue;
    const path = join(dir, name);
    try {
      const head = (await readFile(path, 'utf8')).slice(0, 256);
      const m = head.match(HEADER_RE);
      if (m) out.push({ path, name, kind: KINDS[m[1] ?? ''] ?? m[1] });
    } catch {
      // directory or unreadable — not a key
    }
  }
  return out;
}
