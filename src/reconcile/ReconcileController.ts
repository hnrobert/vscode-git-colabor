import type * as vscode from 'vscode';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import { effectiveUserEmail, effectiveUserName } from '../config.js';

/**
 * M3 stub for the "extension setting wins" rule. Detects the effective `gitColabor.user.*` and
 * logs it; the full setting→repo-config application (name/email override + active identity's key
 * via `git colabor _apply`) ships in M5.
 */
export async function reconcile(cli: CliClient, git: GitApi, logger: vscode.LogOutputChannel): Promise<void> {
  void cli; // used in M5
  const name = effectiveUserName();
  const email = effectiveUserEmail();
  const root = git.selectedRepoRoot();
  if (name && email) {
    logger.info(`reconcile: setting wins → ${name} <${email}>${root ? ` in ${root}` : ''} (applies in M5)`);
  } else {
    logger.info('reconcile: no gitColabor.user.* setting; active identity unchanged');
  }
}
