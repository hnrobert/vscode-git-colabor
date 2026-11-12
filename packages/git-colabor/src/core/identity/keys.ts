import { resolve } from 'node:path';
import { runBin } from '../git/exec.js';
import { AppError } from '../errors.js';

const FP_RE = /SHA256:[A-Za-z0-9+/=]+/;

/** Fingerprint of a key file via `ssh-keygen -lf` → "SHA256:…". */
export async function fingerprintOfFile(path: string): Promise<string> {
  const r = await runBin('ssh-keygen', ['-lf', path]);
  if (r.exitCode !== 0) {
    throw new AppError({
      code: 'KEY_READ_FAILED',
      message: `cannot read key fingerprint: ${r.stderr.trim() || 'ssh-keygen failed'}`,
    });
  }
  const m = r.stdout.match(FP_RE);
  if (!m) throw new AppError({ code: 'KEY_READ_FAILED', message: `unparseable ssh-keygen output: ${r.stdout}` });
  return m[0];
}

/**
 * Whether a key is passphrase-protected. Probe: `ssh-keygen -y -P "" -f key`
 * exits 0 for an unencrypted key, non-zero for an encrypted (or unreadable) one.
 */
export async function isEncrypted(path: string): Promise<boolean> {
  const r = await runBin('ssh-keygen', ['-y', '-P', '', '-f', path]);
  return r.exitCode !== 0;
}

/** Whether a referenced key is still usable (present + parseable fingerprint). */
export async function keyUsable(path: string): Promise<boolean> {
  try {
    await fingerprintOfFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reference a key at its SOURCE path — no copy is made, the file is never
 * modified, and the identity stores the absolute path. Broken references
 * (moved/deleted/rotated source) are detected at `use` time and degrade to
 * a key-less apply (see apply.ts).
 */
export async function importKey(sourcePath: string): Promise<{ path: string; fingerprint: string; encrypted: boolean }> {
  const fingerprint = await fingerprintOfFile(sourcePath); // throws KEY_READ_FAILED when unreadable
  const encrypted = await isEncrypted(sourcePath);
  return { path: resolve(sourcePath), fingerprint, encrypted };
}
