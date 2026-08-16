import * as vscode from 'vscode';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import { defaultIdentity, effectiveUserEmail, effectiveUserName } from '../config.js';
import type { HeldByJson, StatusJson } from '../types.js';

/**
 * Enforce the "extension setting wins" rule. Effective name/email = `gitColabor.user.*` if set in
 * any layer, else the active identity's. Applied via the CLI:
 *   - if there's an active/default identity → `identity use <id> --source ext [--as-name/--as-email]`
 *     (the CLI computes core.sshCommand from the identity's key);
 *   - else if a setting is set → `_apply --name --email --source ext` (name/email only, no key).
 * Surfaces any heldBy conflict as a warning.
 */
export async function reconcile(cli: CliClient, git: GitApi, logger: vscode.LogOutputChannel): Promise<void> {
  const root = git.selectedRepoRoot();
  const name = effectiveUserName();
  const email = effectiveUserEmail();
  if (!root) {
    logger.info('reconcile: no git repository');
    return;
  }

  const statusRes = await cli.run(['identity', 'status'], { cwd: root });
  const status = statusRes.ok ? (statusRes.data as StatusJson) : undefined;
  const activeId = status?.activeIdentity?.id ?? defaultIdentity();

  let conflictHeldBy: HeldByJson | undefined;

  if (activeId) {
    const args = ['identity', 'use', activeId, '--source', 'ext'];
    if (name && email) {
      args.push('--as-name', name, '--as-email', email);
      logger.info(`reconcile: setting wins → ${name} <${email}> (identity ${activeId})`);
    } else {
      logger.info(`reconcile: applying identity ${activeId}`);
    }
    const r = await cli.run(args, { cwd: root });
    conflictHeldBy = useConflictHeldBy(r);
  } else if (name && email) {
    logger.info(`reconcile: no identity; applying name/email only → ${name} <${email}>`);
    const r = await cli.run(['_apply', '--name', name, '--email', email, '--source', 'ext'], { cwd: root });
    conflictHeldBy = useConflictHeldBy(r);
  } else {
    logger.info('reconcile: no gitColabor.user.* and no identity; nothing to apply');
    return;
  }

  if (conflictHeldBy) {
    vscode.window.showWarningMessage(
      `Git Colabor: repo was held by ${conflictHeldBy.session}; overridden by the extension.`,
    );
  }
}

function useConflictHeldBy(r: unknown): HeldByJson | undefined {
  if (r && typeof r === 'object' && r !== null && 'ok' in r && (r as { ok: boolean }).ok) {
    const conflict = (r as { data?: { conflict?: { heldBy?: HeldByJson } | null } }).data?.conflict;
    return conflict?.heldBy;
  }
  return undefined;
}
