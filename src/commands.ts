import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pickRepository } from './scm/Sync.js';
import { appendTrailer, parseCoAuthors, removeTrailerOnce } from './scm/trailers.js';
import { setCoAuthorMemory, type MemoryScope } from './config.js';
import { scanPrivateKeys } from './ssh/scanPrivateKeys.js';
import { parseGitHubQuery, searchCandidates, type IdentityCandidate } from './github/users.js';
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
  /** session-scoped key passphrases (fingerprint → passphrase); in-memory only */
  sessionPassphrases: Map<string, string>;
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
  reg('gitColabor.useIdentity', (item) => useIdentity(deps, item).then(refresh));
  reg('gitColabor.addIdentity', () => addIdentity(deps).then(refresh));
  reg('gitColabor.removeIdentity', (item) => removeIdentity(deps, item).then(refresh));
  reg('gitColabor.logoutIdentity', (item) => logoutIdentity(deps, item).then(refresh));
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
  for (const scope of ['user', 'workspace'] as const) {
    reg(`gitColabor._memorizeCoAuthor.${scope}`, (item) => memorizeFromItem(deps, item, scope, true));
    reg(`gitColabor._forgetCoAuthor.${scope}`, (item) => memorizeFromItem(deps, item, scope, false));
  }

  // Right-click modify section (name / email / key).
  reg('gitColabor._changeIdentityName', (item) => modifyIdentityField(deps, item, 'name'));
  reg('gitColabor._changeIdentityEmail', (item) => modifyIdentityField(deps, item, 'email'));
  reg('gitColabor._changeIdentityKey', (item) => modifyIdentityField(deps, item, 'key'));

  // Right-click hide section for identities imported from repo history.
  reg('gitColabor._hideIdentity.user', (item) => hideMemoryFromItem(deps, item, 'user'));
  reg('gitColabor._hideIdentity.workspace', (item) => hideMemoryFromItem(deps, item, 'workspace'));
  reg('gitColabor._hideIdentity.machine', (item) => hideMachineFromItem(deps, item));

  // Opt-in SSH commit signing (toggle; applies to every session repo).
  reg('gitColabor._signCommitsWithKey', (item) => toggleCommitSigning(deps, item, true));
  reg('gitColabor._stopSigningCommits', (item) => toggleCommitSigning(deps, item, false));
}

/**
 * Identity id from a tree-row invocation (context menus / inline buttons pass
 * the TreeItem); undefined when invoked from the palette or view title — the
 * caller should fall back to a quick pick then.
 */
function rowIdentityId(item: unknown): string | undefined {
  return (item as { payload?: { id?: string } } | undefined)?.payload?.id;
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

async function useIdentity(deps: CommandDeps, item?: unknown): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const rowId = rowIdentityId(item);
  if (rowId) {
    await applyUse(deps, rowId, cwd);
    return;
  }
  const identity = await pickIdentity(deps, 'Select identity to use in this repo');
  if (!identity) return;
  await applyUse(deps, identity.id, cwd);
}

async function useIdentityById(deps: CommandDeps, id: string): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  await applyUse(deps, id, cwd);
}

type UseResult = Extract<JsonResult, { ok: true }> | Extract<JsonResult, { ok: false }>;

/**
 * The use result has a key that did not load (encrypted key, agent missing,
 * legacy identities without the keyEncrypted flag) → prompt for a passphrase.
 * Returns the fingerprint to prompt for.
 */
function needsPassphrase(r: UseResult): string | undefined {
  if (!r.ok) return undefined;
  const d = r.data as {
    identity?: { hasKey?: boolean; sshKeyFingerprint?: string };
    keyLoaded?: { loaded: boolean } | null;
  };
  if (d.identity?.hasKey && d.identity.sshKeyFingerprint && d.keyLoaded && !d.keyLoaded.loaded) {
    return d.identity.sshKeyFingerprint;
  }
  return undefined;
}

