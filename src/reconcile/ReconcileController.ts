import * as vscode from 'vscode';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import { autoApplyOnRepoOpen, conflictWarningStaleMinutes, defaultIdentity, effectiveUserEmail, effectiveUserName } from '../config.js';
import type { HeldByJson, StatusJson } from '../types.js';

/**
 * Enforce the "extension setting wins" rule — across EVERY open repository
 * of the session (same identity configuration applies repo-wide). Effective
 * name/email = `gitColabor.user.*` if set in any layer, else the active
 * identity's. Applied via the CLI per repo:
 *   - if there's an active/default identity → `identity use <id> --source ext [--as-name/--as-email]`
 *     (the CLI computes core.sshCommand from the identity's key);
 *   - else if a setting is set → `_apply --name --email --source ext` (name/email only, no key).
 * Surfaces any heldBy conflict as a warning.
 */
export async function reconcile(cli: CliClient, git: GitApi, logger: vscode.LogOutputChannel): Promise<void> {
  if (!autoApplyOnRepoOpen()) {
    logger.info('reconcile: autoApplyOnRepoOpen is off — skipping (explicit Use still works)');
    return;
  }
  const roots = git.repoRoots;
  if (roots.length === 0) {
    logger.info('reconcile: no git repository');
    return;
  }
  const conflicts: string[] = [];
  for (const root of roots) {
    const held = await reconcileRepo(cli, root, logger);
    if (held) conflicts.push(`${root}: ${held.session}`);
  }
  if (conflicts.length > 0) {
    vscode.window.showWarningMessage(
      `Git Colabor: overridden by the extension — held by ${conflicts.join(', ')}.`,
    );
  }
}

async function reconcileRepo(cli: CliClient, root: string, logger: vscode.LogOutputChannel): Promise<HeldByJson | undefined> {
  const name = effectiveUserName();
  const email = effectiveUserEmail();

  const statusRes = await cli.run(['identity', 'status'], { cwd: root });
  const status = statusRes.ok ? (statusRes.data as StatusJson) : undefined;

  // Post-logout guard: if the repo is already managed but has no active
  // identity, the user intentionally logged out — do NOT auto-apply
  // defaultIdentity. Only fall back to defaultIdentity on a fresh repo
  // (managed=false) where nothing has been set yet.
  const fallback = status?.managed ? undefined : defaultIdentity();
  const activeId = status?.activeIdentity?.id ?? fallback;

  // A disabled identity (passphrase failure flow) must NOT be re-applied by
  // reconcile — `identity use` would silently re-enable it. Leave the repo
  // identity-less until the user explicitly clicks the identity again.
  const resolved = status?.identities.find((i) => i.id === activeId);
  if (status?.activeIdentity?.disabled || resolved?.disabled) {
    logger.info(`reconcile[${root}]: identity ${activeId} is disabled — leaving repo identity-less`);
    return;
  }

  if (activeId) {
    const args = ['identity', 'use', activeId, '--source', 'ext', '--stale-minutes', String(conflictWarningStaleMinutes())];
    if (name && email) {
      args.push('--as-name', name, '--as-email', email);
      logger.info(`reconcile[${root}]: setting wins → ${name} <${email}> (identity ${activeId})`);
    } else {
      logger.info(`reconcile[${root}]: applying identity ${activeId}`);
    }
    return useConflictHeldBy(await cli.run(args, { cwd: root }));
  }
  if (name && email) {
    logger.info(`reconcile[${root}]: no identity; applying name/email only → ${name} <${email}>`);
    return useConflictHeldBy(
      await cli.run(['_apply', '--name', name, '--email', email, '--source', 'ext'], { cwd: root }),
    );
  }
  logger.info(`reconcile[${root}]: no gitColabor.user.* and no identity; nothing to apply`);
  return undefined;
}

function useConflictHeldBy(r: unknown): HeldByJson | undefined {
  if (r && typeof r === 'object' && r !== null && 'ok' in r && (r as { ok: boolean }).ok) {
    const conflict = (r as { data?: { conflict?: { heldBy?: HeldByJson } | null } }).data?.conflict;
    return conflict?.heldBy;
  }
  return undefined;
}
