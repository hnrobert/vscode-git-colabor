import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, watch, statSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { initLog } from './log.js';
import { cliPath, postCommitSolo } from './config.js';
import { CliClient } from './cli/CliClient.js';
import { AskpassServer, writeSessionFile, colaborDir } from './askpass/AskpassServer.js';
import { GitApi } from './git-ext/GitApi.js';
import { IdentityTreeProvider } from './tree/IdentityTreeProvider.js';
import { StatusBar } from './statusbar/StatusBar.js';
import { ScmSync, pickRepository } from './scm/Sync.js';
import { registerCommands } from './commands/index.js';
import { reconcile } from './reconcile/ReconcileController.js';
import { SessionIdentityController } from './session/SessionIdentity.js';

let askpass: AskpassServer | undefined;
let stateWatchers: FSWatcher[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = initLog(context);
  logger.info('activating git colabor');

  const sessionId = 'ext_' + randomBytes(4).toString('hex');

  // Session-scoped key passphrases (in-memory only — a Remote-SSH reconnect
  // restarts the extension host, so every new connection re-prompts).
  const sessionPassphrases = new Map<string, string>();

  askpass = new AskpassServer({
    sessionId,
    secretLookup: async (fp) => sessionPassphrases.get(fp),
    log: logger,
  });
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

  // per-window identity: env-injected git config, repo untouched (the
  // default Use flow); dies with this extension host — no cleanup needed
  const sessionCtl = new SessionIdentityController(
    context.asAbsolutePath('resources/askpass.cjs'),
    logger,
  );
  sessionCtl.onChange = () => {
    provider.setSessionOverride(sessionCtl.get());
    void provider.reload();
  };
  context.subscriptions.push({ dispose: () => sessionCtl.clear() });

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

  // Dev loop: `build-scripts/remote-dev.sh` rewrites <dataDir>/dev-reload after
  // installing a fresh build; the marker content is the sha256 of the NEW
  // package.json. Matching our own package.json means a code-only deploy
  // (commands/menus unchanged) → restart just the extension host (cheap — the
  // git extension and UI survive); a mismatch means new contributions → FULL
  // window reload. The baseline is seeded once at activation, so a stale
  // marker never reloads on startup — but any later change (including the
  // marker first appearing) does.
  const reloadMarker = join(colaborDir(), 'dev-reload');
  const markerMtime = (): number | undefined => {
    try {
      return statSync(reloadMarker).mtimeMs;
    } catch {
      return undefined;
    }
  };
  const markerHash = (): string | undefined => {
    try {
      return readFileSync(reloadMarker, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const ownPackageHash = (): string | undefined => {
    try {
      return createHash('sha256').update(readFileSync(join(context.extensionPath, 'package.json'))).digest('hex');
    } catch {
      return undefined;
    }
  };
  let lastMarker = markerMtime();
  const reloadPoll = setInterval(() => {
    const mtime = markerMtime();
    if (mtime === lastMarker) return;
    lastMarker = mtime;
    const want = markerHash();
    if (want && want === ownPackageHash()) {
      logger.info('dev-reload marker changed (code-only) — restarting extension host');
      void vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    } else {
      logger.info('dev-reload marker changed — reloading window');
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }, 2000);
  context.subscriptions.push({ dispose() { clearInterval(reloadPoll); } });

  registerCommands(context, { cli, git, session: sessionCtl, log: logger, provider, sessionPassphrases });

  // refresh = re-seed state watchers (one per open repo) + reload the tree.
  // The watch-set key includes the postCommitSolo flag so toggling that
  // setting re-creates the watchers.
  let watchedKey = '';
  const setupStateWatchers = (): void => {
    const roots = new Set(git.repoRoots);
    const key = `${[...roots].sort().join('|')}#${postCommitSolo() ? 'solo' : ''}`;
    if (key === watchedKey) return;
    stateWatchers.forEach((w) => w.close());
    stateWatchers = [];
    watchedKey = key;
    for (const root of roots) {
      const stateFile = join(root, '.git', 'colabor', 'state.json');
      let t: NodeJS.Timeout | undefined;
      try {
        stateWatchers.push(
          watch(stateFile)
            .on('change', () => {
              if (t) clearTimeout(t);
              t = setTimeout(() => {
                provider.reload().catch(() => {});
              }, 300);
            })
            .on('error', () => {}),
        );
      } catch {
        // state file may not exist yet in this repo
      }
      if (postCommitSolo()) addCommitWatch(root);
    }
  };

  /**
   * postCommitSolo: clear the selected co-authors after a real commit. Dual
   * signal — COMMIT_EDITMSG changes when the message editor opens AND saves
   * (an aborted commit also touches it), while the reflog (`.git/logs/HEAD`)
   * appends only when HEAD actually moves. Solo fires only when BOTH moved;
   * an aborted editor save or a checkout alone never triggers it.
   */
  const addCommitWatch = (root: string): void => {
    const editmsg = join(root, '.git', 'COMMIT_EDITMSG');
    const reflog = join(root, '.git', 'logs', 'HEAD');
    const mtime = (p: string): number => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    };
    let baseEdit = mtime(editmsg);
    let baseRef = mtime(reflog);
    let t: NodeJS.Timeout | undefined;
    const check = (): void => {
      const e = mtime(editmsg);
      const r = mtime(reflog);
      const committed = e !== baseEdit && r !== baseRef;
      baseEdit = e;
      baseRef = r;
      if (!committed) return;
      void (async () => {
        const selected = provider.current?.selected ?? [];
        for (const s of selected) {
          const rm = await cli.run(['coauthor', 'rm', s.email], { cwd: root });
          if (!rm.ok) logger.warn(`postCommitSolo: rm ${s.email} failed in ${root}`);
        }
        if (selected.length > 0) {
          logger.info(`postCommitSolo: cleared ${selected.length} co-author(s) after commit in ${root}`);
          provider.reload().catch(() => {});
        }
      })();
    };
    const debounced = (): void => {
      if (t) clearTimeout(t);
      t = setTimeout(check, 800);
    };
    try {
      stateWatchers.push(
        watch(editmsg).on('change', debounced).on('error', () => {}),
        watch(reflog).on('change', debounced).on('error', () => {}),
      );
    } catch {
      // repo without commits yet — nothing to watch
    }
  };
  const refresh = (): void => {
    setupStateWatchers();
    provider.reload().catch((e) => logger.warn(`reload: ${e instanceof Error ? e.message : String(e)}`));
  };
  let reconcileSkippedForSession = false;
  const runReconcile = (): void => {
    // a session identity owns this window — reconcile writing repo config
    // would fight the env overlay, so it stands down until the session ends
    if (sessionCtl.active()) {
      if (!reconcileSkippedForSession) {
        logger.info('reconcile: session identity active — standing down (repo config untouched)');
        reconcileSkippedForSession = true;
      }
      return;
    }
    reconcileSkippedForSession = false;
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

  // ui.onDidChange doesn't reliably fire when clicking between repos in the
  // SCM view (multi-root) — poll the selected repo root as a belt-and-braces
  // detector so the tree always follows the focused repo
  let lastFocusedRoot: string | undefined = git.selectedRepoRoot();
  const focusPoll = setInterval(() => {
    const root = git.selectedRepoRoot();
    if (root !== lastFocusedRoot) {
      lastFocusedRoot = root;
      logger.info(`focused repo changed → ${root ?? '(none)'}`);
      refresh();
    }
  }, 1000);
  context.subscriptions.push({ dispose() { clearInterval(focusPoll); } });
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
      void maybePromptActiveKey(); // the one-shot check at activation raced the API
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
  context.subscriptions.push({ dispose() { stateWatchers.forEach((w) => w.close()); } });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitColabor.postCommitSolo')) refresh();
      if (e.affectsConfiguration('gitColabor.user') || e.affectsConfiguration('gitColabor.defaultIdentity')) {
        runReconcile();
        refresh();
      }
    }),
  );

  runReconcile();
  refresh();

  // After the first status paints, check the active identity: if it has an
  // encrypted key that is NOT in ssh-agent and we hold no passphrase in this
  // session (fresh window / reload / reconnect — passphrases are session-
  // scoped memory only), prompt immediately, then verify WITHOUT loading into
  // any agent (`identity agent --verify`). Cancel or wrong passphrase disables
  // the identity (same as the in-use failure flow).
  // Re-runnable from THREE triggers: activation, late vscode.git API
  // acquisition, and every provider reload (the event delivers the status —
  // no extra CLI call). The third matters because the encryption flag can be
  // healed MID-SESSION: reconcile's `identity use` self-heals stale stored
  // flags, so the one-shot check at activation may have seen `keyEncrypted:
  // false` and skipped; the next reload event then sees the healed state and
  // prompts. `promptedKeys` keeps a completed decision from repeating; a null
  // activeIdentity leaves it free to retry.
  const promptedKeys = new Set<string>();
  const maybePromptActiveKey = async (prefetched?: Awaited<ReturnType<IdentityTreeProvider['reload']>>): Promise<void> => {
    const status = prefetched ?? (await provider.reload().catch(() => undefined));
    const active = status?.activeIdentity;
    if (!active?.hasKey || !active.keyEncrypted || !active.sshKeyFingerprint) return;
    const fp = active.sshKeyFingerprint;
    if (promptedKeys.has(fp)) return;
    const row = status?.identities.find((i) => i.id === active.id);
    if (sessionPassphrases.has(fp) || row?.inAgent) {
      promptedKeys.add(fp); // covered — remember the decision
      return;
    }
    promptedKeys.add(fp);
    const pass = await vscode.window.showInputBox({
      prompt: `Passphrase for ${active.name}'s key ${fp}`,
      password: true,
      placeHolder: 'session only',
    });
    if (pass === undefined || !status?.repo) {
      // This is a PASSIVE prompt (window opened / status refreshed) — unlike
      // the explicit use flow, cancelling it must NOT disable the identity.
      // The key simply stays locked until the user clicks the identity
      // (explicit use re-prompts) or reloads.
      logger.info(`passphrase prompt dismissed for ${active.name} (no disable — click the identity to retry)`);
      void provider.reload();
      return;
    }
    sessionPassphrases.set(fp, pass);
    logger.info(`passphrase stored (session only) for ${active.name}'s key on window open`);
    // verify via the bridge WITHOUT loading (ssh-keygen -y under askpass)
    const verify = await cli.run(['identity', 'agent', active.id, '--verify']);
    const verified = verify.ok ? (verify.data as { verified?: boolean }).verified === true : false;
    void provider.reload();
    if (!verified) {
      sessionPassphrases.delete(fp); // wrong passphrase
      promptedKeys.delete(fp); // allow a retry on the next check
      const roots = git.repoRoots;
      for (const root of roots) {
        await cli.run(['identity', 'disable', active.id], { cwd: root });
      }
      vscode.window.showWarningMessage(`Git Colabor: wrong passphrase — ${active.name} disabled. Click to retry.`);
      void provider.reload();
    }
  };
  // every tree/status refresh re-evaluates the prompt condition using the
  // delivered status (guards make the miss path free; the healed-flag case
  // above is exactly what this catches)
  context.subscriptions.push(provider.onDidReload.event((s) => { void maybePromptActiveKey(s ?? undefined); }));
  void maybePromptActiveKey();

  logger.info('git colabor activated');
}

export async function deactivate(): Promise<void> {
  stateWatchers.forEach((w) => w.close());
  stateWatchers = [];
  await askpass?.stop();
  askpass = undefined;
}
