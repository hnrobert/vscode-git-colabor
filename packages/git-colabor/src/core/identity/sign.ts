import { getEffectiveConfig, setConfig, unsetConfig } from '../git/config.js';
import { topLevel, insideWorkTree } from '../git/rev.js';
import { getIdentity, getKeyBinding, idOf, setSignCommits } from './map.js';
import { keyUsable } from './keys.js';
import { keyInAgent } from './agent.js';
import { appendAudit } from '../logging/audit.js';
import { Errors } from '../errors.js';
import { dataDir } from '../paths.js';
import { ensureAskpassWrapper } from './apply.js';
import { listSigningKeys } from './gpg.js';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Identity, Source } from '../types.js';

async function safeTopLevel(cwd?: string): Promise<string | undefined> {
  try {
    return await topLevel(cwd);
  } catch {
    return undefined;
  }
}

/**
 * Create the signing wrapper: a shell script that execs `ssh-keygen` with
 * SSH_ASKPASS pointing at our askpass helper. git invokes `gpg.ssh.program`
 * for every commit-signing operation, so the passphrase is fetched from the
 * extension's session store without prompting the user each time.
 *
 * The wrapper also extracts `-f <signingKey>` from its own argv and exports
 * it as GIT_COLABOR_SIGNING_KEY: some OpenSSH builds (notably Ubuntu's
 * ssh-keygen signing path) invoke the askpass with a BARE "Enter passphrase:"
 * prompt — no key path — so the helper cannot fingerprint the key from the
 * prompt and needs this side channel instead.
 */
