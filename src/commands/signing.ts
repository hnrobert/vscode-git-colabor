import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { run, type CommandDeps } from './shared.js';
import type { IdentityJson } from '../types.js';

/**
 * Toggle opt-in SSH commit signing with an identity's key — WINDOW-scoped:
 * the signing config is env-injected next to the session identity, so
 * commits made in this window sign and NO repo (or global) git config is
 * ever written. Persistent repo-level signing remains available to pure
 * CLI users via `git colabor identity sign`.
 */
export async function toggleCommitSigning(deps: CommandDeps, item: unknown, on: boolean): Promise<void> {
  if (!on) {
    await deps.session.setSigning(undefined);
    vscode.window.showInformationMessage('Git Colabor: commit signing off (this window).');
    await deps.provider?.reload();
    return;
  }
  const id = (item as { payload?: { id?: string } } | undefined)?.payload?.id;
  if (!id) {
    deps.log.warn('signing command invoked without an identity payload');
    return;
  }
  const data = await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']);
  const identity = data?.identities.find((i) => i.id === id);
  if (!identity) return;
  if (!identity.hasKey || !identity.sshKeyPath) {
    vscode.window.showWarningMessage(`Git Colabor: "${identity.name}" has no SSH key to sign with.`);
    return;
  }
  // encrypted key not in the agent and nothing banked → collect the
  // passphrase now; commit-time signing reads it through the askpass bridge
  if (
    identity.keyEncrypted &&
    identity.sshKeyFingerprint &&
    !identity.inAgent &&
    !deps.sessionPassphrases.has(identity.sshKeyFingerprint)
  ) {
    const pass = await vscode.window.showInputBox({
      prompt: `Passphrase for key ${identity.sshKeyFingerprint}`,
      password: true,
      placeHolder: 'session only',
    });
    if (pass === undefined) return;
    deps.sessionPassphrases.set(identity.sshKeyFingerprint, pass);
    const v = await deps.cli.run(['identity', 'agent', id, '--verify']);
    const verified = v.ok ? (v.data as { verified?: boolean }).verified === true : false;
    if (!verified) {
      deps.sessionPassphrases.delete(identity.sshKeyFingerprint);
      vscode.window.showWarningMessage('Git Colabor: wrong passphrase — signing not enabled.');
      return;
    }
  }
  // signing implies the window identity (the injection lives on it)
  if (deps.session.get()?.id !== id) {
    await deps.session.apply(identity);
  }
  // agent-held keys sign via their public half (ssh-keygen -Y sign consults
  // the agent only when handed a public key path)
  const pub = `${identity.sshKeyPath}.pub`;
  const keyPath = identity.inAgent && existsSync(pub) ? pub : identity.sshKeyPath;
  await deps.session.setSigning(keyPath);
  vscode.window.showInformationMessage(
    `Git Colabor: commits in THIS WINDOW sign with "${identity.name}"'s key — repo config untouched.`,
  );
  await deps.provider?.reload();
}
