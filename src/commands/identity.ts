import * as vscode from 'vscode';
import { setCoAuthorMemory } from '../config.js';
import { parseGitHubQuery, searchCandidates, type IdentityCandidate } from '../github/users.js';
import type { IdentityJson, JsonResult } from '../types.js';
import {
  pickIdentity,
  pickPrivateKey,
  reportError,
  requireRepo,
  rowIdentityId,
  run,
  type CommandDeps,
} from './shared.js';

export async function useIdentity(deps: CommandDeps, item?: unknown): Promise<void> {
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

export async function useIdentityById(deps: CommandDeps, id: string): Promise<void> {
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
        placeHolder: 'session only',
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
      `Git Colabor: passphrase failed — identity disabled. Click to retry.`,
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

export async function addIdentity(deps: CommandDeps): Promise<void> {
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
    if (!name) {
      // email fallback — no GitHub match, ask for a name
      name = await vscode.window.showInputBox({ prompt: 'Identity name' });
      if (!name) return;
    }
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
      items.push({ label: `$(person-add) Add “${parsed.email}” as custom identity`, description: 'no GitHub user with this public email', name: '', email: parsed.email });
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
      placeHolder: 'session only',
    });
    if (pass !== undefined) {
      deps.sessionPassphrases.set(data.identity.sshKeyFingerprint, pass);
      deps.log.info(`session passphrase stored for ${data.identity.sshKeyFingerprint}`);
    }
  }

  // scope picker — where should this identity live?
  if (data?.identity.id) await pickAndApplyScope(deps, data.identity.id, name);
}

/**
 * Final step of Add Identity: pick where the identity is scoped.
 * User (cross-machine) / Machine (this host) / specific repo (project scope,
 * only visible in that repo). Repo options list the focused repo first.
 */
async function pickAndApplyScope(deps: CommandDeps, id: string, name: string): Promise<void> {
  const focused = deps.git.selectedRepoRoot();
  const roots = deps.git.repoRoots;

  type ScopeItem = vscode.QuickPickItem & { scope?: 'user' | 'machine' | 'project'; repoRoot?: string };
  const items: ScopeItem[] = [
    { label: '$(globe) User', description: 'cross-machine — follows your VS Code profile', scope: 'user' },
    { label: '$(vm) Machine', description: 'this host only — stored in identities.json', scope: 'machine' },
  ];

  // repo options (divider + focused first, then others)
  if (roots.length > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    const ordered = focused ? [focused, ...roots.filter((r) => r !== focused)] : roots;
    for (const root of ordered) {
      const short = root.split('/').pop() ?? root;
      items.push({
        label: `$(folder) ${short}`,
        description: root === focused ? 'current repo' : root,
        scope: 'project',
        repoRoot: root,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Where should "${name}" live?`,
  });
  if (!picked) return; // cancelled → defaults to machine scope

  if (picked.scope === 'user') {
    // save in VS Code user settings (coAuthorIdentities)
    const identity = (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find((i) => i.id === id);
    if (identity) {
      await setCoAuthorMemory('user', { name: identity.name, email: identity.email }, true);
      await run(deps, ['identity', 'set', id, '--scope', 'machine']);
      deps.log.info(`identity ${name} scoped to USER`);
    }
  } else if (picked.scope === 'project' && picked.repoRoot) {
    // project scope: identity only visible in that specific repo
    await run(deps, ['identity', 'set', id, '--scope', 'project']);
    deps.log.info(`identity ${name} scoped to PROJECT (${picked.repoRoot})`);
  } else {
    // machine scope (default)
    await run(deps, ['identity', 'set', id, '--scope', 'machine']);
    deps.log.info(`identity ${name} scoped to MACHINE`);
  }
}

export async function removeIdentity(deps: CommandDeps, item?: unknown): Promise<void> {
  const rowId = rowIdentityId(item);
  const identity = rowId
    ? (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find((i) => i.id === rowId)
    : await pickIdentity(deps, 'Select identity to remove');
  if (!identity) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove identity "${identity.name}"?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;
  await run(deps, ['identity', 'rm', identity.id]);
}

export async function logoutIdentity(deps: CommandDeps, item?: unknown): Promise<void> {
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
  vscode.window.showInformationMessage(`Logged out "${identity.name}".`);
}

/**
 * Remember an identity at user (vscode config) or machine (identities.json)
 * scope. For user scope, also records the key path and remote name so the
 * identity is fully portable. For machine scope, tags it in the map.
 */
export async function rememberIdentity(deps: CommandDeps, item: unknown, scope: 'user' | 'machine'): Promise<void> {
  const payload = (item as { payload?: { id?: string; name: string; email: string } } | undefined)?.payload;
  if (!payload) {
    deps.log.warn('remember command invoked without an identity payload');
    return;
  }
  if (scope === 'user') {
    await setCoAuthorMemory('user', { name: payload.name, email: payload.email }, true);
    deps.log.info(`remembered ${payload.name} <${payload.email}> at USER scope`);
  } else {
    // promote to machine scope in the identity store — shows in every repo
    if (payload.id) await run(deps, ['identity', 'set', payload.id, '--scope', 'machine']);
    deps.log.info(`remembered ${payload.name} <${payload.email}> at MACHINE scope`);
  }
  await deps.provider?.reload();
}

/** Forget an identity from user or machine scope. */
export async function forgetIdentity(deps: CommandDeps, item: unknown, scope: 'user' | 'machine'): Promise<void> {
  const payload = (item as { payload?: { id?: string; name: string; email: string } } | undefined)?.payload;
  if (!payload) {
    deps.log.warn('forget command invoked without an identity payload');
    return;
  }
  if (scope === 'user') {
    await setCoAuthorMemory('user', { name: payload.name, email: payload.email }, false);
    deps.log.info(`forgot ${payload.name} <${payload.email}> from USER scope`);
  } else {
    // demote back to project scope — the identity only shows in repos whose
    // history contains their commits
    if (payload.id) await run(deps, ['identity', 'set', payload.id, '--scope', 'project']);
    deps.log.info(`forgot ${payload.name} <${payload.email}> from MACHINE scope (demoted to project)`);
  }
  await deps.provider?.reload();
}

/**
 * Modify one field of an identity (name / email / key reference). Changes
 * land in the machine-level identity store — the user is told so.
 */
export async function modifyIdentityField(
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
      prompt: `${isName ? 'Identity name' : 'Identity email'} `,
      value: isName ? cur.name : cur.email,
    });
    if (value === undefined || value.trim() === '') return;
    await run(deps, ['identity', 'set', id, isName ? '--name' : '--email', value.trim()]);
  }
  vscode.window.showInformationMessage(
    'Identity updated.',
  );
  await deps.provider?.reload();
}
