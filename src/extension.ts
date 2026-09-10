import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { watch, statSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { initLog } from './log.js';
import { cliPath } from './config.js';
import { CliClient } from './cli/CliClient.js';
import { AskpassServer, writeSessionFile, colaborDir } from './askpass/AskpassServer.js';
import { Secrets } from './secrets/Secrets.js';
import { GitApi } from './git-ext/GitApi.js';
import { IdentityTreeProvider } from './tree/IdentityTreeProvider.js';
import { StatusBar } from './statusbar/StatusBar.js';
import { ScmSync, pickRepository } from './scm/Sync.js';
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

  // Auto-detect co-author trailers typed into the SCM input box: the git API
  // exposes no change event for inputBox, so poll lightly and refresh the
  // tree's +/- markers when the value actually changes.
  let lastInput: string | undefined = pickRepository(git)?.inputBox.value;
  const inputPoll = setInterval(() => {
    const value = pickRepository(git)?.inputBox.value;
    if (value !== undefined && value !== lastInput) {
      lastInput = value;
      provider.refresh();
    }
  }, 1500);
  context.subscriptions.push({ dispose() { clearInterval(inputPoll); } });

  // Dev loop: `build-scripts/remote-dev.sh` touches <dataDir>/dev-reload after
  // installing a fresh build; react with a FULL window reload (extension-host
  // restarts alone cannot refresh package.json menu/command contributions).
  // The baseline is seeded once at activation, so a stale marker never
  // reloads on startup — but any later change (including the marker first
  // appearing) does.
  const reloadMarker = join(colaborDir(), 'dev-reload');
  const markerMtime = (): number | undefined => {
    try {
      return statSync(reloadMarker).mtimeMs;
    } catch {
      return undefined;
    }
  };
  let lastMarker = markerMtime();
  const reloadPoll = setInterval(() => {
    const mtime = markerMtime();
    if (mtime === lastMarker) return;
    lastMarker = mtime;
    logger.info('dev-reload marker changed — reloading window');
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }, 2000);
  context.subscriptions.push({ dispose() { clearInterval(reloadPoll); } });

  registerCommands(context, { cli, git, secrets, log: logger, provider });

  // refresh = re-seed state watcher + reload the tree
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
      stateWatcher = watch(stateFile)
        .on('change', () => {
          if (t) clearTimeout(t);
          t = setTimeout(() => {
            provider.reload().catch(() => {});
          }, 300);
        })
        .on('error', () => {});
    } catch {
      // state file may not exist yet
    }
  };
  const refresh = (): void => {
    setupStateWatcher();
    provider.reload().catch((e) => logger.warn(`reload: ${e instanceof Error ? e.message : String(e)}`));
  };
  const runReconcile = (): void => {
    reconcile(cli, git, logger).catch((e) =>
      logger.warn(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  };

  // repo open/close/selection: debounced reconcile (enforce setting-wins) + refresh.
  // The vscode.git API may not be ready when we activate (notably under
  // Remote-SSH, where it can land in another extension-host process), so
  // wire the subscriptions only after the API is acquired and retry on
  // extension changes until it is.
  let gitSub: vscode.Disposable | undefined;
  let gitTimer: NodeJS.Timeout | undefined;
  const wireGitEvents = (): void => {
    gitSub?.dispose();
    gitSub = git.subscribe(() => {
      if (gitTimer) clearTimeout(gitTimer);
      gitTimer = setTimeout(() => {
        runReconcile();
        refresh();
      }, 400);
    });
  };
  context.subscriptions.push({ dispose() { gitSub?.dispose(); } });

  if ((await git.activate()) === '') {
    logger.info('vscode.git API acquired');
    wireGitEvents();
  } else {
    // The git extension's activation can complete a moment after ours (it
    // started only ~0.5s before us under Remote-SSH). Retry with backoff —
    // extensions.onDidChange is useless here, it only fires on
    // install/uninstall, never on activation.
    const onAcquired = (): void => {
      logger.info('vscode.git API acquired (late)');
      wireGitEvents();
      runReconcile();
      refresh();
    };
    const tryLater = (delayMs: number, attemptsLeft: number): void => {
      const t = setTimeout(() => {
        void git
          .activate()
          .then((reason) => {
            if (reason === '') return onAcquired();
            if (attemptsLeft > 0) return tryLater(Math.min(delayMs * 2, 5000), attemptsLeft - 1);
            logger.error(`vscode.git API never became available (${reason}); repo detection disabled`);
          })
          .catch((e) => logger.error(`git activate retry failed: ${e}`));
      }, delayMs);
      context.subscriptions.push({ dispose() { clearTimeout(t); } });
    };
    logger.warn('vscode.git API unavailable yet; retrying with backoff');
    tryLater(500, 8); // 0.5s 1s 2s 4s 5s 5s 5s 5s ≈ 28s window
  }
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.endsWith('.git-coauthors')) refresh();
    }),
  );
  context.subscriptions.push({ dispose() { stateWatcher?.close(); } });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitColabor.user') || e.affectsConfiguration('gitColabor.defaultIdentity')) {
        runReconcile();
        refresh();
      }
    }),
  );

  runReconcile();
  refresh();

  logger.info('git colabor activated');
}

export async function deactivate(): Promise<void> {
  stateWatcher?.close();
  stateWatcher = undefined;
  await askpass?.stop();
  askpass = undefined;
}