export async function ensureSignWrapper(askpassScriptPath?: string): Promise<string> {
  const wrapperPath = join(dataDir(), 'sign-wrapper.sh');
  const askpass = askpassScriptPath ? await ensureAskpassWrapper(askpassScriptPath) : join(dataDir(), 'askpass-wrapper.sh');
  const content = [
    '#!/bin/sh',
    '# extract -f <key> so the askpass helper can fingerprint it even when',
    '# the prompt carries no key path (bare "Enter passphrase:" on some OpenSSH)',
    'signkey=',
    'prev=',
    'for a in "$@"; do',
    '  if [ "$prev" = "-f" ]; then signkey="$a"; break; fi',
    '  prev="$a"',
    'done',
    `SSH_ASKPASS="${askpass}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 GIT_COLABOR_SIGNING_KEY="$signkey" exec ssh-keygen "$@"`,
    '',
  ].join('\n');
  if (existsSync(wrapperPath)) {
    const existing = await readFile(wrapperPath, 'utf8');
    if (existing === content) return wrapperPath;
  }
  await writeFile(wrapperPath, content, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  return wrapperPath;
}

/**
 * The `user.signingKey` value for an identity's key. `ssh-keygen -Y sign`
 * with a PRIVATE key path loads the file (askpass prompt for encrypted keys —
 * it never consults ssh-agent); with a PUBLIC key path it looks the key up in
 * ssh-agent instead. So when the key is agent-held and the `.pub` sibling
 * exists, sign via the public half — no passphrase involved.
 */
async function signingKeyPath(sshKeyPath: string, fingerprint?: string): Promise<string> {
  if (fingerprint && (await keyInAgent(fingerprint))) {
    const pub = `${sshKeyPath}.pub`;
    if (existsSync(pub)) return pub;
  }
  return sshKeyPath;
}

/** What an identity signs with: its sign-key preference (GPG wins, else the push key's SSH). */
export type SigningConfig = { format: 'openpgp' | 'ssh'; key: string };

async function signingConfigFor(identity: Identity): Promise<SigningConfig | undefined> {
  const binding = await getKeyBinding(idOf(identity.name, identity.email));
  if (binding.signKey) {
    return binding.signKey.format === 'openpgp'
      ? { format: 'openpgp', key: binding.signKey.key }
      : { format: 'ssh', key: await signingKeyPath(binding.signKey.path, binding.signKey.fingerprint) };
  }
  if (binding.pushKey && (await keyUsable(binding.pushKey.path))) {
    return { format: 'ssh', key: await signingKeyPath(binding.pushKey.path, binding.pushKey.fingerprint) };
  }
  return undefined;
}

/**
 * Point the signing config at an identity's key (GPG or SSH), repo-local by
 * default (`--config-scope global` writes the global file instead — signing
 * then follows that identity in every repo on the machine).
 * Writes nothing and returns undefined when the identity has no key to sign
 * with. SSH signing goes through the askpass sign wrapper when driven by the
 * extension; OpenPGP keeps the user's own `gpg.program` / gpg-agent pinentry.
 */
export async function writeIdentitySigning(
  identity: Identity,
  cwd?: string,
  askpassScriptPath?: string,
  scope: 'local' | 'global' = 'local',
): Promise<SigningConfig | undefined> {
  const cfg = await signingConfigFor(identity);
  if (!cfg) return undefined;
  await setConfig('commit.gpgsign', 'true', scope, cwd);
  await setConfig('gpg.format', cfg.format, scope, cwd);
  await setConfig('user.signingKey', cfg.key, scope, cwd);
  if (cfg.format === 'ssh' && askpassScriptPath) {
    await setConfig('gpg.ssh.program', await ensureSignWrapper(askpassScriptPath), scope, cwd);
  } else if (cfg.format === 'openpgp') {
    await unsetConfig('gpg.ssh.program', scope, cwd);
  }
  return cfg;
}

/**
 * Turn commit signing OFF at the given scope — for real. Drops that scope's
 * signing keys unconditionally (no managed flag anymore: whoever turned
 * signing on, off means it does not sign) and pins `commit.gpgsign=false`
 * there whenever a lower scope would still sign.
 */
export async function disableSigning(cwd?: string, scope: 'local' | 'global' = 'local'): Promise<void> {
  await unsetConfig('gpg.format', scope, cwd);
  await unsetConfig('user.signingKey', scope, cwd);
  await unsetConfig('gpg.ssh.program', scope, cwd);
  await unsetConfig('commit.gpgsign', scope, cwd);
  if ((await getEffectiveConfig('commit.gpgsign', cwd, 'bool'))?.value === 'true') {
    await setConfig('commit.gpgsign', 'false', scope, cwd);
  }
}

/**
 * Toggle commit signing for a repo with an identity's key (the right-click
 * "Sign Commits with …" / "Stop Signing" actions). Opt-in: `identity use`
 * never turns signing on by itself; while enabled it re-binds to each newly
 * applied identity's key. Off always means "this repo does not sign",
 * whatever global/system config says.
 */
export async function setCommitSigning(opts: {
  source: Source;
  cwd?: string;
  /** required to turn signing on; informational (audit) when turning it off */
  id?: string;
  on: boolean;
  askpassScriptPath?: string;
}): Promise<{ signing: boolean; format?: SigningConfig['format']; key?: string }> {
  if (!(await insideWorkTree(opts.cwd))) throw Errors.notARepo(opts.cwd);

  if (!opts.on) {
    // no managed flag anymore — off always means fully off
    await disableSigning(opts.cwd);
    // off also drops the per-identity preference — switching back to this
    // identity must NOT silently re-enable what was stopped
    if (opts.id) await setSignCommits(opts.id, false);
    await appendAudit({ action: 'identity.sign', source: opts.source, identity: opts.id, repo: await safeTopLevel(opts.cwd), result: 'ok', message: 'signing off' });
    return { signing: false };
  }

  if (!opts.id) throw Errors.usage('git colabor identity sign <id>');
  const identity = await getIdentity(opts.id);
  const cfg = await writeIdentitySigning(identity, opts.cwd, opts.askpassScriptPath);
  if (!cfg) throw Errors.usage(`identity "${identity.name}" has no usable SSH or GPG key to sign with`);
  // remember the choice: every later apply of this identity signs again
  await setSignCommits(opts.id, true);
  await appendAudit({
    action: 'identity.sign',
    source: opts.source,
    identity: opts.id,
    identityName: identity.name,
    fingerprint: cfg.key,
    repo: await safeTopLevel(opts.cwd),
    result: 'ok',
    message: `signing on (${cfg.format})`,
  });
  return { signing: true, format: cfg.format, key: cfg.key };
}

/** The EFFECTIVE signing state of a repo — what `git commit` will actually do. */
export type SigningStatus = {
  /** effective commit.gpgsign across every scope */
  enabled: boolean;
  /** effective user.signingKey (null: OpenPGP then picks a key by committer email) */
  key: string | null;
  /** effective gpg.format (git's default is openpgp) */
  format: string;
  /** scope commit.gpgsign resolved from (local / global / system / …); null when unset everywhere */
  scope: string | null;
  /** the file that value lives in */
  origin: string | null;
  /** colabor's own repo-local signing (`identity sign`) is on */
  managed: boolean;
  /** OpenPGP only: emails on the signing key, so the UI can flag a key that is not the committer's */
  keyEmails?: string[];
};

export async function signingStatus(cwd: string | undefined): Promise<SigningStatus> {
  const [sign, format, key] = await Promise.all([
    getEffectiveConfig('commit.gpgsign', cwd, 'bool'),
    getEffectiveConfig('gpg.format', cwd),
    getEffectiveConfig('user.signingKey', cwd),
  ]);
  const status: SigningStatus = {
    enabled: sign?.value === 'true',
    key: key?.value || null,
    format: format?.value || 'openpgp',
    scope: sign?.scope ?? null,
    origin: sign?.origin ?? null,
    managed: sign?.scope === 'local',
  };
  if (status.enabled && status.format === 'openpgp' && status.key) {
    // best effort: no gpg / unknown key just leaves the owner unknown
    const emails = (await listSigningKeys(cwd, status.key).catch(() => [])).flatMap((k) => k.emails);
    if (emails.length > 0) status.keyEmails = emails;
  }
  return status;
}
