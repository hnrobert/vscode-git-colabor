import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { rowIdentityId, run, type CommandDeps } from './shared.js';
import { signingMismatchAction } from '../config.js';
import { describeSigning, identitySigningKey, signingMatch } from '../session/signing.js';
import { globalConfigKeyPaths } from '../ssh/gitConfig.js';
import { scanPrivateKeys } from '../ssh/scanPrivateKeys.js';
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
    // window-layer off drops the per-identity preference too — switching
    // identities must not silently re-enable what was stopped
    const id = deps.provider?.current?.activeIdentity?.id ?? deps.session.get()?.id;
    if (id) await run(deps, ['identity', 'set', id, '--no-sign-commits'], { cwd: deps.git.selectedRepoRoot() });
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
 * Turn signing on for an identity. Two explicit choices:
 *  - `ssh` — an SSH key picked now (candidates include the identity's OWN
 *            auth key first, then store keys, ~/.ssh, and global-config
 *            keys), bound as the identity's dedicated sign key
 *  - `gpg` — a GPG key picked now, bound as the sign key
 * The binding is a PREFERENCE in the store — it re-applies on every later
 * use/session of this identity.
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
  const cwd = deps.git.selectedRepoRoot();

  if (kind === 'ssh') {
    const path = await pickSshKey(deps, identity);
    if (!path) return;
    if ((await run(deps, ['identity', 'set', id, '--sign-key', path], { cwd })) === undefined) return;
    const next = await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']);
    identity = next?.identities.find((i) => i.id === id) ?? { ...identity, signKey: { format: 'ssh', path, fingerprint: '' } };
  } else {
    const gpgKey = await pickGpgKey(deps, identity);
    if (!gpgKey) return;
    if (gpgKey !== identity.gpgKey) {
      if ((await run(deps, ['identity', 'set', id, '--gpg-key', gpgKey], { cwd })) === undefined) return;
      identity = { ...identity, signKey: { format: 'openpgp', key: gpgKey } };
    }
  }
  await signWithIdentityKey(deps, identity);
}

/**
 * Pick an SSH key to sign with. Candidates, in order: THIS identity's own
 * auth/sign keys, keys other store identities reference, private keys in
 * ~/.ssh, and keys referenced by the GLOBAL git config (`core.sshCommand
 * -i`, path-shaped `user.signingKey`) — those appear even when this repo's
 * local config shadows them.
 */
