import * as vscode from 'vscode';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import { autoApplyOnRepoOpen, defaultIdentity, effectiveUserEmail, effectiveUserName } from '../config.js';
import type { StatusJson } from '../types.js';

/**
 * Enforce the "extension setting wins" rule — across EVERY open repository
 * of the session. Effective name/email = `gitColabor.user.*` if set in any
 * layer, else the active identity's. The active identity is config-derived
 * (resolve.ts); no session locks — last writer wins, by design.
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
  for (const root of roots) {
    await reconcileRepo(cli, root, logger);
  }
}

async function reconcileRepo(cli: CliClient, root: string, logger: vscode.LogOutputChannel): Promise<void> {
  const name = effectiveUserName();
  const email = effectiveUserEmail();

  const statusRes = await cli.run(['identity', 'status'], { cwd: root });
  const status = statusRes.ok ? (statusRes.data as StatusJson) : undefined;

  // active = config-derived; defaultIdentity only fills on repos where config
  // carries nothing (fresh — no user.name/email anywhere)
  const activeId = status?.activeIdentity?.id ?? (status?.inRepo && !status?.activeIdentity ? defaultIdentity() : undefined);

  if (activeId) {
    const args = ['identity', 'use', activeId, '--source', 'ext'];
    if (name && email) {
      args.push('--as-name', name, '--as-email', email);
      logger.info(`reconcile[${root}]: setting wins → ${name} <${email}> (identity ${activeId})`);
    } else {
      logger.info(`reconcile[${root}]: applying identity ${activeId}`);
    }
    await cli.run(args, { cwd: root });
    return;
  }
  if (name && email) {
    logger.info(`reconcile[${root}]: no identity; applying name/email only → ${name} <${email}>`);
    await cli.run(['_apply', '--name', name, '--email', email, '--source', 'ext'], { cwd: root });
    return;
  }
  logger.info(`reconcile[${root}]: no gitColabor.user.* and no identity; nothing to apply`);
}
