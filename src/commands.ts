import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pickRepository } from './scm/Sync.js';
import { appendTrailer, parseCoAuthors, removeTrailerOnce } from './scm/trailers.js';
import { setCoAuthorMemory, type MemoryScope } from './config.js';
import { scanPrivateKeys } from './ssh/scanPrivateKeys.js';
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

  // Tree-item click targets (invoked with arguments from the TreeItem command).
  reg('gitColabor._useIdentityById', (id) => useIdentityById(deps, String(id)));
  reg('gitColabor._toggleCoAuthor', (name, email) => toggleCoAuthor(deps, String(name), String(email)));

  // Right-click memory menu: save/remove an author per settings scope.
  // Menus pass the TreeItem (not command arguments), so read the payload.
  for (const scope of ['user', 'machine', 'workspace'] as const) {
    reg(`gitColabor._memorizeCoAuthor.${scope}`, (item) => memorizeFromItem(deps, item, scope, true));
    reg(`gitColabor._forgetCoAuthor.${scope}`, (item) => memorizeFromItem(deps, item, scope, false));
  }
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
  await applyUse(deps, identity.id, cwd);
}

async function useIdentityById(deps: CommandDeps, id: string): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  await applyUse(deps, id, cwd);
}

async function applyUse(deps: CommandDeps, id: string, cwd: string): Promise<void> {
  const r = await deps.cli.run(['identity', 'use', id, '--source', 'ext'], { cwd });
  if (!r.ok) {
    reportError(r);
    return;
  }
  const heldBy = (r.data as { conflict?: { heldBy?: { session: string } } | null })?.conflict?.heldBy;
  if (heldBy) {
    vscode.window.showWarningMessage(`Git Colabor: repo was held by ${heldBy.session}; overridden.`);
  }
}

type KeyPickItem = vscode.QuickPickItem & { path?: string; skip?: boolean };

/**
 * Pick the SSH private key for a new identity: prefills the expanded
 * `~/.ssh/` path and offers the private key files actually found there
 * (content-scanned); any other path can be typed instead, Esc skips.
 */
function pickPrivateKey(): Promise<string | undefined> {
  const dir = join(homedir(), '.ssh');
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<KeyPickItem>();
    pick.title = 'SSH private key';
    pick.placeholder = 'Pick a key from ~/.ssh, type another path, or Esc to skip';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    void scanPrivateKeys(dir).then((keys) => {
      const items: KeyPickItem[] = [
        ...keys.map((k) => ({ label: `$(key) ${k.name}`, description: k.path, detail: k.kind, path: k.path })),
        { label: '$(circle-slash) No SSH key (skip)', skip: true },
      ];
      pick.items = items;
      pick.activeItems = keys.length > 0 ? [items[0]] : [items[items.length - 1]];
    });
    pick.value = `${dir}/`;
    pick.onDidAccept(() => {
      const active = pick.activeItems[0];
      if (active?.skip) resolve(undefined);
      else if (active?.path) resolve(active.path);
      else {
        const typed = pick.value.trim();
        resolve(typed !== '' && !typed.endsWith('/') ? typed : undefined);
      }
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
}

async function addIdentity(deps: CommandDeps): Promise<void> {
  const name = await vscode.window.showInputBox({ prompt: 'Identity name', placeHolder: 'Alice Example' });
  if (!name) return;
  const email = await vscode.window.showInputBox({ prompt: 'Identity email', placeHolder: 'alice@example.com' });
  if (!email) return;
  const key = await pickPrivateKey();
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

/**
 * Toggle one co-author in the SCM commit-message input: append its trailer
 * (formatted into the trailer block at the end) when absent, remove one
 * occurrence when present. Keeps the CLI selection / commit template in
 * sync behind the scenes — but only when every trailer in the box maps to
 * the catalogue, so manually typed trailers are never clobbered.
 */
async function toggleCoAuthor(deps: CommandDeps, name: string, email: string): Promise<void> {
  const repo = pickRepository(deps.git);
  if (!repo) {
    vscode.window.showWarningMessage('Git Colabor: no git repository in the current workspace.');
    return;
  }
  const value = repo.inputBox.value;
  const present = parseCoAuthors(value).some((a) => a.email.toLowerCase() === email.toLowerCase());
  repo.inputBox.value = present ? removeTrailerOnce(value, email) : appendTrailer(value, { name, email });
  deps.log.info(`${present ? 'removed' : 'appended'} co-author trailer for ${name} <${email}>`);

  // best-effort CLI sync so `colabor.selected` + commit template follow the box
  const cwd = deps.git.selectedRepoRoot();
  if (!cwd) {
    deps.provider?.refresh();
    return;
  }
  const after = parseCoAuthors(repo.inputBox.value);
  const catalogue = [...(deps.provider?.current?.selected ?? []), ...(deps.provider?.current?.available ?? [])];
  const byEmail = new Map(catalogue.map((a) => [a.email.toLowerCase(), a.key]));
  const keys = after.map((a) => byEmail.get(a.email.toLowerCase()));
  if (keys.every((k): k is string => typeof k === 'string')) {
    if (keys.length === 0) await run(deps, ['coauthor', 'solo'], { cwd });
    else await run(deps, ['coauthor', 'use', ...new Set(keys)], { cwd });
  } else {
    deps.log.info('box has trailers outside the catalogue; leaving CLI selection unchanged');
  }
  deps.provider?.refresh();
}

/** Save or remove an identity in one settings-scope memory (user / machine / workspace). */
async function memorizeFromItem(deps: CommandDeps, item: unknown, scope: MemoryScope, save: boolean): Promise<void> {
  const author = (item as { payload?: { name: string; email: string } } | undefined)?.payload;
  if (!author) {
    deps.log.warn('memory command invoked without an identity payload');
    return;
  }
  const ok = await setCoAuthorMemory(scope, author, save);
  if (!ok) {
    vscode.window.showWarningMessage(`Git Colabor: "${scope}" settings need a newer VS Code.`);
    return;
  }
  deps.log.info(`${save ? 'saved' : 'removed'} identity ${author.name} <${author.email}> in ${scope} memory`);
  deps.provider?.refresh();
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
