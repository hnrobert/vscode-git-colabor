import { spawn } from 'node:child_process';
import type { JsonResult } from '../types.js';

export type CliLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export type CliClientDeps = {
  cliPath: string;
  askpass?: { socketPath?: string; token?: string };
  session?: string;
  log?: CliLogger;
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
 * VS Code SecretStorage passphrases.
 */
export class CliClient {
  constructor(private readonly deps: CliClientDeps) {}

  async run(args: string[], opts: RunOpts = {}): Promise<JsonResult> {
    const useJson = opts.json ?? true;
    const finalArgs = useJson ? [...args, '--json'] : args;
    const env: Record<string, string> = {
      ...process.env,
      ...(opts.env ?? {}),
      GIT_COLABOR_SOURCE: 'ext',
    };
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
        try {
          resolve(JSON.parse(stdout) as JsonResult);
        } catch {
          resolve({
            ok: false,
            error: {
              code: 'BAD_JSON',
              message: `CLI produced non-JSON output`,
              hints: [stdout.slice(0, 200), stderr.slice(0, 200)],
              exitCode: 1,
            },
            data: null,
          });
        }
      });
    });
  }
}
