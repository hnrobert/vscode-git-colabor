import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitDir } from '../git/rev.js';
import { atomicWriteJson } from '../io.js';
import type { RepoState } from '../types.js';

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
