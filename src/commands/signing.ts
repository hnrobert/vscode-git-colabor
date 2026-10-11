import * as vscode from 'vscode';
import { rowIdentityId, run, type CommandDeps } from './shared.js';
import { describeSigning, identitySigningKey, signingMatch } from '../session/signing.js';
import type { GpgKeyJson, IdentityJson } from '../types.js';

/**
 * Commit signing follows the identity's layer. A repo-wide identity ("Use
 * for All Windows", written to repo config) signs through repo config via
 * the CLI; otherwise — a window identity, or none at all — signing lives in
 * THIS window's env injection and no config file is written. Returns the
 * repo-wide identity's id when that layer applies.
 */
function repoLayerIdentity(deps: CommandDeps): string | undefined {
  return deps.session.active() ? undefined : deps.provider?.current?.activeIdentity?.id;
}

/** Run a CLI command in every session repo (identity config is session-wide). */
async function inEveryRepo(deps: CommandDeps, args: string[]): Promise<boolean> {
  const roots = deps.git.repoRoots;
  let ok = roots.length > 0;
  for (const root of roots) {
    if ((await run(deps, args, { cwd: root })) === undefined) ok = false;
  }
  return ok;
}

/**
 * Stop signing at the identity's layer. Off means OFF: repo layer pins
 * `commit.gpgsign=false` when global/system config would still sign, the
 * window layer injects it — just dropping our keys would fall back to e.g.
 * a personal GPG key in ~/.gitconfig and keep signing.
 */
export async function stopCommitSigning(deps: CommandDeps): Promise<void> {
  const before = deps.provider?.current?.signing;
  const repoId = repoLayerIdentity(deps);
  if (repoId) {
    if (!(await inEveryRepo(deps, ['identity', 'sign', repoId, '--off']))) return;
  } else {
    await deps.session.setSigning(false);
  }
  // name the config that was signing without colabor — it keeps signing
  // everywhere else (other windows, terminal) and surprises users
  const inherited = before?.scope === 'window' ? before.below : before;
  const note =
    inherited?.enabled && !inherited.managed
      ? ` — overrides commit.gpgsign=true from ${inherited.scope} config${inherited.origin ? ` (${inherited.origin})` : ''}`
      : '';
  vscode.window.showInformationMessage(`Git Colabor: commit signing off (${repoId ? 'repo config' : 'this window'})${note}.`);
  await deps.provider?.reload();
}

/**
 * Sign with an identity's SSH key, or (`gpg`) a GPG key picked now. The
 * choice is bound to the identity — GPG key set, or cleared for SSH — so a
 * later identity switch re-binds signing to the right key.
 */
export async function startCommitSigning(deps: CommandDeps, item: unknown, kind: 'ssh' | 'gpg'): Promise<void> {
  const id = rowIdentityId(item);
  if (!id) {
    deps.log.warn('signing command invoked without an identity payload');
    return;
  }
  const data = await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']);
  let identity = data?.identities.find((i) => i.id === id);
  if (!identity) return;
  if (kind === 'ssh' && (!identity.hasKey || !identity.sshKeyPath)) {
    vscode.window.showWarningMessage(`Git Colabor: "${identity.name}" has no SSH key to sign with.`);
    return;
  }
  const gpgKey = kind === 'gpg' ? await pickGpgKey(deps, identity) : undefined;
  if (kind === 'gpg' && !gpgKey) return;
  if (gpgKey !== identity.gpgKey) {
    const args = gpgKey ? ['identity', 'set', id, '--gpg-key', gpgKey] : ['identity', 'set', id, '--no-gpg-key'];
    if ((await run(deps, args, { cwd: deps.git.selectedRepoRoot() })) === undefined) return;
    identity = { ...identity, gpgKey };
  }
  await signWithIdentityKey(deps, identity);
}

