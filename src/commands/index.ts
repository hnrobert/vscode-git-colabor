import * as vscode from 'vscode';
import type { CommandDeps } from './shared.js';
import {
  addIdentity,
  forgetIdentity,
  hideThisIdentity,
  logoutIdentity,
  modifyIdentityField,
  rememberIdentity,
  removeIdentity,
  toggleAgentKey,
  useIdentity,
  useIdentityById,
} from './identity.js';
import { showHiddenIdentities, soloCoAuthors, toggleCoAuthor } from './coauthor.js';
import { doctor, revertRepo, showAudit } from './misc.js';
import { toggleCommitSigning } from './signing.js';

export type { CommandDeps } from './shared.js';

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const reg = (cmd: string, fn: (...args: unknown[]) => Promise<void> | Thenable<void> | void) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, (...args: unknown[]) => {
        Promise.resolve(fn(...args)).catch((e) =>
          deps.log.error(e instanceof Error ? e.message : String(e)),
        );
      }),
    );

  const refresh = async (): Promise<void> => {
    await deps.provider?.reload();
  };

  reg('gitColabor.doctor', () => doctor(deps));
  reg('gitColabor.useIdentity', (item) => useIdentity(deps, item).then(refresh));
  reg('gitColabor.addIdentity', () => addIdentity(deps).then(refresh));
  reg('gitColabor.removeIdentity', (item) => removeIdentity(deps, item).then(refresh));
  reg('gitColabor.logoutIdentity', (item) => logoutIdentity(deps, item).then(refresh));
  reg('gitColabor.soloCoAuthors', () => soloCoAuthors(deps).then(refresh));
  reg('gitColabor.showHiddenIdentities', () => showHiddenIdentities(deps).then(refresh));
  reg('gitColabor.revertRepo', () => revertRepo(deps).then(refresh));
  reg('gitColabor.showAudit', () => showAudit(deps));
  reg('gitColabor.reload', async () => {
    await refresh();
    vscode.window.showInformationMessage('Git Colabor: reloaded.');
  });
  reg('gitColabor.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:hnrobert.vscode-git-colabor'),
  );

  // Tree-item click targets (invoked with arguments from the TreeItem command).
  reg('gitColabor._useIdentityById', (id) => useIdentityById(deps, String(id)));
  reg('gitColabor._toggleCoAuthor', (name, email) => toggleCoAuthor(deps, String(name), String(email)));

  // Right-click remember/forget per scope (user = vscode config, machine = identities.json).
  reg('gitColabor._rememberOnUser', (item) => rememberIdentity(deps, item, 'user'));
  reg('gitColabor._forgetFromUser', (item) => forgetIdentity(deps, item, 'user'));
  reg('gitColabor._rememberOnMachine', (item) => rememberIdentity(deps, item, 'machine'));
  reg('gitColabor._forgetFromMachine', (item) => forgetIdentity(deps, item, 'machine'));

  // Machine-level hide (display + import); hide outranks remember. Restore
  // via "Show Hidden Identities…".
  reg('gitColabor._hideThisIdentity', (item) => hideThisIdentity(deps, item).then(refresh));

  // Right-click modify section (name / email).
  reg('gitColabor._changeIdentityName', (item) => modifyIdentityField(deps, item, 'name'));
  reg('gitColabor._changeIdentityEmail', (item) => modifyIdentityField(deps, item, 'email'));

  // Right-click key section: add (key-less identities) / change, agent, signing.
  reg('gitColabor._addIdentityKey', (item) => modifyIdentityField(deps, item, 'key', { allowClearKey: false }).then(refresh));
  reg('gitColabor._changeIdentityKey', (item) => modifyIdentityField(deps, item, 'key').then(refresh));

  // Opt-in SSH commit signing (toggle; applies to every session repo).
  reg('gitColabor._signCommitsWithKey', (item) => toggleCommitSigning(deps, item, true));
  reg('gitColabor._stopSigningCommits', (item) => toggleCommitSigning(deps, item, false));

  // Manual ssh-agent key management (the only path that loads keys into the agent).
  reg('gitColabor._loadKeyIntoAgent', (item) => toggleAgentKey(deps, item, 'load').then(refresh));
  reg('gitColabor._removeKeyFromAgent', (item) => toggleAgentKey(deps, item, 'remove').then(refresh));
}
