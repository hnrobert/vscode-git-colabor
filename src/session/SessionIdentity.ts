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
  /** key path backing the window-scoped signing toggle (`.pub` when agent-held) */
  signingKey?: string;
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
  private signingOn = false;
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

  /** Is window-scoped commit signing on? */
  signing(): boolean {
    return this.signingOn && !!this.current?.signingKey;
  }

  /**
   * Apply an identity to THIS window only. No repo writes, no heldBy.
   * Switching to a DIFFERENT identity drops the signing toggle (it belongs
   * to the previous identity's key).
   */
  async apply(identity: { id: string; name: string; email: string; hasKey?: boolean; sshKeyPath?: string }): Promise<void> {
    if (this.current && this.current.id !== identity.id) this.signingOn = false;
    let sshCommand: string | undefined;
    if (identity.hasKey && identity.sshKeyPath) {
      const wrapper = await this.ensureAskpassWrapper();
      sshCommand = `SSH_ASKPASS="${wrapper}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh -i ${identity.sshKeyPath} -o IdentitiesOnly=yes`;
    }
    this.current = { id: identity.id, name: identity.name, email: identity.email, sshCommand };
    await this.rebuild();
    this.log.info(`session identity set: ${identity.name} <${identity.email}> (this window only)`);
    this.onChange?.();
  }

  /**
   * Window-scoped commit signing with an identity's key — injected through
   * the same env mechanism as the identity, so commits made in THIS window
   * sign and nothing is ever written to repo config. `keyPath` should be
   * the `.pub` sibling when the key is agent-held (see signingKeyPath).
   */
  async setSigning(keyPath: string | undefined): Promise<void> {
    if (!this.current) return;
    this.current.signingKey = keyPath;
    this.signingOn = !!keyPath;
    await this.rebuild();
    this.log.info(`session signing ${keyPath ? `ON (${keyPath})` : 'OFF'} (this window only)`);
    this.onChange?.();
  }

  clear(): void {
    if (!this.current) return;
    this.log.info(`session identity cleared (${this.current.name})`);
    this.current = undefined;
    this.signingOn = false;
    injectConfig([]);
    this.onChange?.();
  }

  /** Rebuild the full env injection from the current identity + signing state. */
  private async rebuild(): Promise<void> {
    const s = this.current;
    if (!s) {
      injectConfig([]);
      return;
    }
    const pairs: Array<[string, string]> = [
      ['user.name', s.name],
      ['user.email', s.email],
    ];
    if (s.sshCommand) pairs.push(['core.sshCommand', s.sshCommand]);
    if (this.signingOn && s.signingKey) {
      pairs.push(
        ['commit.gpgsign', 'true'],
        ['gpg.format', 'ssh'],
        ['user.signingKey', s.signingKey],
        ['gpg.ssh.program', await this.ensureSignWrapper()],
      );
    }
    injectConfig(pairs);
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
    return this.idempotentWrite(wrapperPath, content);
  }

  /**
   * The signing wrapper for gpg.ssh.program — mirrors the CLI's
   * ensureSignWrapper (SSH_ASKPASS prefix + `-f <key>` extraction so the
   * askpass helper can fingerprint the key on bare prompts).
   */
  private async ensureSignWrapper(): Promise<string> {
    const wrapperPath = join(colaborDir(), 'sign-wrapper.sh');
    const askpass = await this.ensureAskpassWrapper();
    const content = [
      '#!/bin/sh',
      'signkey=',
      'prev=',
      'for a in "$@"; do',
      '  if [ "$prev" = "-f" ]; then signkey="$a"; break; fi',
      '  prev="$a"',
      'done',
      `SSH_ASKPASS="${askpass}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 GIT_COLABOR_SIGNING_KEY="$signkey" exec ssh-keygen "$@"`,
      '',
    ].join('\n');
    return this.idempotentWrite(wrapperPath, content);
  }

  private async idempotentWrite(path: string, content: string): Promise<string> {
    try {
      const existing = await readFile(path, 'utf8');
      if (existing === content) return path;
    } catch {
      // not there yet — write below
    }
    await writeFile(path, content, { mode: 0o700 });
    await chmod(path, 0o700);
    return path;
  }
}
