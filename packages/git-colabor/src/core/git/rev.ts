import { resolve } from 'node:path';
import { git, gitRaw } from './exec.js';

export async function insideWorkTree(cwd?: string): Promise<boolean> {
  const r = await gitRaw(['rev-parse', '--is-inside-work-tree'], { cwd });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

/** Repo top-level; throws if not inside a work tree. */
export async function topLevel(cwd?: string): Promise<string> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd });
  return r.stdout.trim();
}

/** Absolute path to the repository's `.git` directory (works for submodules / worktrees). */
export async function gitDir(cwd?: string): Promise<string> {
  const r = await git(['rev-parse', '--git-dir'], { cwd });
  return resolve(cwd ?? process.cwd(), r.stdout.trim());
}

export async function isRepo(cwd?: string): Promise<boolean> {
  return insideWorkTree(cwd);
}

export async function headSha(cwd?: string): Promise<string | undefined> {
  const r = await gitRaw(['rev-parse', 'HEAD'], { cwd });
  if (r.exitCode !== 0) return undefined;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : undefined;
}
