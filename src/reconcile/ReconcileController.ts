import * as vscode from 'vscode';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import { autoApplyOnRepoOpen, defaultIdentity } from '../config.js';
import type { StatusJson } from '../types.js';

/**
 * Materialize the config-derived active identity into every open repo's
 * local config on repo events (auto-apply). The active identity comes from
 * git config itself (resolve.ts); no session locks — last writer wins.
 *
 * Repos the user explicitly stripped ("Unset in git repo config" /
 * `identity logout`) are standing down (stored in identities.json — shared
 * with every window and terminal): reconcile must not re-materialize what
 * was deliberately removed; any explicit local apply re-arms it (core
 * apply.ts clears the marker on every local-scope write).
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
  const statusRes = await cli.run(['identity', 'status'], { cwd: root });
  const status = statusRes.ok ? (statusRes.data as StatusJson) : undefined;
  if (status?.standingDown) {
    logger.info(`reconcile[${root}]: standing down (identity config was explicitly unset here)`);
    return;
  }

  // active = config-derived; defaultIdentity only fills on repos where config
  // carries nothing (fresh — no user.name/email anywhere). The setting takes
  // the identity's id OR its email (email is the person key; it's the value
  // the tree rows display).
  const configured = defaultIdentity();
  const fallback =
    configured && status?.inRepo && !status.activeIdentity
      ? status.identities.find(
          (i) =>
            i.id === configured ||
            i.email.toLowerCase() === configured.trim().toLowerCase() ||
            (i.alias !== undefined && i.alias !== null && i.alias.toLowerCase() === configured.trim().toLowerCase()),
        )?.id
      : undefined;
  const activeId = status?.activeIdentity?.id ?? fallback;

  if (activeId) {
    logger.info(`reconcile[${root}]: applying identity ${activeId}`);
    await cli.run(['identity', 'use', activeId, '--source', 'ext'], { cwd: root });
    return;
  }
  logger.info(`reconcile[${root}]: no identity active and no default — nothing to apply`);
}
