import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliClient } from './cli/CliClient.js';
import type { GitApi } from './git-ext/GitApi.js';
import type { Secrets } from './secrets/Secrets.js';
import type { DiagnosticJson, IdentityJson, JsonResult } from './types.js';

export type CommandDeps = {
  cli: CliClient;
  git: GitApi;
  secrets: Secrets;
  log: vscode.LogOutputChannel;
};

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const reg = (cmd: string, fn: () => Promise<void> | Thenable<void> | void) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, () => {
        Promise.resolve(fn()).catch((e) => deps.log.error(e instanceof Error ? e.message : String(e)));
      }),
    );

  reg('gitColabor.doctor', () => doctor(deps));
  reg('gitColabor.useIdentity', () => useIdentity(deps));
  reg('gitColabor.addIdentity', () => addIdentity(deps));
  reg('gitColabor.removeIdentity', () => removeIdentity(deps));
  reg('gitColabor.logoutIdentity', () => logoutIdentity(deps));
  reg('gitColabor.selectCoAuthors', () => notImplemented(deps, 'selectCoAuthors', 'M4'));
  reg('gitColabor.soloCoAuthors', () => soloCoAuthors(deps));
  reg('gitColabor.addCoAuthor', () => addCoAuthor(deps));
  reg('gitColabor.suggestCoAuthors', () => notImplemented(deps, 'suggestCoAuthors', 'M4'));
  reg('gitColabor.openCoAuthorsFile', () => openCoAuthorsFile());
  reg('gitColabor.revertRepo', () => revertRepo(deps));
  reg('gitColabor.showAudit', () => showAudit(deps));
  reg('gitColabor.reload', async () => {
    deps.log.info('reload requested (TreeView ships in M4)');
    vscode.window.showInformationMessage('Git Colabor: reloaded.');
  });
  reg('gitColabor.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:hnrobert.vscode-git-colabor'),
  );
}

function requireRepo(deps: CommandDeps): string | undefined {
  const root = deps.git.selectedRepoRoot();
  if (!root) {
    vscode.window.showWarningMessage('Git Colabor: no git repository in the current workspace.');
    return undefined;
  }
  return root;
}

function reportError(r: Extract<JsonResult, { ok: false }>): void {
  const hints = r.error.hints && r.error.hints.length > 0 ? `\n${r.error.hints.join('\n')}` : '';
  vscode.window.showErrorMessage(`Git Colabor: ${r.error.message}${hints}`);
}

async function run<T = unknown>(deps: CommandDeps, args: string[], opts: { cwd?: string } = {}): Promise<T | undefined> {
  const r = await deps.cli.run(args, opts);
  if (!r.ok) {
    reportError(r);
    return undefined;
  }
  return r.data as T;
}

async function pickIdentity(deps: CommandDeps, placeholder: string): Promise<IdentityJson | undefined> {
  const data = await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']);
  if (!data) return undefined;
  if (data.identities.length === 0) {
    vscode.window.showInformationMessage('Git Colabor: no identities yet. Use "Add Identity…".');
    return undefined;
  }
  const items = data.identities.map((i) => ({
    label: `${i.isDefault ? '$(star) ' : ''}${i.name}`,
    description: i.email,
    detail: i.hasKey ? `key ${i.sshKeyFingerprint}` : 'no SSH key',
    identity: i,
  }));
  const sel = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
  return sel?.identity;
}

async function doctor(deps: CommandDeps): Promise<void> {
  const cwd = deps.git.selectedRepoRoot();
  const data = await run<{ diagnostics: DiagnosticJson[] }>(deps, ['identity', 'doctor'], { cwd });
  if (!data) return;
  const out = data.diagnostics.map((d) => `[${d.status}] ${d.check}${d.detail ? ` — ${d.detail}` : ''}`).join('\n');
  deps.log.info(`doctor:\n${out}`);
  const fails = data.diagnostics.filter((d) => d.status === 'fail').length;
  const choice = await vscode.window.showInformationMessage(
    `Git Colabor doctor: ${fails === 0 ? 'all checks OK' : `${fails} issue(s) found`}`,
    'Show Output',
  );
  if (choice === 'Show Output') deps.log.show();
}

async function useIdentity(deps: CommandDeps): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const identity = await pickIdentity(deps, 'Select identity to use in this repo');
  if (!identity) return;
  const data = await run<{ applied: { userName: string } }>(deps, ['identity', 'use', identity.id, '--source', 'ext'], { cwd });
  if (data) vscode.window.showInformationMessage(`Active identity: ${identity.name} <${identity.email}>`);
}

