import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { colaborDir } from '../askpass/AskpassServer.js';

/**
 * Per-WINDOW identity: applied by injecting git config through the
 * environment (`GIT_CONFIG_COUNT/KEY_n/VALUE_n`, git ≥ 2.31) instead of
 * writing repo config. The vscode.git extension runs in the SAME extension
 * host process, so every git commit/push it spawns inherits these and they
 * take precedence over repo config. Each window has its own extension host,
 * so the identity is scoped to this window by construction — other windows
 * connected to the same workspace keep theirs, and closing the window
 * leaves the repo completely untouched.
 */
export type SessionIdentity = {
  id: string;
  name: string;
  email: string;
  /** full askpass-prefixed `ssh -i …` command when the identity has a usable key */
  sshCommand?: string;
};

/** Inject config pairs (empty = strip everything). */
function injectConfig(pairs: Array<[string, string]>): void {
  // sweep a fixed surplus so leftovers from a larger previous injection die too
  const prev = Number(process.env.GIT_CONFIG_COUNT ?? '0');
  for (let i = 0; i < Math.max(prev, 32); i++) {
    delete process.env[`GIT_CONFIG_KEY_${i}`];
    delete process.env[`GIT_CONFIG_VALUE_${i}`];
  }
  delete process.env.GIT_CONFIG_COUNT;
  if (pairs.length === 0) return;
  process.env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = k;
    process.env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
}

export class SessionIdentityController {
  private current?: SessionIdentity;
  /** notified on every apply/clear so the tree can overlay + reload */
  onChange?: () => void;

  constructor(
    private readonly askpassScriptPath: string | undefined,
    private readonly log: { info(msg: string): void; warn(msg: string): void },
  ) {}

  get(): SessionIdentity | undefined {
    return this.current;
  }

  /** Is a session-scoped identity active (repo config untouched)? */
  active(): boolean {
    return this.current !== undefined;
  }

  /** Apply an identity to THIS window only. No repo writes, no heldBy. */
  async apply(identity: { id: string; name: string; email: string; hasKey?: boolean; sshKeyPath?: string }): Promise<void> {
    let sshCommand: string | undefined;
    if (identity.hasKey && identity.sshKeyPath) {
      const wrapper = await this.ensureAskpassWrapper();
      sshCommand = `SSH_ASKPASS="${wrapper}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh -i ${identity.sshKeyPath} -o IdentitiesOnly=yes`;
    }
    this.current = { id: identity.id, name: identity.name, email: identity.email, sshCommand };
    injectConfig([
      ['user.name', identity.name],
      ['user.email', identity.email],
      ...(sshCommand ? [['core.sshCommand', sshCommand] as [string, string]] : []),
    ]);
    this.log.info(`session identity set: ${identity.name} <${identity.email}> (this window only)`);
    this.onChange?.();
  }

  clear(): void {
    if (!this.current) return;
    this.log.info(`session identity cleared (${this.current.name})`);
    this.current = undefined;
    injectConfig([]);
    this.onChange?.();
  }

  /**
   * The executable SSH_ASKPASS wrapper around the bundled askpass.cjs
   * (ssh execve()s SSH_ASKPASS, so the .cjs needs a shell shim re-execing it
   * with this Node). Same file the CLI writes; content-compared, idempotent.
   */
  private async ensureAskpassWrapper(): Promise<string> {
    const wrapperPath = join(colaborDir(), 'askpass-wrapper.sh');
    if (!this.askpassScriptPath) return wrapperPath;
    const content = `#!/bin/sh\nexec "${process.execPath}" "${this.askpassScriptPath}" "$@"\n`;
    try {
      const existing = await readFile(wrapperPath, 'utf8');
      if (existing === content) return wrapperPath;
    } catch {
      // not there yet — write below
    }
    await writeFile(wrapperPath, content, { mode: 0o700 });
    await chmod(wrapperPath, 0o700);
    return wrapperPath;
  }
}
