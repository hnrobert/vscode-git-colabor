import * as vscode from 'vscode';
import {
  conflictWarningStaleMinutes,
  githubFetch,
  keyPromptCancel,
  logoutAgentKey,
  setCoAuthorMemory,
  signingMismatchAction,
  setLogoutAgentKey,
  useTarget,
} from '../config.js';
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
import { generateKeyWizard, pasteKeyWizard } from '../ssh/keyWizard.js';
import { identityConfigScopes, clearIdentityConfig } from '../ssh/gitConfig.js';
import { warnSigningMismatch } from './signing.js';
import { describeSigning, identitySigningKey } from '../session/signing.js';

/**
 * DEFAULT use flow. What the default Use writes follows gitColabor.useTarget:
 * "session" (default) applies the identity to THIS WINDOW only — config is
 * injected via the environment (git ≥ 2.31 GIT_CONFIG_*), the repo on disk
 * is never touched; "repo" / "global" write that git-config file instead.
 * The per-level actions live in useWriteRepoConfig / useWriteGlobalConfig /
 * unsetRepoConfig / unsetGlobalConfig (explicit right-click).
 */
export async function useIdentity(deps: CommandDeps, item?: unknown): Promise<void> {
  const rowId = rowIdentityId(item);
  const identity = rowId
    ? (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find((i) => i.id === rowId)
    : await pickIdentity(deps, 'Select identity to use');
  if (!identity) return;
  await useIdentityById(deps, identity.id);
}

export async function useIdentityById(deps: CommandDeps, id: string): Promise<void> {
  const target = useTarget();
  if (target === 'repo') return useWriteRepoConfig(deps, id);
  if (target === 'global') return useWriteGlobalConfig(deps, id);
  await applySessionIdentity(deps, id);
}

/** Resolve the row payload's identity, else quick-pick one (context-menu entries). */
async function rowOrPickIdentity(
  deps: CommandDeps,
  item: unknown,
  placeHolder: string,
): Promise<IdentityJson | undefined> {
  const rowId = rowIdentityId(item);
  if (rowId) {
    const data = await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']);
    return data?.identities.find((i) => i.id === rowId);
  }
  return pickIdentity(deps, placeHolder);
}

/**
 * Right-click → "Use in this session": the window-scoped apply, regardless
 * of gitColabor.useTarget (the menu item names its target explicitly).
 */
export async function useIdentitySession(deps: CommandDeps, item?: unknown): Promise<void> {
  const identity = await rowOrPickIdentity(deps, item, 'Select identity to use in this session');
  if (identity) await applySessionIdentity(deps, identity.id);
}

/**
 * Right-click → "Use & write git repo config": writes repo-local git config
 * for every open repository — visible to every window and terminal.
 */
export async function useWriteRepoConfig(deps: CommandDeps, item?: unknown | string): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const identity =
    typeof item === 'string'
      ? (
          (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find(
            (i) => i.id === item,
          )
        )
      : await rowOrPickIdentity(deps, item, 'Select identity to write to repo config');
  if (!identity) return;
  await applyUse(deps, identity.id, { scope: 'local', cwd });
}

/**
 * Right-click → "Use & write git global config": writes ~/.gitconfig — the
 * identity becomes the machine-wide git default (repo-local config still
 * overrides it per repo, as git itself resolves scopes).
 */
export async function useWriteGlobalConfig(deps: CommandDeps, item?: unknown | string): Promise<void> {
  const identity =
    typeof item === 'string'
      ? (
          (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find(
            (i) => i.id === item,
          )
        )
      : await rowOrPickIdentity(deps, item, 'Select identity to write to the global git config');
  if (!identity) return;
  await applyUse(deps, identity.id, { scope: 'global' });
}

/**
 * Right-click → "Unset in git repo config": strip this identity's
 * name/email/keys from the selected repo's local git config (content-
 * matched — a different person's config survives) and arm the standing-down
 * guard so auto-apply does not silently re-write it on the next repo event.
 */
export async function unsetRepoConfig(deps: CommandDeps, item?: unknown): Promise<void> {
  const root = requireRepo(deps);
  if (!root) return;
  const identity = await rowOrPickIdentity(deps, item, 'Select identity to unset from repo config');
  if (!identity) return;
  const r = await run<{ cleared: { identityLayer: boolean } }>(deps, ['identity', 'unset-config', identity.id, '--scope', 'local'], {
    cwd: root,
  });
  if (r === undefined) return;
  vscode.window.showInformationMessage(
    r.cleared.identityLayer
      ? `Git Colabor: removed "${identity.name}" from the repo git config.`
      : `Git Colabor: "${identity.name}" was not set in this repo's git config (nothing removed).`,
  );
  await deps.provider?.reload();
}

/** Right-click → "Unset in git global config": strip from ~/.gitconfig (content-matched). */
export async function unsetGlobalConfig(deps: CommandDeps, item?: unknown): Promise<void> {
  const identity = await rowOrPickIdentity(deps, item, 'Select identity to unset from the global git config');
  if (!identity) return;
  const r = await run<{ cleared: { identityLayer: boolean } }>(
    deps,
    ['identity', 'unset-config', identity.id, '--scope', 'global'],
    { cwd: deps.git.selectedRepoRoot() },
  );
  if (r === undefined) return;
  vscode.window.showInformationMessage(
    r.cleared.identityLayer
      ? `Git Colabor: removed "${identity.name}" from the global git config.`
      : `Git Colabor: "${identity.name}" was not set in the global git config (nothing removed).`,
  );
  await deps.provider?.reload();
}

async function applySessionIdentity(deps: CommandDeps, id: string): Promise<void> {
  const data = await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']);
  const identity = data?.identities.find((i) => i.id === id);
  if (!identity) {
    vscode.window.showWarningMessage('Git Colabor: identity not found.');
    return;
  }
  // encrypted key not in the agent and nothing banked → collect the
  // passphrase FIRST (prompt-before-inject). Cancel follows the
  // gitColabor.keyPromptCancel setting: "cancel" (default) aborts the whole
  // application; "degrade" applies the identity WITHOUT the push/sign key
  // (the tree row shows an alert icon; clicking it retries).
  let degraded = false;
  if (
    identity.hasKey &&
    identity.keyEncrypted &&
    identity.sshKeyFingerprint &&
    !identity.inAgent &&
    !deps.sessionPassphrases.has(identity.sshKeyFingerprint)
  ) {
    const pass = await vscode.window.showInputBox({
      prompt: `Passphrase for key ${identity.sshKeyFingerprint}`,
      password: true,
      placeHolder: keyPromptCancel() === 'degrade' ? 'esc to apply WITHOUT the key' : 'session only',
    });
    if (pass === undefined || pass === '') {
      if (keyPromptCancel() === 'cancel') return; // abort — nothing applied
      degraded = true; // degrade — identity applies, key does not
    } else {
      deps.sessionPassphrases.set(identity.sshKeyFingerprint, pass);
      const v = await deps.cli.run(['identity', 'agent', id, '--verify']);
      const verified = v.ok ? (v.data as { verified?: boolean }).verified === true : false;
      if (!verified) {
        deps.sessionPassphrases.delete(identity.sshKeyFingerprint);
        // wrong passphrase re-prompts once; a second failure follows the setting
        const retry = await vscode.window.showInputBox({
          prompt: `Wrong passphrase — retry for key ${identity.sshKeyFingerprint}`,
          password: true,
        });
        if (retry === undefined || retry === '') {
          if (keyPromptCancel() === 'cancel') return;
          degraded = true;
        } else {
          deps.sessionPassphrases.set(identity.sshKeyFingerprint, retry);
          const v2 = await deps.cli.run(['identity', 'agent', id, '--verify']);
          if (!(v2.ok ? (v2.data as { verified?: boolean }).verified === true : false)) {
            deps.sessionPassphrases.delete(identity.sshKeyFingerprint);
            if (keyPromptCancel() === 'cancel') return;
            degraded = true;
          }
        }
      }
    }
  }
  const applied = degraded ? { ...identity, hasKey: false, sshKeyPath: undefined, signKey: undefined } : identity;
  // signing follows the identity — switching to a key-less one while config
  // still signs (typically a previous identity's or a personal key from
  // ~/.gitconfig) is reconciled per gitColabor.signingMismatchAction:
  // "auto" (default) turns it off for this window silently; "warn" shows a
  // keep/stop reminder instead
  const signingWasOn = deps.provider?.current?.signing.enabled === true;
  const keyless = !identitySigningKey(applied);
  await deps.session.apply(applied);
  if (keyless && signingWasOn) {
    if (signingMismatchAction() === 'warn') {
      const keep = 'Keep Current Key';
      const stop = 'Stop Signing';
      const choice = await vscode.window.showWarningMessage(
        `Git Colabor: "${identity.name}" has no key, but commits would still be signed with ${describeSigning(deps.provider!.current!.signing)} — a foreign key. Keep it?`,
        keep,
        stop,
      );
      if (choice === stop) await deps.session.setSigning(false);
      // Keep — reminder served; the foreign key keeps signing
    } else {
      await deps.session.setSigning(false);
    }
  }
  vscode.window.showInformationMessage(
    degraded
      ? `Git Colabor: "${identity.name}" applied WITHOUT its key (passphrase not entered — click the row to retry).`
      : `Git Colabor: "${identity.name}" applies to THIS WINDOW only. Right-click → "Use & write git repo config" for every window.`,
  );
  // a keyed identity may still inherit a foreign signing key — reconcile it
  // per the same setting (auto: rebind; warn: ask)
  if (!keyless) {
    warnSigningMismatch(deps).catch((e) => deps.log.warn(`signing check: ${e instanceof Error ? e.message : String(e)}`));
  }
}

type UseResult = Extract<JsonResult, { ok: true }> | Extract<JsonResult, { ok: false }>;

/**
 * The use result carries an encrypted key that is NOT in ssh-agent → the
 * session store needs a passphrase for push-time askpass. Returns the
 * fingerprint to prompt for.
 */
function needsPassphrase(r: UseResult): string | undefined {
  if (!r.ok) return undefined;
  const d = r.data as {
    identity?: { hasKey?: boolean; keyEncrypted?: boolean; sshKeyFingerprint?: string };
    agent?: { inAgent: boolean } | null;
  };
  const i = d.identity;
  if (i?.hasKey && i.keyEncrypted && i.sshKeyFingerprint && d.agent && !d.agent.inAgent) {
    return i.sshKeyFingerprint;
  }
  return undefined;
}

/**
 * Config-file apply. Repo scope: one session, one identity configuration —
 * apply to EVERY open repository. Global scope: a single write to
 * ~/.gitconfig (no repo involved).
 */
async function applyUse(deps: CommandDeps, id: string, opts: { scope: 'local' | 'global'; cwd?: string }): Promise<void> {
  const global = opts.scope === 'global';
  // an explicit config write makes the FILE the carrier: drop the window's
  // env injection (same identity or not) — otherwise the stale overlay keeps
  // branding the row "session only" and env outranks the config silently
  if (deps.session.active()) deps.session.clear();
  // one session, one identity configuration: apply to EVERY open repository
  const roots = global ? [undefined] : deps.git.repoRoots.length > 0 ? deps.git.repoRoots : [opts.cwd!];
  const conflicts: string[] = [];
  const failedRepos: string[] = [];

  const useIn = (root: string | undefined) => {
    const args = ['identity', 'use', id, '--source', 'ext'];
    if (global) args.push('--config-scope', 'global');
    const stale = conflictWarningStaleMinutes();
    if (stale !== undefined) args.push('--stale-minutes', String(stale));
    return deps.cli.run(args, { cwd: root });
  };

  for (const root of roots) {
    const r = await useIn(root);
    if (!r.ok) {
      reportError(r);
      continue;
    }
    // encrypted key not in the agent and nothing banked yet → prompt once per
    // key (this connection), bank it for push-time askpass, and verify it
    // WITHOUT loading into any agent (`identity agent --verify`). Cancel or
    // wrong passphrase leaves the config applied WITHOUT the key (degrade).
    const fp = needsPassphrase(r);
    if (fp && !deps.sessionPassphrases.has(fp)) {
      const pass = await vscode.window.showInputBox({
        prompt: `Passphrase for key ${fp}`,
        password: true,
        placeHolder: 'session only',
      });
      if (pass === undefined) {
        failedRepos.push(root ?? 'global');
        continue;
      }
      deps.sessionPassphrases.set(fp, pass);
      const v = await deps.cli.run(['identity', 'agent', id, '--verify'], { cwd: root });
      const verified = v.ok ? (v.data as { verified?: boolean }).verified === true : false;
      if (!verified) {
        deps.sessionPassphrases.delete(fp); // wrong passphrase — drop it
        failedRepos.push(root ?? 'global');
        continue;
      }
      deps.log.info(`passphrase verified for key ${fp} (session only)`);
    }
    const heldBy = (r.data as { conflict?: { heldBy?: { session: string } } | null })?.conflict?.heldBy;
    if (heldBy) conflicts.push(`${root ?? 'global'}: ${heldBy.session}`);
  }

  if (failedRepos.length > 0) {
    vscode.window.showWarningMessage(
      `Git Colabor: passphrase not given — "${failedRepos.join(', ')}" applied WITHOUT the key. Use the identity again to retry.`,
    );
  }
  if (conflicts.length > 0) {
    vscode.window.showWarningMessage(`Git Colabor: overridden — held by ${conflicts.join(', ')}.`);
  }
  const identityName = (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find((i) => i.id === id)?.name ?? id;
  if (failedRepos.length === 0) {
    vscode.window.showInformationMessage(
      global
        ? `Git Colabor: "${identityName}" written to the GLOBAL git config (machine-wide default).`
        : `Git Colabor: "${identityName}" written to the repo git config — every window and terminal.`,
    );
    await deps.provider?.reload();
    // a config write can leave commits signed with a key that is not the new
    // identity's (e.g. repo-local signing keys under a global apply) — surface it
    warnSigningMismatch(deps).catch((e) => deps.log.warn(`signing check: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/**
 * Manual ssh-agent management — the ONLY path that puts a key into the agent.
 * Load prompts for the passphrase first when the key is encrypted and none is
 * banked in this session (the CLI's askpass bridge reads it during ssh-add).
 */
export async function toggleAgentKey(deps: CommandDeps, item: unknown, action: 'load' | 'remove'): Promise<void> {
  const rowId = rowIdentityId(item);
  const identity = rowId
    ? (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find((i) => i.id === rowId)
    : await pickIdentity(deps, action === 'load' ? 'Select identity to load into ssh-agent' : 'Select identity to remove from ssh-agent');
  if (!identity) return;
  if (!identity.hasKey) {
    vscode.window.showWarningMessage(`Git Colabor: "${identity.name}" has no SSH key.`);
    return;
  }
  if (
    action === 'load' &&
    identity.keyEncrypted &&
    identity.sshKeyFingerprint &&
    !deps.sessionPassphrases.has(identity.sshKeyFingerprint)
  ) {
    const pass = await vscode.window.showInputBox({
      prompt: `Passphrase for key ${identity.sshKeyFingerprint}`,
      password: true,
      placeHolder: 'session only',
    });
    if (pass === undefined) return;
    deps.sessionPassphrases.set(identity.sshKeyFingerprint, pass);
  }
  const data = await run<{ loaded?: boolean; removed?: boolean; inAgent: boolean; message?: string }>(
    deps,
    ['identity', 'agent', identity.id, ...(action === 'remove' ? ['--remove'] : [])],
  );
  if (!data) return;
  if (action === 'load') {
    if (data.inAgent) {
      vscode.window.showInformationMessage(`Git Colabor: key loaded into ssh-agent (${identity.sshKeyFingerprint}).`);
    } else if (data.loaded && data.message) {
      // e.g. keygen-verify on an agent-less host: verified but not in an agent
      vscode.window.showWarningMessage(`Git Colabor: ${data.message}`);
    } else if (data.message) {
      vscode.window.showWarningMessage(`Git Colabor: ${data.message}`);
    }
  } else if (data.removed) {
    vscode.window.showInformationMessage('Git Colabor: key removed from ssh-agent.');
  } else {
    vscode.window.showWarningMessage('Git Colabor: key was not in ssh-agent.');
  }
}

export async function addIdentity(deps: CommandDeps): Promise<void> {
  // the view-title "+" button opens this INTEGRATED menu first — identity or
  // a standalone key, both one click away
  const entry = await vscode.window.showQuickPick(
    [
      { label: '$(person-add) Add Identity…', description: 'name + email (GitHub search or custom), optional key', identity: true },
      { label: '$(add) Generate New SSH Key…', description: 'ed25519 / rsa / ecdsa — directory, file name, comment, optional passphrase', generate: true },
      { label: '$(clippy) Paste Private Key…', description: 'paste an existing private key, choose where to save it', paste: true },
    ],
    { placeHolder: 'Add identity or key' },
  );
  if (!entry) return;
  if (entry.generate) {
    await addKeyStandalone(deps, 'generate');
    return;
  }
  if (entry.paste) {
    await addKeyStandalone(deps, 'paste');
    return;
  }

  const source = await vscode.window.showQuickPick(
    [
      // GitHub search is opt-in (gitColabor.githubFetch) — it hits api.github.com
      ...(githubFetch()
        ? [{ label: '$(github) From GitHub…', description: 'search by profile URL, @username, or email', github: true }]
        : []),
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
    placeHolder: 'github.com/hnrobert / @hnrobert / hnrobert / me@example.com',
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
    // stats count commits made with the SEARCHED email (author-email:<it>) —
    // evidence for that address only. Other options (noreply / public /
    // mined) carry no counts: attaching the private email's numbers to them
    // would be misleading, and login searches show none either.
    const stats = c.stats
      ? ` · ${c.stats.commits} public commits · ${c.stats.repos} repos${c.stats.lastSeen ? ` · last ${c.stats.lastSeen.slice(0, 7)}` : ''}`
      : '';
    // the searched email bound only via commit attribution → PRIVATE address.
    // FIRST in the list — the user typed it, so it is what they came for.
    if (c.attributedEmail) {
      items.push({ label: `$(eye-closed) ${label}`, description: c.attributedEmail, detail: `private email · bound via commits${stats}`, name, email: c.attributedEmail });
    }
    items.push({ label: `$(lock) ${label}`, description: c.noreplyEmail, detail: 'private (noreply)', name, email: c.noreplyEmail });
    // the user's visible profile email (may differ from the searched one)
    if (c.publicEmail && c.publicEmail.toLowerCase() !== c.noreplyEmail.toLowerCase()
      && c.publicEmail.toLowerCase() !== c.attributedEmail?.toLowerCase()) {
      items.push({ label: `$(mail) ${label}`, description: c.publicEmail, detail: 'public email', name, email: c.publicEmail });
    }
    // extra emails mined from the user's public commits (profile email is
    // often null — e.g. hnrobert@qq.com shows up here for the hnrobert login)
    for (const email of c.commitEmails ?? []) {
      if (email.toLowerCase() === c.noreplyEmail.toLowerCase()) continue;
      if (email.toLowerCase() === c.attributedEmail?.toLowerCase()) continue;
      if (email.toLowerCase() === c.publicEmail?.toLowerCase()) continue;
      items.push({ label: `$(git-commit) ${label}`, description: email, detail: 'seen in public commits', name, email });
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

/** Shared tail of both add paths: optional key + CLI add + passphrase capture. */
async function finishIdentity(deps: CommandDeps, name: string, email: string): Promise<void> {
  const key = await pickPrivateKey(false, deps);
  const args = ['identity', 'add', '--name', name, '--email', email];
  if (key && key.trim()) args.push('--key', key.trim());
  const data = await run<{ identity: IdentityJson; encrypted: boolean | null }>(deps, args);
  // encrypted key → collect the passphrase now; it lives in memory for THIS
  // connection only (reconnects re-prompt). Skip when the key wizard already
  // banked it (generated-with-passphrase keys).
  if (
    data?.encrypted === true &&
    data.identity.sshKeyFingerprint &&
    !deps.sessionPassphrases.has(data.identity.sshKeyFingerprint)
  ) {
    const pass = await vscode.window.showInputBox({
      prompt: `Passphrase for key ${data.identity.sshKeyFingerprint}`,
      password: true,
      placeHolder: 'session only',
    });
    if (pass !== undefined) {
      deps.sessionPassphrases.set(data.identity.sshKeyFingerprint, pass);
      deps.log.info(`passphrase stored (session only) for ${data.identity.sshKeyFingerprint}`);
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

  type ScopeItem = vscode.QuickPickItem & { scope?: 'vscode' | 'machine' | 'project'; repoRoot?: string };
  const items: ScopeItem[] = [
    { label: '$(globe) VS Code Settings', description: 'cross-machine — travels with your VS Code profile', scope: 'vscode' },
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

  if (picked.scope === 'vscode') {
    // save in VS Code user settings (rememberedIdentities); 'user' below is the
    // settings LAYER (ConfigurationTarget.Global), not the identity scope
    const identity = (await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']))?.identities.find((i) => i.id === id);
    if (identity) {
      await setCoAuthorMemory('user', { name: identity.name, email: identity.email }, true);
      await run(deps, ['identity', 'set', id, '--scope', 'machine']);
      deps.log.info(`identity ${name} scoped to VSCODE`);
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

  // ssh-agent: a loaded key normally unloads on logout — ask first (or
  // follow the remembered choice). Dismissing the dialog (✕ / Esc) aborts
  // the WHOLE logout; "Always …" persists the choice to user settings.
  let removeAgentKey = true;
  if (identity.inAgent && identity.sshKeyFingerprint) {
    const pref = logoutAgentKey();
    if (pref === 'keep') {
      removeAgentKey = false;
    } else if (pref === 'ask') {
      const pick = await vscode.window.showWarningMessage(
        `"${identity.name}"'s key is loaded in ssh-agent. Remove it from the agent on logout?`,
        { modal: true, detail: `key ${identity.sshKeyFingerprint} — the key FILE is never touched` },
        'Remove',
        'Keep',
        'Always Remove',
        'Always Keep',
      );
      if (pick === 'Remove' || pick === 'Always Remove') {
        removeAgentKey = true;
        if (pick === 'Always Remove') await setLogoutAgentKey('remove');
      } else if (pick === 'Keep' || pick === 'Always Keep') {
        removeAgentKey = false;
        if (pick === 'Always Keep') await setLogoutAgentKey('keep');
      } else {
        return; // dismissed — abort the whole logout
      }
    }
  }

  // the git-config layer: when the identity being logged out ALSO lives in
  // raw git config (the "git config" tree row), ask what to do with it.
  // repo-only → clear silently; global → confirm; both → pick scope; none →
  // the plain colabor logout below.
  const repoRoot = deps.git.selectedRepoRoot();
  const hits = await identityConfigScopes(identity, repoRoot);
  if (hits.length > 0) {
    const scopes = hits.map((h) => h.scope);
    const hasRepo = scopes.includes('repo');
    const hasGlobal = scopes.includes('global');
    let choice: 'repo' | 'global' | 'both' | undefined;
    if (hasRepo && hasGlobal) {
      const pick = await vscode.window.showWarningMessage(
        `"${identity.name}" is set in BOTH the repo's local git config and the global git config. Clear which?`,
        { modal: true },
        'Repo only',
        'Global only',
        'Both',
      );
      choice = pick === 'Repo only' ? 'repo' : pick === 'Global only' ? 'global' : pick === 'Both' ? 'both' : undefined;
    } else if (hasGlobal) {
      const ok = await vscode.window.showWarningMessage(
        `"${identity.name}" is set in the GLOBAL git config (~/.gitconfig). Clear it?`,
        { modal: true },
        'Clear global config',
      );
      choice = ok === 'Clear global config' ? 'global' : undefined;
    } else {
      choice = 'repo'; // repo scope: clear without asking
    }
    if (choice === undefined) return; // cancelled — abort the whole logout
    const withKeys = {
      ...identity,
      signKeyPath: identity.signKey?.format === 'ssh' ? identity.signKey.path : undefined,
      signGpgKey: identity.signKey?.format === 'openpgp' ? identity.signKey.key : undefined,
    };
    if (choice === 'repo' || choice === 'both') await clearIdentityConfig('repo', withKeys, repoRoot);
    if (choice === 'global' || choice === 'both') await clearIdentityConfig('global', withKeys, repoRoot);
  }

  // logout every session repo — without an explicit cwd the CLI inherits the
  // extension host's process cwd, which is NOT a repo under Remote-SSH, so
  // the repo state would never be cleared and the tree kept showing the
  // identity as active
  const roots = deps.git.repoRoots;
  const logoutArgs = ['identity', 'logout', identity.id];
  if (!removeAgentKey) logoutArgs.push('--no-agent');
  let agentRemoved = false;
  if (roots.length === 0) {
    const data = await run<{ cleared: { agent: boolean } }>(deps, logoutArgs);
    agentRemoved = data?.cleared.agent ?? false;
  } else {
    for (const root of roots) {
      const data = await run<{ cleared: { agent: boolean } }>(deps, logoutArgs, { cwd: root });
      agentRemoved = agentRemoved || (data?.cleared.agent ?? false);
    }
  }
  // purge the session passphrase so the next use prompts fresh
  if (identity.sshKeyFingerprint) {
    deps.sessionPassphrases.delete(identity.sshKeyFingerprint);
  }
  // a window-scoped identity also dies with the logout
  if (deps.session.get()?.id === identity.id) deps.session.clear();
  const agentNote = identity.inAgent
    ? agentRemoved
      ? ' Key removed from ssh-agent.'
      : ' Key kept in ssh-agent.'
    : '';
  vscode.window.showInformationMessage(`Logged out "${identity.name}".${agentNote}`);
}

/**
 * Remember an identity at user (vscode config) or machine (identities.json)
 * scope. For user scope, also records the key path and remote name so the
 * identity is fully portable. For machine scope, tags it in the map.
 */
export async function rememberIdentity(deps: CommandDeps, item: unknown, scope: 'vscode' | 'machine'): Promise<void> {
  const payload = (item as { payload?: { id?: string; name: string; email: string } } | undefined)?.payload;
  if (!payload) {
    deps.log.warn('remember command invoked without an identity payload');
    return;
  }
  if (scope === 'vscode') {
    // 'user' here is the settings LAYER (user settings file), not the scope name
    await setCoAuthorMemory('user', { name: payload.name, email: payload.email }, true);
    deps.log.info(`remembered ${payload.name} <${payload.email}> in VSCODE settings`);
  } else {
    // promote to machine scope in the identity store — shows in every repo
    if (payload.id) await run(deps, ['identity', 'set', payload.id, '--scope', 'machine']);
    deps.log.info(`remembered ${payload.name} <${payload.email}> at MACHINE scope`);
  }
  await deps.provider?.reload();
}

/**
 * Standalone key entry from the view-title "+" menu: run the generate/paste
 * wizard, then offer to attach the fresh key to an existing identity
 * (Esc skips the attach — the key file is already in place and can be
 * attached later via "Add/Change SSH Key").
 */
export async function addKeyStandalone(deps: CommandDeps, kind: 'generate' | 'paste'): Promise<void> {
  let path: string | undefined;
  if (kind === 'generate') {
    const made = await generateKeyWizard();
    if (!made) return;
    path = made.path;
    if (made.encrypted && made.passphrase) {
      deps.sessionPassphrases.set(made.fingerprint, made.passphrase);
      deps.log.info(`passphrase for generated key ${made.fingerprint} banked (session only)`);
    }
  } else {
    const made = await pasteKeyWizard();
    if (!made) return;
    path = made.path;
  }
  const identity = await pickIdentity(deps, 'Attach the new key to an identity? (Esc = not now)');
  if (!identity) return;
  await run(deps, ['identity', 'set', identity.id, '--key', path]);
  vscode.window.showInformationMessage(`Git Colabor: key attached to "${identity.name}".`);
}

/**
 * Hide an identity on this machine (machine-level, by email): it disappears
 * from the identity list and co-author candidates across every scope — hide
 * outranks user/machine remember. Restore via "Show Hidden Identities…".
 */
export async function hideThisIdentity(deps: CommandDeps, item: unknown): Promise<void> {
  const payload = (item as { payload?: { name: string; email: string } } | undefined)?.payload;
  if (!payload) {
    deps.log.warn('hide command invoked without an identity payload');
    return;
  }
  const data = await run<{ hidden: string }>(deps, ['identity', 'hide', payload.email]);
  if (data) {
    vscode.window.showInformationMessage(
      `Hidden "${payload.name}" on this machine. Restore via "Show Hidden Identities…".`,
    );
  }
}

/** Forget an identity from user or machine scope. */
export async function forgetIdentity(deps: CommandDeps, item: unknown, scope: 'vscode' | 'machine'): Promise<void> {
  const payload = (item as { payload?: { id?: string; name: string; email: string } } | undefined)?.payload;
  if (!payload) {
    deps.log.warn('forget command invoked without an identity payload');
    return;
  }
  if (scope === 'vscode') {
    // 'user' here is the settings LAYER (user settings file), not the scope name
    await setCoAuthorMemory('user', { name: payload.name, email: payload.email }, false);
    deps.log.info(`forgot ${payload.name} <${payload.email}> from VSCODE settings`);
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
 * Key mode with `allowClearKey: false` is the "Add SSH Key" variant shown
 * for key-less identities (no clear option — there is nothing to clear).
 */
export async function modifyIdentityField(
  deps: CommandDeps,
  item: unknown,
  field: 'name' | 'email' | 'key',
  opts: { allowClearKey?: boolean } = {},
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
    const pick = await pickPrivateKey(opts.allowClearKey !== false, deps);
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