async function pickSshKey(deps: CommandDeps, identity: IdentityJson): Promise<string | undefined> {
  const [data, scanned, globalPaths] = await Promise.all([
    run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']),
    scanPrivateKeys(join(homedir(), '.ssh')),
    globalConfigKeyPaths(),
  ]);
  type Row = { label: string; description: string; detail: string; path: string; rank: number };
  const rows = new Map<string, Row>();
  const add = (path: string | undefined, owner: string, rank: number, detail = `referenced by ${owner}`): void => {
    if (!path || !existsSync(path) || rows.has(path)) return;
    rows.set(path, { label: `$(key) ${basename(path)}`, description: dirname(path), detail, path, rank });
  };
  // this identity's own keys come first — its auth key is one pick away
  add(identity.sshKeyPath, `${identity.name} (auth key)`, 0);
  add(identity.signKey?.format === 'ssh' ? identity.signKey.path : undefined, `${identity.name} (sign key)`, 0);
  for (const i of data?.identities ?? []) {
    if (i.id === identity.id) continue;
    add(i.sshKeyPath, i.name, 1);
    add(i.signKey?.format === 'ssh' ? i.signKey.path : undefined, i.name, 1);
  }
  for (const k of scanned) add(k.path, k.kind, 2, k.kind);
  for (const path of globalPaths) {
    if (!existsSync(path)) continue;
    if (!rows.has(path)) {
      rows.set(path, {
        label: `$(globe) ${basename(path)}`,
        description: dirname(path),
        detail: 'from global git config (not active in this repo)',
        path,
        rank: 3,
      });
    } else {
      rows.get(path)!.detail += ' · global git config';
    }
  }
  if (rows.size === 0) {
    vscode.window.showWarningMessage('Git Colabor: no SSH private key found (scan of ~/.ssh, the store, and global git config).');
    return undefined;
  }
  const sorted = [...rows.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const sel = await vscode.window.showQuickPick(sorted, { placeHolder: `SSH key to sign "${identity.name}"'s commits with` });
  return sel?.path;
}

/** Turn signing on with the identity's effective key at the identity's layer. */
async function signWithIdentityKey(deps: CommandDeps, identity: IdentityJson): Promise<void> {
  const signing = identitySigningKey(identity);
  if (!signing) {
    vscode.window.showWarningMessage(`Git Colabor: "${identity.name}" has no usable key to sign with.`);
    return;
  }
  if (signing.format === 'ssh' && !(await ensurePassphrase(deps, identity))) return;
  const keyKind = signing.format === 'openpgp' ? 'GPG' : 'SSH';
  const whose = identity.signKey && identity.signKey.format === 'ssh' && signing.format === 'ssh'
    ? `${identity.name}'s sign key`
    : `"${identity.name}"'s ${keyKind} key`;
  if (repoLayerIdentity(deps) === identity.id) {
    if (!(await inEveryRepo(deps, ['identity', 'sign', identity.id]))) return;
    vscode.window.showInformationMessage(`Git Colabor: commits sign with ${whose} (repo config — every window).`);
  } else {
    // signing implies the window identity (the injection lives on it);
    // re-applying also refreshes its key binding. Persist the preference so
    // switching away and back re-enables signing (repo AND session applies).
    await deps.session.apply(identity);
    await deps.session.setSigning(true);
    await run(deps, ['identity', 'set', identity.id, '--sign-commits'], { cwd: deps.git.selectedRepoRoot() });
    vscode.window.showInformationMessage(
      `Git Colabor: commits in THIS WINDOW sign with ${whose} — repo config untouched.`,
    );
  }
  await deps.provider?.reload();
}

/**
 * Encrypted SSH key not in the agent and nothing banked → collect the
 * passphrase now; commit-time signing reads it through the askpass bridge.
 * Uses the SIGN key's facts when one is bound, else the auth key's.
 */
async function ensurePassphrase(deps: CommandDeps, identity: IdentityJson): Promise<boolean> {
  const signKey = identity.signKey?.format === 'ssh' ? identity.signKey : undefined;
  const fp = signKey?.fingerprint || identity.sshKeyFingerprint;
  const encrypted = signKey ? !!signKey.encrypted : !!identity.keyEncrypted;
  if (!encrypted || !fp || identity.inAgent || deps.sessionPassphrases.has(fp)) return true;
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
 * After an identity switch: when commits would now be signed with a key that
 * is not this identity's (typically a personal GPG key inherited from
 * ~/.gitconfig), reconcile it. gitColabor.signingMismatchAction decides HOW:
 *  - "auto" (default) — signing silently follows the identity: a keyed one
 *    rebinds to its own key (same as picking "Switch to Their Key"), no dialog
 *  - "warn" — a reminder dialog: keep the current (foreign) key, switch to
 *    the identity's key, or stop signing
 */
export async function warnSigningMismatch(deps: CommandDeps): Promise<void> {
  const s = await deps.provider?.reload();
  const active = s?.activeIdentity;
  if (!s || !active) return;
  const row = s.identities.find((i) => i.id === active.id) ?? active;
  if (signingMatch(s.signing, row, s.identities) !== 'mismatch') return;
  const mine = identitySigningKey(row);
  if (signingMismatchAction() === 'auto') {
    // silently follow: rebind to the identity's key (a key-less identity has
    // no key to rebind to — its switch already turned signing off)
    if (mine) await signWithIdentityKey(deps, row);
    return;
  }
  const keep = 'Keep Current Key';
  const sign = 'Switch to Their Key';
  const stop = 'Stop Signing';
  const choice = await vscode.window.showWarningMessage(
    `Git Colabor: "${row.name}"'s commits would be signed with ${describeSigning(s.signing)} — not their key, so they show as Unverified.`,
    ...(mine ? [sign] : []),
    keep,
    stop,
  );
  if (choice === stop) await stopCommitSigning(deps);
  else if (choice === sign && mine) await signWithIdentityKey(deps, row);
  // Keep Current Key — reminder served, the foreign key stays
}