/** Turn signing on with the identity's own key at the identity's layer. */
async function signWithIdentityKey(deps: CommandDeps, identity: IdentityJson): Promise<void> {
  if (!identity.gpgKey && !(await ensurePassphrase(deps, identity))) return;
  const keyKind = identity.gpgKey ? 'GPG' : 'SSH';
  if (repoLayerIdentity(deps) === identity.id) {
    if (!(await inEveryRepo(deps, ['identity', 'sign', identity.id]))) return;
    vscode.window.showInformationMessage(
      `Git Colabor: commits sign with "${identity.name}"'s ${keyKind} key (repo config — every window).`,
    );
  } else {
    // signing implies the window identity (the injection lives on it);
    // re-applying also refreshes its key binding
    await deps.session.apply(identity);
    await deps.session.setSigning(true);
    vscode.window.showInformationMessage(
      `Git Colabor: commits in THIS WINDOW sign with "${identity.name}"'s ${keyKind} key — repo config untouched.`,
    );
  }
  await deps.provider?.reload();
}

/**
 * Encrypted SSH key not in the agent and nothing banked → collect the
 * passphrase now; commit-time signing reads it through the askpass bridge.
 */
async function ensurePassphrase(deps: CommandDeps, identity: IdentityJson): Promise<boolean> {
  const fp = identity.sshKeyFingerprint;
  if (!identity.keyEncrypted || !fp || identity.inAgent || deps.sessionPassphrases.has(fp)) return true;
  const pass = await vscode.window.showInputBox({
    prompt: `Passphrase for key ${fp}`,
    password: true,
    placeHolder: 'session only',
  });
  if (pass === undefined) return false;
  deps.sessionPassphrases.set(fp, pass);
  const v = await deps.cli.run(['identity', 'agent', identity.id, '--verify']);
  if (v.ok && (v.data as { verified?: boolean }).verified === true) return true;
  deps.sessionPassphrases.delete(fp);
  vscode.window.showWarningMessage('Git Colabor: wrong passphrase — signing not enabled.');
  return false;
}

/** Pick a secret GPG key; keys carrying the identity's email come first. */
async function pickGpgKey(deps: CommandDeps, identity: IdentityJson): Promise<string | undefined> {
  const data = await run<{ keys: GpgKeyJson[] }>(deps, ['identity', 'gpg-keys'], { cwd: deps.git.selectedRepoRoot() });
  if (!data) return undefined;
  if (data.keys.length === 0) {
    vscode.window.showWarningMessage('Git Colabor: no secret GPG key usable for signing (see `gpg --list-secret-keys`).');
    return undefined;
  }
  const email = identity.email.toLowerCase();
  const items = data.keys
    .map((k) => {
      const owned = k.emails.includes(email);
      return {
        label: `${owned ? '$(pass-filled)' : '$(key)'} ${k.uids[0] ?? k.keyId}`,
        description: k.keyId,
        detail: owned
          ? `belongs to ${identity.email}`
          : `no user id with ${identity.email} — hosts like GitHub will show the commits as Unverified`,
        fingerprint: k.fingerprint,
        owned,
      };
    })
    .sort((a, b) => Number(b.owned) - Number(a.owned));
  const sel = await vscode.window.showQuickPick(items, { placeHolder: `GPG key to sign "${identity.name}"'s commits with` });
  return sel?.fingerprint;
}

/**
 * After a window identity switch: when commits would now be signed with a
 * key that is not this identity's (typically a personal GPG key inherited
 * from ~/.gitconfig), say so once and offer the fix.
 */
export async function warnSigningMismatch(deps: CommandDeps): Promise<void> {
  const s = await deps.provider?.reload();
  const active = s?.activeIdentity;
  if (!s || !active) return;
  const row = s.identities.find((i) => i.id === active.id) ?? active;
  if (signingMatch(s.signing, row, s.identities) !== 'mismatch') return;
  const sign = `Sign with ${row.name}'s Key`;
  const stop = 'Stop Signing';
  const choice = await vscode.window.showWarningMessage(
    `Git Colabor: "${row.name}"'s commits would be signed with ${describeSigning(s.signing)} — not their key, so they show as Unverified.`,
    ...(identitySigningKey(row) ? [sign] : []),
    stop,
  );
  if (choice === stop) await stopCommitSigning(deps);
  else if (choice === sign) await signWithIdentityKey(deps, row);
}
