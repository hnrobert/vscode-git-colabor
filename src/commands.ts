import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliClient } from './cli/CliClient.js';
import type { GitApi } from './git-ext/GitApi.js';
import type { Secrets } from './secrets/Secrets.js';
import type { IdentityTreeProvider } from './tree/IdentityTreeProvider.js';
import type { DiagnosticJson, IdentityJson, JsonResult } from './types.js';

export type CommandDeps = {
  cli: CliClient;
  git: GitApi;
  secrets: Secrets;
  log: vscode.LogOutputChannel;
  provider?: IdentityTreeProvider;
};

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
  reg('gitColabor.useIdentity', () => useIdentity(deps).then(refresh));
  reg('gitColabor.addIdentity', () => addIdentity(deps).then(refresh));
  reg('gitColabor.removeIdentity', () => removeIdentity(deps).then(refresh));
  reg('gitColabor.logoutIdentity', () => logoutIdentity(deps).then(refresh));
  reg('gitColabor.selectCoAuthors', () => selectCoAuthors(deps).then(refresh));
  reg('gitColabor.soloCoAuthors', () => soloCoAuthors(deps).then(refresh));
  reg('gitColabor.addCoAuthor', () => addCoAuthor(deps).then(refresh));
  reg('gitColabor.suggestCoAuthors', () => notImplemented(deps, 'suggestCoAuthors', 'M5'));
  reg('gitColabor.openCoAuthorsFile', () => openCoAuthorsFile());
  reg('gitColabor.revertRepo', () => revertRepo(deps).then(refresh));
  reg('gitColabor.showAudit', () => showAudit(deps));
  reg('gitColabor.reload', async () => {
    await refresh();
    vscode.window.showInformationMessage('Git Colabor: reloaded.');
  });
  reg('gitColabor.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:hnrobert.vscode-git-colabor'),
  );

  // Tree-item click targets (invoked with an argument from the TreeItem command).
  reg('gitColabor._useIdentityById', (id) => useIdentityById(deps, String(id)));
  reg('gitColabor._addCoAuthor', (key) => addCoAuthorByKey(deps, String(key)));
  reg('gitColabor._removeCoAuthor', (email) => removeCoAuthorByEmail(deps, String(email)));
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
  await run(deps, ['identity', 'use', identity.id, '--source', 'ext'], { cwd });
}

async function useIdentityById(deps: CommandDeps, id: string): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  await run(deps, ['identity', 'use', id, '--source', 'ext'], { cwd });
}

async function addIdentity(deps: CommandDeps): Promise<void> {
  const name = await vscode.window.showInputBox({ prompt: 'Identity name', placeHolder: 'Alice Example' });
  if (!name) return;
  const email = await vscode.window.showInputBox({ prompt: 'Identity email', placeHolder: 'alice@example.com' });
  if (!email) return;
  const key = await vscode.window.showInputBox({ prompt: 'SSH private key path (optional)', placeHolder: '~/.ssh/id_ed25519' });
  const pc = await vscode.window.showInputBox({ prompt: 'Passphrase command (optional)', placeHolder: 'op read "op://Private/ssh/pass"' });
  const args = ['identity', 'add', '--name', name, '--email', email];
  if (key && key.trim()) args.push('--key', key.trim());
  if (pc && pc.trim()) args.push('--passphrase-command', pc.trim());
  await run(deps, args);
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
  await run(deps, ['identity', 'rm', identity.id]);
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

async function selectCoAuthors(deps: CommandDeps): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const data = await run<{
    available: { key: string; name: string; email: string }[];
    selected: { key: string; name: string; email: string }[];
  }>(deps, ['identity', 'status'], { cwd });
  if (!data) return;
  const selectedKeys = new Set(data.selected.map((s) => s.key));
  const picks = [...data.available, ...data.selected].map((a) => ({
    label: a.name,
    description: a.email,
    picked: selectedKeys.has(a.key),
    key: a.key,
  }));
  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select co-authors for this repo',
    canPickMany: true,
  });
  if (!chosen) return;
  const keys = chosen.map((c) => c.key);
  if (keys.length === 0) await run(deps, ['coauthor', 'solo'], { cwd });
  else await run(deps, ['coauthor', 'use', ...keys], { cwd });
}

async function soloCoAuthors(deps: CommandDeps): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  await run(deps, ['coauthor', 'solo'], { cwd });
}

async function addCoAuthor(deps: CommandDeps): Promise<void> {
  const initials = await vscode.window.showInputBox({ prompt: 'Co-author initials/key', placeHolder: 'jd' });
  if (!initials) return;
  const name = await vscode.window.showInputBox({ prompt: 'Co-author name', placeHolder: 'Jane Doe' });
  if (!name) return;
  const email = await vscode.window.showInputBox({ prompt: 'Co-author email', placeHolder: 'jane@example.com' });
  if (!email) return;
  await run(deps, ['coauthor', 'add', initials, name, email]);
}

async function addCoAuthorByKey(deps: CommandDeps, key: string): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const selected = deps.provider?.current?.selected ?? [];
  const keys = [...new Set([...selected.map((s) => s.key), key])];
  await run(deps, ['coauthor', 'use', ...keys], { cwd });
}

async function removeCoAuthorByEmail(deps: CommandDeps, email: string): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const selected = deps.provider?.current?.selected ?? [];
  const remaining = selected.filter((s) => s.email !== email).map((s) => s.key);
  if (remaining.length > 0) await run(deps, ['coauthor', 'use', ...remaining], { cwd });
  else await run(deps, ['coauthor', 'solo'], { cwd });
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
  await run(deps, ['identity', 'revert'], { cwd });
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
