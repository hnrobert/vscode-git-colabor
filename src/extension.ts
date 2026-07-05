import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { initLog } from './log.js';
import { cliPath } from './config.js';
import { CliClient } from './cli/CliClient.js';
import { AskpassServer, writeSessionFile } from './askpass/AskpassServer.js';
import { Secrets } from './secrets/Secrets.js';
import { GitApi } from './git-ext/GitApi.js';
import { IdentityTreeProvider } from './tree/IdentityTreeProvider.js';
import { StatusBar } from './statusbar/StatusBar.js';
import { ScmSync } from './scm/Sync.js';
import { registerCommands } from './commands.js';
import { reconcile } from './reconcile/ReconcileController.js';

let askpass: AskpassServer | undefined;
let stateWatcher: FSWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = initLog(context);
  logger.info('activating git colabor');

  const sessionId = 'ext_' + randomBytes(4).toString('hex');
  const secrets = new Secrets(context.secrets);

  askpass = new AskpassServer({ sessionId, secretLookup: (fp) => secrets.get(fp), log: logger });
  let askpassInfo: { socketPath: string; token: string } | undefined;
  try {
    askpassInfo = await askpass.start();
    await writeSessionFile(sessionId, askpassInfo.socketPath, askpassInfo.token);
  } catch (e) {
    logger.warn(`askpass server failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  const git = new GitApi();
  git.activate();

  const cli = new CliClient({
    cliPath: cliPath(context),
    askpass: askpassInfo ? { socketPath: askpassInfo.socketPath, token: askpassInfo.token } : undefined,
    session: sessionId,
    log: logger,
  });

  const provider = new IdentityTreeProvider(cli, git);
  context.subscriptions.push(vscode.window.createTreeView('gitColabor.identitiesView', { treeDataProvider: provider }));

  const statusbar = new StatusBar();
  context.subscriptions.push(statusbar);
  const scmSync = new ScmSync(git);

  context.subscriptions.push(
    provider.onDidReload.event((s) => {
      statusbar.update(s);
      scmSync.sync(s?.selected ?? []);
    }),
  );

  registerCommands(context, { cli, git, secrets, log: logger, provider });

  // Watch the per-repo state file so terminal-CLI changes reflect in the UI (git-mob drift fix).
  let watchedRepo: string | undefined;
  const setupStateWatcher = (): void => {
    const root = git.selectedRepoRoot();
    if (root === watchedRepo) return;
    stateWatcher?.close();
    stateWatcher = undefined;
    watchedRepo = root;
    if (!root) return;
    const stateFile = join(root, '.git', 'colabor', 'state.json');
    let t: NodeJS.Timeout | undefined;
    try {
      stateWatcher = watch(stateFile).on('change', () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          provider.reload().catch(() => {});
        }, 300);
      });
      stateWatcher.on('error', () => {});
    } catch {
      // state file may not exist yet — re-setup runs again on next repo/refresh
    }
  };

  const refresh = (): void => {
    setupStateWatcher();
    provider.reload().catch((e) => logger.warn(`reload: ${e instanceof Error ? e.message : String(e)}`));
  };

  context.subscriptions.push(git.subscribe(refresh));
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.endsWith('.git-coauthors')) refresh();
    }),
  );
  context.subscriptions.push({ dispose() { stateWatcher?.close(); } });

  const runReconcile = (): void => {
    reconcile(cli, git, logger).catch((e) =>
      logger.warn(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitColabor')) {
        runReconcile();
        refresh();
      }
    }),
  );

  refresh();
  runReconcile();

  logger.info('git colabor activated');
}

export async function deactivate(): Promise<void> {
  stateWatcher?.close();
  stateWatcher = undefined;
  await askpass?.stop();
  askpass = undefined;
}
