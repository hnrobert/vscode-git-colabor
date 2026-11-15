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
 * Runs ONCE per window (activation); repo events never re-apply — the
 * session identity changes only by an explicit Use afterwards, and a repo
 * explicitly configured via "Use & write git repo config" keeps working
 * through its own config (resolve.ts reads it).
 */
export async function reconcile(
  cli: CliClient,
  git: GitApi,
  session: SessionIdentityController,
  logger: vscode.LogOutputChannel,
): Promise<void> {
  if (!autoApplyOnRepoOpen()) {
    logger.info('reconcile: autoApplyOnRepoOpen is off — skipping (explicit Use still works)');
    return;
  }
  if (session.active()) {
    logger.info('reconcile: a session identity is already active — not overriding an explicit choice');
    return;
  }
  const roots = git.repoRoots;
  if (roots.length === 0) {
    logger.info('reconcile: no git repository');
    return;
  }
  for (const root of roots) {
    const applied = await reconcileRepo(cli, root, session, logger);
    if (applied) break; // one window, one session identity — first repo wins
  }
}

async function reconcileRepo(
  cli: CliClient,
  root: string,
  session: SessionIdentityController,
  logger: vscode.LogOutputChannel,
): Promise<boolean> {
  const statusRes = await cli.run(['identity', 'status'], { cwd: root });
  const status = statusRes.ok ? (statusRes.data as StatusJson) : undefined;

  // active = config-derived; defaultIdentity only fills on repos where config
  // carries nothing (fresh — no user.name/email anywhere). The setting's value
  // resolves EXACTLY like `identity use`: alias first (aliases may contain @,
  // so shape cannot distinguish), then email. An email several identities
  // share pops a picker; a value matching nothing leaves the repo untouched.
  // (The `Name <email>` author form is internal plumbing, not a user ref.)
  const configured = defaultIdentity();
  let fallback: string | undefined;
  if (configured && status?.inRepo && !status.activeIdentity) {
    const want = configured.trim().toLowerCase();
    const rows = status.identities;
    const byAlias = rows.filter((i) => (i.alias ?? '').toLowerCase() === want && want !== '');
    const byEmail = rows.filter((i) => i.email.toLowerCase() === want);
    const chosen = byAlias[0] ?? (byEmail.length === 1 ? byEmail[0] : undefined);
    if (!chosen && byEmail.length > 1) {
      const picked = await vscode.window.showQuickPick(
        byEmail.map((i) => ({
          label: `${i.name} <${i.email}>`,
          description: i.alias ?? undefined,
          detail: i.scope === 'machine' ? 'found in machine memory' : 'found in repo history',
          id: i.id,
        })),
        { placeHolder: `"${configured}" matches ${byEmail.length} identities — pick the default` },
      );
      fallback = picked?.id;
    } else {
      fallback = chosen?.id;
    }
  }
  const activeId = status?.activeIdentity?.id ?? fallback;

  if (activeId) {
    const row =
      status?.identities.find((i) => i.id === activeId) ??
      status?.activeIdentity ?? { id: activeId, name: activeId, email: activeId, hasKey: false, isDefault: false };
    logger.info(`reconcile[${root}]: session-applying identity ${row.name} <${row.email}> (repo config untouched)`);
    await session.apply(row as StatusIdentityJson);
    return true;
  }
  logger.info(`reconcile[${root}]: no identity active and no default — nothing to apply`);
  return false;
}
