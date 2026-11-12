import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type LoadKeyOpts = {
  keyPath: string;
  fingerprint: string;
  /** absolute path to the bundled askpass.cjs */
  askpassScriptPath?: string;
  socketPath?: string;
  token?: string;
  useAppleKeychain?: boolean;
};

export type LoadResult = {
  loaded: boolean;
  via: 'plain' | 'apple-keychain' | 'askpass' | 'keygen-verify' | 'tty' | 'none';
  message?: string;
};

function runInherit(cmdArgs: string[], env?: NodeJS.ProcessEnv, stdinNull = false): Promise<number> {
  return new Promise((resolve) => {
    const [cmd, ...args] = cmdArgs;
    const child = spawn(cmd, args, {
      env: env ?? process.env,
      stdio: [stdinNull ? 'ignore' : 'inherit', 'inherit', 'pipe'],
      detached: false, // keep setsid children in our process group so the kill timer can reach them
    });
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      // setsid creates a NEW session — kill the whole group to catch orphans
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // group already gone
        }
      }
    }, 10_000);
    child.on('error', () => {
      clearTimeout(killTimer);
      resolve(127);
    });
    child.on('close', (c) => {
      clearTimeout(killTimer);
      resolve(c ?? 127);
    });
  });
}

function hasBin(bin: string): boolean {
  if (process.platform === 'win32') {
    return spawnSync('where', [bin]).status === 0;
  }
  // `command` is a shell builtin; run a single command string (no args+shell) to avoid Node DEP0190.
  return spawnSync(`command -v ${bin}`, { shell: true }).status === 0;
}

async function supportsAppleKeychain(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const r = await runBinQuiet('ssh-add', ['-h']);
  return r.includes('--apple-use-keychain');
}

async function runBinQuiet(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

/**
 * Load a key into ssh-agent. Tries, in order: plain load (covers passphraseless / already-loaded),
 * macOS keychain, SSH_ASKPASS bridge (session socket), then interactive tty.
 * Never throws — returns a LoadResult so callers can warn without failing.
 */
export async function loadKey(opts: LoadKeyOpts): Promise<LoadResult> {
  if (!existsSync(opts.keyPath)) return { loaded: false, via: 'none', message: 'key file missing' };

  // 1. plain (passphraseless or already in agent)
  let code = await runInherit(['ssh-add', opts.keyPath], undefined, !process.stdin.isTTY);
  if (code === 0) return { loaded: true, via: 'plain' };

  // 2. macOS keychain
  if (opts.useAppleKeychain && (await supportsAppleKeychain())) {
    code = await runInherit(['ssh-add', '--apple-use-keychain', opts.keyPath]);
    if (code === 0) return { loaded: true, via: 'apple-keychain' };
  }

  // 3. SSH_ASKPASS bridge (non-interactive; passphrase never on argv / never ps-visible)
  const haveSource = opts.socketPath && opts.token;
  if (opts.askpassScriptPath && haveSource) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.SSH_ASKPASS = opts.askpassScriptPath;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env.DISPLAY = env.DISPLAY ?? ':0';
    if (opts.socketPath) env.GIT_COLABOR_ASKPASS_SOCK = opts.socketPath;
    if (opts.token) env.GIT_COLABOR_ASKPASS_TOKEN = opts.token;
    env.GIT_COLABOR_FINGERPRINT = opts.fingerprint;
    const useSetsid = process.platform !== 'win32' && hasBin('setsid');
    code = await runInherit(useSetsid ? ['setsid', 'ssh-add', opts.keyPath] : ['ssh-add', opts.keyPath], env, true);
    if (code === 0) return { loaded: true, via: 'askpass' };

    // ssh-add failed — on hosts with NO ssh-agent it cannot even ask (dies
    // with "Could not open a connection"). Validate the passphrase with
    // `ssh-keygen -y` under the same askpass env instead: exit 0 proves the
    // passphrase is correct, and the key unlocks at ssh time through the
    // SSH_ASKPASS prefix baked into core.sshCommand. This is also the only
    // reliable WRONG-passphrase detector on agent-less hosts. Output is
    // captured (not inherited): ssh-keygen -y prints the PUBLIC KEY, which
    // would corrupt the CLI's own --json stdout.
    if (await verifyKey(opts)) {
      return {
        loaded: true,
        via: 'keygen-verify',
        message: 'passphrase verified (no ssh-agent — the key unlocks at ssh time via SSH_ASKPASS)',
      };
    }
    return { loaded: false, via: 'askpass', message: 'passphrase rejected' };
  }

  // 4. interactive tty
  if (process.stdin.isTTY) {
    code = await runInherit(['ssh-add', opts.keyPath]);
    if (code === 0) return { loaded: true, via: 'tty' };
    return { loaded: false, via: 'tty', message: `ssh-add exited ${code}` };
  }

  return { loaded: false, via: 'none', message: 'no passphrase source and no tty' };
}

/** `ssh-add -l` output ("" if agent unavailable or no identities). */
export async function listAgent(): Promise<string> {
  return runBinQuiet('ssh-add', ['-l']);
}

/** Fingerprints of every key currently held by ssh-agent (empty set when no agent). */
export async function agentFingerprints(): Promise<Set<string>> {
  const out = await listAgent();
  const prints = new Set<string>();
  for (const line of out.split('\n')) {
    // "<bits> SHA256:xxx comment (card)" — the fingerprint is the second token
    const tok = line.trim().split(/\s+/)[1];
    if (tok?.startsWith('SHA256:')) prints.add(tok);
  }
  return prints;
}

/** Is this key's fingerprint currently loaded in ssh-agent? */
export async function keyInAgent(fingerprint: string): Promise<boolean> {
  return (await agentFingerprints()).has(fingerprint);
}

/** Remove a key from the agent (`ssh-add -d <key>`). */
export async function removeKey(keyPath: string): Promise<boolean> {
  const code = await runInherit(['ssh-add', '-d', keyPath], undefined, true);
  return code === 0;
}

/** Quiet `ssh-keygen -y` under the askpass env — proves the session passphrase
 * is correct WITHOUT loading the key into any agent. Output (the public key)
 * is captured, never inherited. */
export async function verifyKey(opts: {
  keyPath: string;
  fingerprint: string;
  askpassScriptPath?: string;
  socketPath?: string;
  token?: string;
}): Promise<boolean> {
  if (!opts.askpassScriptPath || !(opts.socketPath && opts.token)) return false;
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.SSH_ASKPASS = opts.askpassScriptPath;
  env.SSH_ASKPASS_REQUIRE = 'force';
  env.DISPLAY = env.DISPLAY ?? ':0';
  env.GIT_COLABOR_ASKPASS_SOCK = opts.socketPath;
  env.GIT_COLABOR_ASKPASS_TOKEN = opts.token;
  env.GIT_COLABOR_FINGERPRINT = opts.fingerprint;
  const verifyQuiet = (args: string[]): Promise<number> =>
    new Promise((resolve) => {
      const child = spawn('ssh-keygen', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.on('error', () => {
        clearTimeout(killTimer);
        resolve(127);
      });
      child.on('close', (c) => {
        clearTimeout(killTimer);
        resolve(c ?? 127);
      });
    });
  // `-P ''` reads the passphrase via askpass; fall back to the classic prompt form
  const verify = await verifyQuiet(['-y', '-P', '', '-f', opts.keyPath]).then((c) =>
    c === 0 ? Promise.resolve(0) : verifyQuiet(['-y', '-f', opts.keyPath]),
  );
  return verify === 0;
}
