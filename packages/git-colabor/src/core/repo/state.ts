import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitDir } from '../git/rev.js';
import { getConfig } from '../git/config.js';
import { atomicWriteJson } from '../io.js';
import type { Backups, RepoState } from '../types.js';

export async function statePath(cwd?: string): Promise<string> {
  return join(await gitDir(cwd), 'colabor', 'state.json');
}

export async function readState(cwd?: string): Promise<RepoState> {
  try {
    const p = await statePath(cwd);
    const txt = await readFile(p, 'utf8');
    return JSON.parse(txt) as RepoState;
  } catch {
    return { schemaVersion: 1 };
  }
}

export async function writeState(state: RepoState, cwd?: string): Promise<void> {
  const p = await statePath(cwd);
  await atomicWriteJson(p, state, 0o600);
}

/** Snapshot the repo's current identity-related git config (for backup on first touch). */
export async function readCurrentIdentityConfig(cwd?: string): Promise<Backups> {
  const [userName, userEmail, sshCommand, commitTemplate, commitGpgsign, gpgFormat, signingKey] = await Promise.all([
    getConfig('user.name', 'local', cwd),
    getConfig('user.email', 'local', cwd),
    getConfig('core.sshCommand', 'local', cwd),
    getConfig('commit.template', 'local', cwd),
    getConfig('commit.gpgsign', 'local', cwd),
    getConfig('gpg.format', 'local', cwd),
    getConfig('user.signingKey', 'local', cwd),
  ]);
  return { userName, userEmail, sshCommand, commitTemplate, commitGpgsign, gpgFormat, signingKey };
}

/**
 * On the tool's first touch of a repo (no `colabor.managed` marker AND no recorded backup),
 * capture the current `user.*`/`core.sshCommand`/`commit.template` (unused by the new architecture — see configClear).
 */
export async function captureBackupIfFirstTouch(cwd?: string): Promise<RepoState> {
  const managed = await getConfig('colabor.managed', 'local', cwd);
  const state = await readState(cwd);
  if (managed === 'true' || state.backups) return state;
  state.backups = await readCurrentIdentityConfig(cwd);
  await writeState(state, cwd);
  return state;
}
