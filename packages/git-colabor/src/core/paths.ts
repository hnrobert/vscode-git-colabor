import { homedir } from 'node:os';
import { join } from 'node:path';

/** Per-user data directory: `~/.config/git-colabor` (POSIX) / `%APPDATA%\git-colabor` (Windows). */
export function dataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'git-colabor');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'git-colabor');
}

export function mapPath(): string {
  return process.env.GIT_COLABOR_MAP ?? join(dataDir(), 'identities.json');
}

export function keysDir(): string {
  return join(dataDir(), 'keys');
}

export function auditLogPath(): string {
  return process.env.GIT_COLABOR_AUDIT_FILE ?? join(dataDir(), 'audit.log');
}

/** Filesystem-safe key file name for a fingerprint ("SHA256:abc…" → "SHA256_abc….key"). */
export function keyFileName(fingerprint: string): string {
  return fingerprint.replace(/[^A-Za-z0-9]+/g, '_') + '.key';
}

export function keyFilePath(fingerprint: string): string {
  return join(keysDir(), keyFileName(fingerprint));
}
