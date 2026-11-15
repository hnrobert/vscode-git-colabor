import * as vscode from 'vscode';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import { autoApplyOnRepoOpen, defaultIdentity } from '../config.js';
import type { SessionIdentityController } from '../session/SessionIdentity.js';
import type { StatusIdentityJson } from '../types.js';
import type { StatusJson } from '../types.js';

/**
 * ONE-SHOT bootstrap at window start — SESSION-scoped: the identity is
 * injected into THIS WINDOW's environment and repo config stays untouched.
 * Runs at window start; repo events never re-apply — the session identity
 * changes only by an explicit Use afterwards, and a repo explicitly
 * configured via "Use & write git repo config" keeps working through its
 * own config (resolve.ts reads it).
 *
 * @returns whether the bootstrap was CONSUMED (a decision was made, or it is
 *   deliberately disabled). `false` = no repositories were known yet — the
 *   caller must retry on the next repo event; the vscode.git API often
 *   populates `repositories` a moment AFTER activation, and treating that
 *   pass as the one shot left the window with no session identity at all.
 */
export async function reconcile(
  cli: CliClient,
  git: GitApi,
  session: SessionIdentityController,
  logger: vscode.LogOutputChannel,
): Promise<boolean> {
  if (!autoApplyOnRepoOpen()) {
    logger.info('reconcile: autoApplyOnRepoOpen is off — skipping (explicit Use still works)');
    return true;
  }
  if (session.active()) {
    logger.info('reconcile: a session identity is already active — not overriding an explicit choice');
    return true;
  }
  const roots = git.repoRoots;
  if (roots.length === 0) {
    logger.info('reconcile: no git repository yet — retrying when one appears');
    return false;
  }
  for (const root of roots) {
    const applied = await reconcileRepo(cli, root, session, logger);
    if (applied) break; // one window, one session identity — first repo wins
  }
  return true;
}

/** Resolve a user setting value (alias > unique email > picker on shared email). */
async function resolveConfiguredRef(
  configured: string,
  rows: StatusIdentityJson[],
): Promise<StatusIdentityJson | undefined> {
  const want = configured.trim().toLowerCase();
  const byAlias = rows.filter((i) => (i.alias ?? '').toLowerCase() === want && want !== '');
  const byEmail = rows.filter((i) => i.email.toLowerCase() === want);
  if (byAlias[0]) return byAlias[0];
  if (byEmail.length === 1) return byEmail[0];
  if (byEmail.length > 1) {
    const picked = await vscode.window.showQuickPick(
      byEmail.map((i) => ({
        label: `${i.name} <${i.email}>`,
        description: i.alias ?? undefined,
        detail: i.scope === 'machine' ? 'found in machine memory' : 'found in repo history',
        id: i.id,
      })),
      { placeHolder: `"${configured}" matches ${byEmail.length} identities — pick the default` },
    );
    return picked ? (byEmail.find((i) => i.id === (picked as { id: string }).id) ?? undefined) : undefined;
  }
  return undefined;
}

async function reconcileRepo(
  cli: CliClient,
  root: string,
  session: SessionIdentityController,
  logger: vscode.LogOutputChannel,
): Promise<boolean> {
  const statusRes = await cli.run(['identity', 'status'], { cwd: root });
  const status = statusRes.ok ? (statusRes.data as StatusJson) : undefined;
  const rows = status?.identities ?? [];

  // Priority for the window bootstrap:
  // 1. gitColabor.defaultIdentity — an EXPLICIT user choice for this window.
  //    It wins over any config-derived identity: a stale ~/.gitconfig (or a
  //    sibling repo's config leaking in as the first evaluated repo) naming
  //    someone else must not hijack the bootstrap.
  // 2. The repo's OWN config identity — "Use & write git repo config" is a
  //    deliberate per-repo decision and keeps outranking the default.
  // 3. Any other config-derived active identity (typically ~/.gitconfig) —
  //    same behavior as before for setups without a defaultIdentity.
  const configured = defaultIdentity();
  if (configured && status?.inRepo) {
    const chosen = await resolveConfiguredRef(configured, rows);
    if (chosen) {
      logger.info(`reconcile[${root}]: session-applying default identity ${chosen.name} <${chosen.email}> (repo config untouched)`);
      await session.apply(chosen);
      return true;
    }
  }
  const repoCfgId = status?.configIdentities?.repo?.id;
  if (repoCfgId) {
    const row = rows.find((i) => i.id === repoCfgId) ?? status?.activeIdentity;
    if (row) {
      logger.info(`reconcile[${root}]: session-applying repo-config identity ${row.name} <${row.email}> (repo config untouched)`);
      await session.apply(row);
      return true;
    }
  }
  if (status?.activeIdentity) {
    const row = rows.find((i) => i.id === status.activeIdentity!.id) ?? status.activeIdentity;
    logger.info(`reconcile[${root}]: session-applying config identity ${row.name} <${row.email}> (repo config untouched)`);
    await session.apply(row);
    return true;
  }
  logger.info(`reconcile[${root}]: no identity to apply (no default match, no config identity)`);
  return false;
}
