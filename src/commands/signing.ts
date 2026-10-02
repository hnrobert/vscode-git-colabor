import * as vscode from 'vscode';
import { reportError, type CommandDeps } from './shared.js';

/**
 * Toggle opt-in SSH commit signing with an identity's key — across every
 * open repository of the session (same as identity application).
 */
export async function toggleCommitSigning(deps: CommandDeps, item: unknown, on: boolean): Promise<void> {
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
