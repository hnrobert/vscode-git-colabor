import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { initLog } from './log.js';
import { cliPath } from './config.js';
import { CliClient } from './cli/CliClient.js';
import { AskpassServer, writeSessionFile } from './askpass/AskpassServer.js';
import { Secrets } from './secrets/Secrets.js';
import { GitApi } from './git-ext/GitApi.js';
import { registerCommands } from './commands.js';
import { reconcile } from './reconcile/ReconcileController.js';

let askpass: AskpassServer | undefined;

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

  registerCommands(context, { cli, git, secrets, log: logger });

  const runReconcile = () => {
    reconcile(cli, git, logger).catch((e) => logger.warn(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitColabor')) runReconcile();
    }),
  );
  runReconcile();

  logger.info('git colabor activated');
}

export async function deactivate(): Promise<void> {
  await askpass?.stop();
  askpass = undefined;
}
