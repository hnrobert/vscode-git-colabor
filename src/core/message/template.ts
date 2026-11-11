import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { getConfig, setConfig } from '../git/config.js';
import { topLevel } from '../git/rev.js';
import { formatMessage } from './formatter.js';
import type { Author } from '../authors/types.js';

export function gitMessagePath(): string {
  return join(homedir(), '.gitmessage');
}

/**
 * Resolve the commit-message template path:
 *   env GIT_COLABOR_MESSAGE_PATH > local/global commit.template (against repo root) > ~/.gitmessage
 */
export async function resolveTemplatePath(templatePath?: string, cwd?: string): Promise<string> {
  if (process.env.GIT_COLABOR_MESSAGE_PATH) return resolve(process.env.GIT_COLABOR_MESSAGE_PATH);
  if (templatePath) return resolve(await topLevel(cwd), templatePath);
  return gitMessagePath();
}

/** Ensure a commit.template exists; set ~/.gitmessage globally if none is set anywhere. */
export async function ensureCommitTemplate(cwd?: string): Promise<void> {
  const has = await getConfig('commit.template', undefined, cwd);
  if (!has) await setConfig('commit.template', gitMessagePath(), 'global', cwd);
}

async function readMsg(p: string): Promise<string> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return '';
  }
}

async function writeMsg(p: string, txt: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, txt, 'utf8');
}

async function applyToTemplate(authors: Author[], cwd?: string): Promise<void> {
  const [localTpl, firstTpl] = await Promise.all([
    getConfig('commit.template', 'local', cwd),
    getConfig('commit.template', undefined, cwd),
  ]);
  const primaryPath = await resolveTemplatePath(firstTpl ?? undefined, cwd);
  await writeMsg(primaryPath, formatMessage(await readMsg(primaryPath), authors));
  // when a repo uses a local template, keep the global one in sync too
  if (localTpl) {
    const globalTpl = (await getConfig('commit.template', 'global', cwd)) ?? gitMessagePath();
    const globalPath = await resolveTemplatePath(globalTpl, cwd);
    await writeMsg(globalPath, formatMessage(await readMsg(globalPath), authors));
  }
}

export async function writeCoAuthorsToTemplate(authors: Author[], cwd?: string): Promise<void> {
  await applyToTemplate(authors, cwd);
}

export async function clearTemplate(cwd?: string): Promise<void> {
  await applyToTemplate([], cwd);
}
