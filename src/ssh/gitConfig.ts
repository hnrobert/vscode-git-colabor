import { spawn } from 'node:child_process';

/**
 * Minimal git-config reader for the logout flow: which scopes currently
 * carry `user.name`/`user.email` matching the identity being logged out.
 * Pure node (no vscode imports), arg-array invocation — no shell, no
 * injection surface.
 */

export type ConfigScopeHit = {
  scope: 'repo' | 'global';
  name: string;
  email: string;
};

function capture(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', () => resolve({ code: 127, out: '', err: 'spawn failed' }));
    child.on('close', (c) => resolve({ code: c ?? 127, out, err }));
  });
}

async function scoped(scope: '--local' | '--global', key: string, cwd?: string): Promise<string | undefined> {
  const r = await capture(['config', scope, '--get', key], cwd);
  if (r.code !== 0) return undefined;
  const v = r.out.trim();
  return v.length > 0 ? v : undefined;
}

const eq = (a: string | undefined, b: string): boolean =>
  !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Where does this identity's name/email live in git config?
 * A scope counts only when BOTH name and email match there.
 */
export async function identityConfigScopes(
  identity: { name: string; email: string },
  repoRoot: string | undefined,
): Promise<ConfigScopeHit[]> {
  const hits: ConfigScopeHit[] = [];
  const [rn, re] = await Promise.all([scoped('--local', 'user.name', repoRoot), scoped('--local', 'user.email', repoRoot)]);
  if (eq(rn, identity.name) && eq(re, identity.email)) hits.push({ scope: 'repo', name: rn!, email: re! });
  const [gn, ge] = await Promise.all([scoped('--global', 'user.name'), scoped('--global', 'user.email')]);
  if (eq(gn, identity.name) && eq(ge, identity.email)) hits.push({ scope: 'global', name: gn!, email: ge! });
  return hits;
}

/** Clear user.name/user.email in the given scope (only when they match). */
export async function clearIdentityConfig(
  scope: 'repo' | 'global',
  identity: { name: string; email: string },
  repoRoot: string | undefined,
): Promise<void> {
  const s = scope === 'repo' ? '--local' : '--global';
  const [n, e] = await Promise.all([scoped(s, 'user.name', repoRoot), scoped(s, 'user.email', repoRoot)]);
  const cwd = scope === 'repo' ? repoRoot : undefined;
  if (eq(n, identity.name)) await capture(['config', s, '--unset', 'user.name'], cwd);
  if (eq(e, identity.email)) await capture(['config', s, '--unset', 'user.email'], cwd);
}
