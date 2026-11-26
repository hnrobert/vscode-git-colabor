import { spawn } from 'node:child_process';
import type { JsonResult } from '../types.js';

export type CliLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export type CliClientDeps = {
  cliPath: string;
  askpass?: { socketPath?: string; token?: string };
  session?: string;
  log?: CliLogger;
  /**
   * The git executable vscode.git runs, handed to the CLI as GIT_COLABOR_GIT
   * so it drives the same git as the Source Control view. Resolved per call:
   * the path only exists once the vscode.git API is acquired, and it can
   * change (`git.path`).
   */
  gitPath?: () => string | undefined;
};

export type RunOpts = {
  cwd?: string;
  env?: Record<string, string>;
  /** default true — append --json and parse the envelope */
  json?: boolean;
};

/**
 * Spawns the bundled git-colabor CLI (`resources/cli.cjs`) via the VS Code Server's Node
 * (`process.execPath`) so it works under Remote-SSH/Codespaces without relying on $PATH.
 * Arg-array invocation; the askpass bridge env is forwarded so the CLI's ssh-add can reach
 * session-scoped passphrases.
 */
export class CliClient {
  /** last git executable reported to the log (announced on change only) */
  private gitReported: string | undefined;
  /** per command: the failure cause already reported (see reportFailure) */
  private readonly reportedFailures = new Map<string, string>();

  constructor(private readonly deps: CliClientDeps) {}

  async run(args: string[], opts: RunOpts = {}): Promise<JsonResult> {
    const useJson = opts.json ?? true;
    const finalArgs = useJson ? [...args, '--json'] : args;
    const env: Record<string, string> = {
      ...process.env,
      ...(opts.env ?? {}),
      GIT_COLABOR_SOURCE: 'ext',
      // neutralize the session-identity config injection (see
      // SessionIdentityController): the CLI must read/write REAL repo
      // config, not this window's session overlay. COUNT=0 makes git ignore
      // every GIT_CONFIG_KEY_n regardless of leftovers.
      GIT_CONFIG_COUNT: '0',
    };
    // same git as the Source Control view — a plain `git` on PATH may not
    // exist where vscode.git found one (Windows: off-PATH installs, git.path)
    const gitBin = this.deps.gitPath?.();
    if (gitBin) {
      env.GIT_COLABOR_GIT = gitBin;
      if (gitBin !== this.gitReported) {
        this.gitReported = gitBin;
        this.deps.log?.info(`cli git: ${gitBin}`);
      }
    }
    if (this.deps.askpass?.socketPath) env.GIT_COLABOR_ASKPASS_SOCK = this.deps.askpass.socketPath;
    if (this.deps.askpass?.token) env.GIT_COLABOR_ASKPASS_TOKEN = this.deps.askpass.token;
    if (this.deps.session) env.GIT_COLABOR_SESSION = this.deps.session;

    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.deps.cliPath, ...finalArgs], {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) =>
        resolve({ ok: false, error: { code: 'SPAWN_FAILED', message: String(err), exitCode: 1 }, data: null }),
      );
      child.on('close', (code) => {
        this.deps.log?.info(`cli ${args.join(' ')} → exit ${code ?? '?'}`);
        if (stderr.trim()) this.deps.log?.info(`cli stderr: ${stderr.trim()}`);
        if (!useJson) {
          resolve({ ok: true, data: { stdout, stderr, exitCode: code ?? 0 } });
          return;
        }
        let result: JsonResult;
        try {
          result = JSON.parse(stdout) as JsonResult;
        } catch {
          result = {
            ok: false,
            error: {
              code: 'BAD_JSON',
              message: `CLI produced non-JSON output`,
              hints: [stdout.slice(0, 200), stderr.slice(0, 200)],
              exitCode: 1,
            },
            data: null,
          };
        }
        this.reportFailure(args, result);
        resolve(result);
      });
    });
  }

  /**
   * Name the cause of a failed call ONCE per distinct error, until that
   * command succeeds again. The exit code alone explains nothing (exit 1 is
   * every unhandled error), and the view re-runs its CLI calls on each UI
   * refresh — so an unconditional line would flood the log.
   */
  private reportFailure(args: string[], result: JsonResult): void {
    const log = this.deps.log;
    if (!log) return;
    const key = args.join(' ');
    if (result.ok) {
      this.reportedFailures.delete(key);
      return;
    }
    const cause = `${result.error.code}: ${result.error.message}`;
    if (this.reportedFailures.get(key) === cause) return;
    this.reportedFailures.set(key, cause);
    log.warn(`cli ${key} failed — ${cause}`);
    for (const hint of result.error.hints ?? []) log.warn(`  hint: ${hint}`);
  }
}
