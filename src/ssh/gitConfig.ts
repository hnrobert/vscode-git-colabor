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

/** Clear the identity's git-config keys in the given scope (content-matched). */
export async function clearIdentityConfig(
  scope: 'repo' | 'global',
  identity: { name: string; email: string; sshKeyPath?: string; signKeyPath?: string; signGpgKey?: string },
  repoRoot: string | undefined,
): Promise<void> {
  const s = scope === 'repo' ? '--local' : '--global';
  const cwd = scope === 'repo' ? repoRoot : undefined;
  const [n, e, ssh, signKey] = await Promise.all([
    scoped(s, 'user.name', repoRoot),
    scoped(s, 'user.email', repoRoot),
    scoped(s, 'core.sshCommand', repoRoot),
    scoped(s, 'user.signingKey', repoRoot),
  ]);
  // EMAIL is the person key: when the scope's email is this person's, BOTH
  // fields come out together (a display-name difference between config and
  // the store row must not leave a half-identity behind)
  const emailIsThis = eq(e, identity.email);
  if (emailIsThis || eq(n, identity.name)) await capture(['config', s, '--unset', 'user.name'], cwd);
  if (emailIsThis) await capture(['config', s, '--unset', 'user.email'], cwd);
  // keys the identity left in this scope ride along with the logout
  const keyPaths = [identity.sshKeyPath, identity.signKeyPath].filter(Boolean).map((p) => p!.replace(/\.pub$/, ''));
  const usesKey = (v: string | undefined) => {
    if (!v) return false;
    if (keyPaths.some((p) => v.includes(p))) return true;
    // OpenPGP: a key id matches the tail of the bound fingerprint
    if (identity.signGpgKey && /^(0x)?[0-9a-f]{8,}!?$/i.test(v)) {
      const a = v.replace(/^0x/i, '').replace(/!$/, '').toUpperCase();
      const b = identity.signGpgKey.replace(/^0x/i, '').replace(/!$/, '').toUpperCase();
      if (a.endsWith(b) || b.endsWith(a)) return true;
    }
    return false;
  };
  if (usesKey(ssh)) await capture(['config', s, '--unset', 'core.sshCommand'], cwd);
  if (usesKey(signKey)) {
    await capture(['config', s, '--unset', 'user.signingKey'], cwd);
    await capture(['config', s, '--unset', 'gpg.format'], cwd);
    await capture(['config', s, '--unset', 'gpg.ssh.program'], cwd);
    await capture(['config', s, '--unset', 'commit.gpgsign'], cwd);
  }
}

/** Key paths referenced by the GLOBAL git config: `core.sshCommand -i <path>` and a path-shaped `user.signingKey`. */
export async function globalConfigKeyPaths(): Promise<string[]> {
  const [sshCommand, signingKey] = await Promise.all([scoped('--global', 'core.sshCommand'), scoped('--global', 'user.signingKey')]);
  const paths: string[] = [];
  const m = sshCommand?.match(/(?:^|\s)-i\s+(\S+)/);
  if (m) paths.push(m[1]);
  // a signing key that looks like a file path is an SSH key; fingerprints contain no '/'
  if (signingKey && signingKey.includes('/')) paths.push(signingKey.replace(/\.pub$/, ''));
  return paths;
}
