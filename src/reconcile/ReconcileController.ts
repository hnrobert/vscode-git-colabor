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
  if (!statusRes.ok) {
    // "could not read" is not "nothing there" — CliClient logged the cause
    logger.info(`reconcile[${root}]: identity status unavailable (${statusRes.error.code}) — skipping this repo`);
    return false;
  }
  const status = statusRes.data as StatusJson;
  const rows = status.identities;

  // Priority for the window bootstrap:
  // 1. A repo's OWN config identity — the deliberate per-repo choice
  //    ("Use & write git repo config"). The file already carries it, so
  //    NOTHING is applied: no env injection, no "session only" row label,
  //    signing reads its real layer from the config file.
  // 2. gitColabor.defaultIdentity — an EXPLICIT user choice; session-applied
  //    (nothing in config names it, so the env layer is the only carrier).
  //    It still outranks identities merely INHERITED from a (possibly
  //    stale) ~/.gitconfig.
  // 3. Any other config-derived active identity (typically ~/.gitconfig) —
  //    same as 1: follow the config, keep the window layer empty.
  const repoCfgId = status?.configIdentities?.repo?.id;
  if (repoCfgId) {
    const row = rows.find((i) => i.id === repoCfgId) ?? status?.activeIdentity;
    logger.info(
      `reconcile[${root}]: repo config already names ${row?.name ?? repoCfgId} — following the config, no session layer`,
    );
    return true; // consumed: nothing to inject
  }
  const configured = defaultIdentity();
  if (configured && status?.inRepo) {
    const chosen = await resolveConfiguredRef(configured, rows);
    if (chosen) {
      // the config already carries the SAME identity → the env layer would be
      // redundant: no session apply, the row keeps its "found in … config"
      // label and signing reads the config layer (no "session only"/"this
      // window" overlays)
      if (status.activeIdentity?.id === chosen.id) {
        logger.info(
          `reconcile[${root}]: git config already carries ${chosen.name} <${chosen.email}> (same as default) — following the config, no session layer`,
        );
        return true;
      }
      logger.info(`reconcile[${root}]: session-applying default identity ${chosen.name} <${chosen.email}> (repo config untouched)`);
      await session.apply(chosen);
      return true;
    }
  }
  if (status?.activeIdentity) {
    const row = rows.find((i) => i.id === status.activeIdentity!.id) ?? status.activeIdentity;
    logger.info(
      `reconcile[${root}]: git config already carries ${row.name} <${row.email}> — following the config, no session layer`,
    );
    return true; // consumed: nothing to inject
  }
  logger.info(`reconcile[${root}]: no identity to apply (no default match, no config identity)`);
  return false;
}