/** "no ssh-agent running" — the key still works at push time via the askpass
 * prefix baked into core.sshCommand, so this is not a disable-worthy failure
 * once we hold the passphrase. */
function agentMissing(r: UseResult): boolean {
  if (!r.ok) return false;
  const d = r.data as { keyLoaded?: { message?: string; via?: string } | null };
  const text = `${d.keyLoaded?.message ?? ''} ${d.keyLoaded?.via ?? ''}`;
  return text.includes('Could not open a connection');
}

async function applyUse(deps: CommandDeps, id: string, cwd: string): Promise<void> {
  // one session, one identity configuration: apply to EVERY open repository
  const roots = deps.git.repoRoots.length > 0 ? deps.git.repoRoots : [cwd];
  const conflicts: string[] = [];
  const disabledRepos: string[] = [];

  const useIn = (root: string) => deps.cli.run(['identity', 'use', id, '--source', 'ext'], { cwd: root });

  for (const root of roots) {
    let r = await useIn(root);
    if (!r.ok) {
      reportError(r);
      continue;
    }
    // encrypted key that did not load → prompt once per key (this connection),
    // retry once; wrong passphrase / cancelled prompt / any other failure
    // disables the identity in this repo and leaves it identity-less
    let fp = needsPassphrase(r);
    if (fp && !deps.sessionPassphrases.has(fp)) {
      const pass = await vscode.window.showInputBox({
        prompt: `Passphrase for key ${fp}`,
        password: true,
        placeHolder: 'kept for this connection only — re-entered on reconnect',
      });
      if (pass === undefined) {
        await disableIdentityIn(deps, id, root);
        disabledRepos.push(root);
        continue;
      }
      deps.sessionPassphrases.set(fp, pass);
      r = await useIn(root); // retry with the fresh passphrase
      fp = needsPassphrase(r);
    }
    if (fp) {
      // no ssh-agent on the host → the agent load can never succeed, but the
      // passphrase still unlocks the key at push time via SSH_ASKPASS; treat
      // as usable. Anything else (wrong passphrase, other failures) disables.
      if (agentMissing(r) && deps.sessionPassphrases.has(fp)) {
        deps.log.info(`no ssh-agent on host — key ${fp} will unlock at push time via askpass`);
      } else {
        deps.sessionPassphrases.delete(fp); // wrong passphrase — drop it
        await disableIdentityIn(deps, id, root);
        disabledRepos.push(root);
        continue;
      }
    }
    const heldBy = (r.data as { conflict?: { heldBy?: { session: string } } | null })?.conflict?.heldBy;
    if (heldBy) conflicts.push(`${root}: ${heldBy.session}`);
  }

  if (disabledRepos.length > 0) {
    vscode.window.showWarningMessage(
      `Git Colabor: passphrase wrong or cancelled — identity disabled, repo left without an active identity (${disabledRepos.join(', ')}). Click the identity to retry.`,
    );
  }
  if (conflicts.length > 0) {
    vscode.window.showWarningMessage(`Git Colabor: overridden — held by ${conflicts.join(', ')}.`);
  }
}

/** Disable the identity and deactivate it in one repo (passphrase failure flow). */
async function disableIdentityIn(deps: CommandDeps, id: string, root: string): Promise<void> {
  const r = await deps.cli.run(['identity', 'disable', id], { cwd: root });
  if (!r.ok) reportError(r);
  else deps.log.warn(`identity ${id} disabled (repo ${root} left without an active identity)`);
}

type KeyPickItem = vscode.QuickPickItem & { path?: string; skip?: boolean; clear?: boolean };

/**
 * Pick the SSH private key for an identity: prefills the expanded `~/.ssh/`
 * path and offers the private key files actually found there
 * (content-scanned); any other path can be typed instead, Esc skips.
 * With `allowClear`, an extra entry returns `null` meaning "remove the key".
 */
