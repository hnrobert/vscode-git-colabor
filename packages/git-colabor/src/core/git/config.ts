import { git, gitRaw } from './exec.js';

export type Scope = 'local' | 'global' | 'system';

function scopeArgs(scope?: Scope): string[] {
  return scope ? [`--${scope}`] : [];
}

/** Read a single git config value (first match across scopes). undefined if unset/missing. */
export async function getConfig(key: string, scope?: Scope, cwd?: string): Promise<string | undefined> {
  const r = await gitRaw(['config', ...scopeArgs(scope), '--get', key], { cwd });
  if (r.exitCode !== 0) return undefined;
  const v = r.stdout.trim();
  return v.length > 0 ? v : undefined;
}

export type ScopedValue = {
  value: string;
  /** git's scope name: local / global / system / worktree / command */
  scope: string;
  /** the file (or source) the winning value came from */
  origin: string;
};

/**
 * Effective value of a key across ALL scopes (last one wins, like git
 * itself) plus the scope and file it came from. `type: 'bool'` normalizes
 * yes/on/1 to "true". undefined if unset everywhere.
 */
export async function getEffectiveConfig(key: string, cwd?: string, type?: 'bool'): Promise<ScopedValue | undefined> {
  const r = await gitRaw(
    ['config', '--show-scope', '--show-origin', ...(type ? [`--type=${type}`] : []), '--get', key],
    { cwd },
  );
  if (r.exitCode !== 0) return undefined;
  const [scope = '', origin = '', ...value] = r.stdout.replace(/\n$/, '').split('\t');
  return { value: value.join('\t'), scope, origin: origin.replace(/^file:/, '') };
}

/** Read all values for a multi-valued key. '' if unset. */
export async function getAllConfig(key: string, scope?: Scope, cwd?: string): Promise<string> {
  const r = await gitRaw(['config', ...scopeArgs(scope), '--get-all', key], { cwd });
  return r.exitCode === 0 ? r.stdout.replace(/\s+$/, '') : '';
}

/** Set a git config value (arg-array; no shell interpolation). Overwrites any existing value. */
export async function setConfig(key: string, value: string, scope?: Scope, cwd?: string): Promise<void> {
  await git(['config', ...scopeArgs(scope), key, value], { cwd });
}

/** Append a value to a (possibly multi-valued) key via `git config --add`. */
export async function addConfigValue(key: string, value: string, scope?: Scope, cwd?: string): Promise<void> {
  await git(['config', ...scopeArgs(scope), '--add', key, value], { cwd });
}

/** Unset a key; idempotent (missing key is not an error). */
export async function unsetConfig(key: string, scope?: Scope, cwd?: string): Promise<void> {
  await gitRaw(['config', ...scopeArgs(scope), '--unset', key], { cwd });
}

/** Unset all values for a multi-valued key; idempotent. */
export async function unsetAllConfig(key: string, scope?: Scope, cwd?: string): Promise<void> {
  await gitRaw(['config', ...scopeArgs(scope), '--unset-all', key], { cwd });
}

/** Remove an entire section; idempotent. */
export async function removeSection(section: string, scope?: Scope, cwd?: string): Promise<void> {
  await gitRaw(['config', ...scopeArgs(scope), '--remove-section', section], { cwd });
}