async function addIdentity(deps: CommandDeps): Promise<void> {
  const name = await vscode.window.showInputBox({ prompt: 'Identity name', placeHolder: 'Alice Example' });
  if (!name) return;
  const email = await vscode.window.showInputBox({ prompt: 'Identity email', placeHolder: 'alice@example.com' });
  if (!email) return;
  const key = await vscode.window.showInputBox({ prompt: 'SSH private key path (optional)', placeHolder: '~/.ssh/id_ed25519' });
  const pc = await vscode.window.showInputBox({
    prompt: 'Passphrase command (optional, e.g. op read "op://Private/ssh/pass")',
    placeHolder: 'op read ...',
  });
  const args = ['identity', 'add', '--name', name, '--email', email];
  if (key && key.trim()) args.push('--key', key.trim());
  if (pc && pc.trim()) args.push('--passphrase-command', pc.trim());
  const data = await run<{ identity: IdentityJson }>(deps, args);
  if (data) vscode.window.showInformationMessage(`Added identity "${data.identity.name}".`);
}

async function removeIdentity(deps: CommandDeps): Promise<void> {
  const identity = await pickIdentity(deps, 'Select identity to remove');
  if (!identity) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove identity "${identity.name}" and shred its key?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;
  const data = await run<{ removed: string }>(deps, ['identity', 'rm', identity.id]);
  if (data) vscode.window.showInformationMessage(`Removed identity ${data.removed}.`);
}

async function logoutIdentity(deps: CommandDeps): Promise<void> {
  const identity = await pickIdentity(deps, 'Select identity to logout (clear key)');
  if (!identity) return;
  const data = await run<{ cleared: { agent: boolean; keyfile: boolean } }>(deps, ['identity', 'logout', identity.id]);
  if (data) {
    vscode.window.showInformationMessage(
      `Logged out "${identity.name}" (agent: ${data.cleared.agent ? 'removed' : 'n/a'}, keyfile: ${data.cleared.keyfile ? 'shredded' : 'n/a'}).`,
    );
  }
}

async function soloCoAuthors(deps: CommandDeps): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const data = await run<{ selected: unknown[] }>(deps, ['coauthor', 'solo'], { cwd });
  if (data) vscode.window.showInformationMessage('Git Colabor: cleared co-authors.');
}

async function addCoAuthor(deps: CommandDeps): Promise<void> {
  const initials = await vscode.window.showInputBox({ prompt: 'Co-author initials/key', placeHolder: 'jd' });
  if (!initials) return;
  const name = await vscode.window.showInputBox({ prompt: 'Co-author name', placeHolder: 'Jane Doe' });
  if (!name) return;
  const email = await vscode.window.showInputBox({ prompt: 'Co-author email', placeHolder: 'jane@example.com' });
  if (!email) return;
  const data = await run<{ author: { name: string } }>(deps, ['coauthor', 'add', initials, name, email]);
  if (data) vscode.window.showInformationMessage(`Added co-author "${data.author.name}".`);
}

async function revertRepo(deps: CommandDeps): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const confirm = await vscode.window.showWarningMessage(
    'Revert this repo to its pre-tool identity state?',
    { modal: true },
    'Revert',
  );
  if (confirm !== 'Revert') return;
  const data = await run<{ hadBackup: boolean }>(deps, ['identity', 'revert'], { cwd });
  if (data) {
    vscode.window.showInformationMessage(
      data.hadBackup ? 'Git Colabor: reverted repo to pre-tool state.' : 'Git Colabor: repo was not managed.',
    );
  }
}

async function showAudit(deps: CommandDeps): Promise<void> {
  const data = await run<{ entries: unknown[] }>(deps, ['identity', 'audit', '--tail', '100']);
  if (!data) return;
  const content = (data.entries as object[]).map((e) => JSON.stringify(e)).join('\n') + '\n';
  const doc = await vscode.workspace.openTextDocument({ content, language: 'jsonl' });
  await vscode.window.showTextDocument(doc);
}

async function openCoAuthorsFile(): Promise<void> {
  const uri = vscode.Uri.file(join(homedir(), '.git-coauthors'));
  try {
    await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(uri);
  } catch {
    vscode.window.showWarningMessage(`Git Colabor: could not open ${uri.fsPath} (it may not exist yet).`);
  }
}

async function notImplemented(deps: CommandDeps, name: string, milestone: string): Promise<void> {
  deps.log.warn(`${name} ships in ${milestone}`);
  vscode.window.showInformationMessage(`Git Colabor: "${name}" is part of ${milestone}.`);
}