function pickPrivateKey(allowClear = false): Promise<string | null | undefined> {
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
      if (allowClear) items.push({ label: '$(trash) Clear the key reference', clear: true });
      pick.items = items;
      pick.activeItems = keys.length > 0 ? [items[0]] : [items[items.length - 1]];
    });
    pick.value = `${dir}/`;
    pick.onDidAccept(() => {
      const active = pick.activeItems[0];
      if (active?.skip) resolve(undefined);
      else if (active?.clear) resolve(null);
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
  const source = await vscode.window.showQuickPick(
    [
      { label: '$(github) From GitHub…', description: 'search by profile URL, @username, or email', github: true },
      { label: '$(person-add) Custom identity…', description: 'name + email typed by hand', github: false },
    ],
    { placeHolder: 'Add identity — choose a source' },
  );
  if (!source) return;

  let name: string | undefined;
  let email: string | undefined;

  if (source.github) {
    const picked = await pickFromGitHub();
    if (!picked) return;
    name = picked.name;
    email = picked.email;
  } else {
    name = await vscode.window.showInputBox({ prompt: 'Identity name', placeHolder: 'Alice Example' });
    if (!name) return;
    email = await vscode.window.showInputBox({ prompt: 'Identity email', placeHolder: 'alice@example.com' });
    if (!email) return;
  }
  await finishIdentity(deps, name, email);
}

/** GitHub lookup: URL / @handle / login / email in, identity candidate out. */
async function pickFromGitHub(): Promise<{ name: string; email: string } | undefined> {
  const raw = await vscode.window.showInputBox({
    prompt: 'GitHub profile URL, @username, username, or email',
    placeHolder: 'github.com/octocat / @octocat / octocat / me@example.com',
  });
  if (!raw) return undefined;
  const parsed = parseGitHubQuery(raw);
  if (!parsed) {
    vscode.window.showWarningMessage('Git Colabor: could not parse that as a GitHub URL, username, or email.');
    return undefined;
  }
  let candidates: IdentityCandidate[];
  try {
    candidates = await searchCandidates(parsed);
  } catch (e) {
    vscode.window.showWarningMessage(`Git Colabor: GitHub lookup failed (${e instanceof Error ? e.message : String(e)}).`);
    return undefined;
  }

  type PickItem = vscode.QuickPickItem & { name: string; email: string };
  const items: PickItem[] = [];
  for (const c of candidates) {
    const label = `${c.user.name ?? c.user.login} (${c.user.login})`;
    const name = c.user.name ?? c.user.login;
    const stats = c.stats
      ? ` · ${c.stats.commits} public commits · ${c.stats.repos} repos${c.stats.lastSeen ? ` · last ${c.stats.lastSeen.slice(0, 7)}` : ''}`
      : '';
    items.push({ label: `$(lock) ${label}`, description: c.noreplyEmail, detail: `private (noreply)${stats}`, name, email: c.noreplyEmail });
    // the searched email bound only via commit attribution → PRIVATE address
    if (c.attributedEmail) {
      items.push({ label: `$(eye-closed) ${label}`, description: c.attributedEmail, detail: `private email · bound via commits${stats}`, name, email: c.attributedEmail });
    }
    // the user's visible profile email (may differ from the searched one)
    if (c.publicEmail && c.publicEmail.toLowerCase() !== c.noreplyEmail.toLowerCase()
        && c.publicEmail.toLowerCase() !== c.attributedEmail?.toLowerCase()) {
      items.push({ label: `$(mail) ${label}`, description: c.publicEmail, detail: `public email${stats}`, name, email: c.publicEmail });
    }
    // extra emails mined from the user's public commits (profile email is
    // often null — e.g. hnrobert@qq.com shows up here for the hnrobert login)
    for (const email of c.commitEmails ?? []) {
      if (email.toLowerCase() === c.noreplyEmail.toLowerCase()) continue;
      if (email.toLowerCase() === c.attributedEmail?.toLowerCase()) continue;
      if (email.toLowerCase() === c.publicEmail?.toLowerCase()) continue;
      items.push({ label: `$(git-commit) ${label}`, description: email, detail: `seen in public commits${stats}`, name, email });
    }
  }
  if (items.length === 0) {
    if (parsed.kind === 'email') {
      // not found on GitHub — offer the typed email as a plain custom identity
      const fallback = parsed.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
      items.push({ label: `$(person-add) Add “${parsed.email}” as custom identity`, description: 'no GitHub user with this public email', name: fallback, email: parsed.email });
    } else {
      vscode.window.showInformationMessage(`Git Colabor: no GitHub user found for “${parsed.login}”.`);
      return undefined;
    }
  }
  const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Select the identity to add' });
  return chosen ? { name: chosen.name, email: chosen.email } : undefined;
}

/** Shared tail of both add paths: optional key + passphrase command + CLI add. */
async function finishIdentity(deps: CommandDeps, name: string, email: string): Promise<void> {
  const key = await pickPrivateKey();
  const pc = await vscode.window.showInputBox({ prompt: 'Passphrase command (optional)', placeHolder: 'op read "op://Private/ssh/pass"' });
  const args = ['identity', 'add', '--name', name, '--email', email];
  if (key && key.trim()) args.push('--key', key.trim());
  if (pc && pc.trim()) args.push('--passphrase-command', pc.trim());
  const data = await run<{ identity: IdentityJson; encrypted: boolean | null }>(deps, args);
  // encrypted key without a passphrase command → collect the passphrase now;
  // it lives in memory for THIS connection only (reconnects re-prompt)
  if (data?.encrypted === true && !pc && data.identity.sshKeyFingerprint) {
    const pass = await vscode.window.showInputBox({
      prompt: `Passphrase for key ${data.identity.sshKeyFingerprint}`,
      password: true,
      placeHolder: 'kept for this connection only — re-entered on reconnect',
    });
    if (pass !== undefined) {
      deps.sessionPassphrases.set(data.identity.sshKeyFingerprint, pass);
      deps.log.info(`session passphrase stored for ${data.identity.sshKeyFingerprint}`);
    }
  }
}

async function removeIdentity(deps: CommandDeps, item?: unknown): Promise<void> {
  const rowId = rowIdentityId(item);
  const identity = rowId
    ? (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find((i) => i.id === rowId)
    : await pickIdentity(deps, 'Select identity to remove');
  if (!identity) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove identity "${identity.name}"? (its key file is referenced, never deleted)`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;
  await run(deps, ['identity', 'rm', identity.id]);
}

async function logoutIdentity(deps: CommandDeps, item?: unknown): Promise<void> {
  const rowId = rowIdentityId(item);
  const identity = rowId
    ? (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find((i) => i.id === rowId)
    : await pickIdentity(deps, 'Select identity to logout (clear key)');
  if (!identity) return;
  // logout every session repo — without an explicit cwd the CLI inherits the
  // extension host's process cwd, which is NOT a repo under Remote-SSH, so
  // the repo state would never be cleared and the tree kept showing the
  // identity as active
  const roots = deps.git.repoRoots;
  let agentRemoved = false;
  if (roots.length === 0) {
    const data = await run<{ cleared: { agent: boolean } }>(deps, ['identity', 'logout', identity.id]);
    agentRemoved = data?.cleared.agent ?? false;
  } else {
    for (const root of roots) {
      const data = await run<{ cleared: { agent: boolean } }>(deps, ['identity', 'logout', identity.id], { cwd: root });
      agentRemoved = agentRemoved || (data?.cleared.agent ?? false);
    }
  }
  vscode.window.showInformationMessage(
    `Logged out "${identity.name}" (agent: ${agentRemoved ? 'removed' : 'n/a'}; the key file itself is never touched).`,
  );
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

/** Save or remove an identity in one settings-scope memory (user / workspace). */
async function memorizeFromItem(deps: CommandDeps, item: unknown, scope: MemoryScope, save: boolean): Promise<void> {
  const author = (item as { payload?: { name: string; email: string } } | undefined)?.payload;
  if (!author) {
    deps.log.warn('memory command invoked without an identity payload');
    return;
  }
  await setCoAuthorMemory(scope, author, save);
  deps.log.info(`${save ? 'saved' : 'removed'} identity ${author.name} <${author.email}> in ${scope} memory`);
  deps.provider?.refresh();
}

/** Hide an imported identity from one settings layer. */
async function hideMemoryFromItem(deps: CommandDeps, item: unknown, scope: MemoryScope): Promise<void> {
  await memorizeFromItem(deps, item, scope, false);
}

/**
 * Hide an imported identity at machine level: remove it from the identity
 * store AND record the email as hidden so auto-import won't resurrect it
 * (a manual re-add of the same email clears the hidden flag again).
 */
async function hideMachineFromItem(deps: CommandDeps, item: unknown): Promise<void> {
  const id = (item as { payload?: { id?: string; name?: string } } | undefined)?.payload?.id;
  if (!id) {
    deps.log.warn('hide(machine) invoked without an identity payload');
    return;
  }
  await run(deps, ['identity', 'rm', id]);
  deps.log.info(`hid imported identity ${id} at machine level (auto-import will skip it)`);
  await deps.provider?.reload();
}

/**
 * Modify one field of an identity (name / email / key reference). Changes
 * land in the machine-level identity store — the user is told so.
 */
async function modifyIdentityField(
  deps: CommandDeps,
  item: unknown,
  field: 'name' | 'email' | 'key',
): Promise<void> {
  const id = (item as { payload?: { id?: string } } | undefined)?.payload?.id;
  if (!id) {
    deps.log.warn('modify command invoked without an identity payload');
    return;
  }
  const data = await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']);
  const cur = data?.identities.find((i) => i.id === id);
  if (!cur) return;

  if (field === 'key') {
    const pick = await pickPrivateKey(true);
    if (pick === undefined) return; // cancelled / skip
    if (pick === null) await run(deps, ['identity', 'set', id, '--no-key']);
    else await run(deps, ['identity', 'set', id, '--key', pick]);
  } else {
    const isName = field === 'name';
    const value = await vscode.window.showInputBox({
      prompt: `${isName ? 'Identity name' : 'Identity email'} (saved to the machine-level identity store)`,
      value: isName ? cur.name : cur.email,
    });
    if (value === undefined || value.trim() === '') return;
    await run(deps, ['identity', 'set', id, isName ? '--name' : '--email', value.trim()]);
  }
  vscode.window.showInformationMessage(
    'Git Colabor: change saved to the machine-level identity store (~/.config/git-colabor/identities.json).',
  );
  await deps.provider?.reload();
}

/**
 * Toggle opt-in SSH commit signing with an identity's key — across every
 * open repository of the session (same as identity application).
 */
async function toggleCommitSigning(deps: CommandDeps, item: unknown, on: boolean): Promise<void> {
  const id = (item as { payload?: { id?: string } } | undefined)?.payload?.id;
  if (!id) {
    deps.log.warn('signing command invoked without an identity payload');
    return;
  }
  const roots = deps.git.repoRoots;
  if (roots.length === 0) {
    vscode.window.showWarningMessage('Git Colabor: no git repository in the current workspace.');
    return;
  }
  for (const root of roots) {
    const r = await deps.cli.run(['identity', 'sign', id, ...(on ? [] : ['--off'])], { cwd: root });
    if (!r.ok) reportError(r);
  }
  deps.log.info(`commit signing ${on ? 'ON' : 'OFF'} for identity ${id} across ${roots.length} repo(s)`);
  await deps.provider?.reload();
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
