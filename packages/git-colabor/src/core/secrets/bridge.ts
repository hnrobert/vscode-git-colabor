import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { Errors } from '../errors.js';
import { askSocket } from './askpass-protocol.js';

export type ResolveOpts = {
  socketPath?: string;
  token?: string;
  interactive?: boolean;
};

/**
 * Resolve a key passphrase. Order: extension session socket bridge → tty prompt.
 * Never logs the passphrase. Throws SecretUnavailable if nothing can provide it.
 */
export async function resolvePassphrase(fingerprint: string, opts: ResolveOpts = {}): Promise<string> {
  if (opts.socketPath && opts.token) {
    const got = await askSocket(opts.socketPath, opts.token, fingerprint);
    if (got) return got;
  }
  if (opts.interactive && process.stdin.isTTY) {
    return await promptPassphraseTty(`Passphrase for ${fingerprint}: `);
  }
  throw Errors.secretUnavailable('no passphrase source available', [
    'run within the VS Code extension (provides the askpass bridge)',
    'load the key into ssh-agent first (ssh-add)',
    'import a passphraseless key',
  ]);
}

/** Echo-suppressed tty passphrase prompt (POSIX `stty -echo`; Windows echoes as a fallback). */
async function promptPassphraseTty(prompt: string): Promise<string> {
  const posix = process.platform !== 'win32';
  process.stderr.write(prompt);
  if (posix) spawn('stty', ['-echo'], { stdio: 'inherit' });
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    return await new Promise<string>((resolve) => {
      rl.on('line', (line) => resolve(line));
    });
  } finally {
    rl.close();
    if (posix) spawn('stty', ['echo'], { stdio: 'inherit' });
    process.stderr.write('\n');
  }
}
