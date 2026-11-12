import { spawn } from 'node:child_process';

export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

export class GitError extends Error {
  readonly cmd: string;
  readonly exitCode: number;
  readonly stderr: string;
  constructor(cmd: string, exitCode: number, stderr: string) {
    super(`git ${cmd} failed (exit ${exitCode})${stderr ? ': ' + stderr.trim() : ''}`);
    this.name = 'GitError';
    this.cmd = cmd;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function run(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
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
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/**
 * Run git, returning the full result regardless of exit code.
 * Use for reads where a non-zero exit means "not found" (e.g. `git config --get`).
 */
export async function gitRaw(args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return run(args, opts);
}

/**
 * Run git, throwing {@link GitError} on non-zero exit. Use for mutations where
 * failure is a real error. Arg-array invocation — never a shell, never interpolation.
 */
export async function git(args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const result = await run(args, opts);
  if (result.exitCode !== 0) throw new GitError(args.join(' '), result.exitCode, result.stderr);
  return result;
}

/**
 * Run an arbitrary binary (e.g. `ssh-keygen`, `ssh-add`) with an arg array. Never throws —
 * returns the full result so callers can branch on exit code.
 */
export async function runBin(
  cmd: string,
  args: string[],
  opts: GitOptions & { input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input, 'utf8');
    else child.stdin.end();
  });
}
