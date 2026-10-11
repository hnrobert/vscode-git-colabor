import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { colaborDir } from '../askpass/AskpassServer.js';
import { identitySigningKey, type SigningKey, type WindowSigning } from './signing.js';

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
  /** the identity's own signing key — GPG if bound, else SSH (`.pub` when agent-held) */
  signingKey?: SigningKey;
};

type ApplyInput = {
  id: string;
  name: string;
  email: string;
  hasKey?: boolean;
  sshKeyPath?: string;
  inAgent?: boolean;
  gpgKey?: string;
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
  /** this window's signing: with the identity's key / Stop / untouched (config files decide) */
  private signingMode: 'identity' | 'off' | undefined;
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

  /** This window's signing layer (undefined = untouched — repo / global config decides). */
  signing(): WindowSigning {
    if (this.signingMode === 'off') return 'off';
    return this.signingMode === 'identity' ? this.current?.signingKey : undefined;
  }

  /**
   * Apply an identity to THIS window only. No repo writes, no heldBy.
   * Window signing follows the identity (like the CLI's re-bind on `use`):
   * while on, it moves to the new identity's key, or turns OFF when that
   * identity has none — never silently falling back to a repo/global key.
   */
  async apply(identity: ApplyInput): Promise<void> {
    let sshCommand: string | undefined;
    if (identity.hasKey && identity.sshKeyPath) {
      const wrapper = await this.ensureAskpassWrapper();
      sshCommand = `SSH_ASKPASS="${wrapper}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh -i ${identity.sshKeyPath} -o IdentitiesOnly=yes`;
    }
    const signingKey = identitySigningKey(identity);
    this.current = { id: identity.id, name: identity.name, email: identity.email, sshCommand, signingKey };
    if (this.signingMode === 'identity' && !signingKey) this.signingMode = 'off';
    await this.rebuild();
    this.log.info(`session identity set: ${identity.name} <${identity.email}> (this window only)`);
    this.onChange?.();
  }

  /**
   * Window-scoped commit signing, injected next to the identity so nothing
   * is ever written to a config file. On signs with the current identity's
   * key; off (Stop) injects `commit.gpgsign=false` — env config outranks
   * every config file, so neither repo nor global config can keep signing.
   * Off needs no session identity.
   */
  async setSigning(on: boolean): Promise<void> {
    const key = this.current?.signingKey;
    if (on && !key) return; // callers apply a keyed identity first
    this.signingMode = on ? 'identity' : 'off';
    await this.rebuild();
    this.log.info(`session signing ${on && key ? `ON (${key.format} ${key.key})` : 'OFF'} (this window only)`);
    this.onChange?.();
  }

  clear(): void {
    if (!this.current && !this.signingMode) return;
    this.log.info(`session identity cleared (${this.current?.name ?? 'signing only'})`);
    this.current = undefined;
    this.signingMode = undefined;
    injectConfig([]);
    this.onChange?.();
  }

  /** Rebuild the full env injection from the current identity + signing state. */
  private async rebuild(): Promise<void> {
    const s = this.current;
    const pairs: Array<[string, string]> = [];
    if (s) {
      pairs.push(['user.name', s.name], ['user.email', s.email]);
      if (s.sshCommand) pairs.push(['core.sshCommand', s.sshCommand]);
    }
    const sign = this.signing();
    if (sign === 'off') {
      pairs.push(['commit.gpgsign', 'false']);
    } else if (sign) {
      pairs.push(['commit.gpgsign', 'true'], ['gpg.format', sign.format], ['user.signingKey', sign.key]);
      // OpenPGP keeps the user's own gpg.program and gpg-agent pinentry
      if (sign.format === 'ssh') pairs.push(['gpg.ssh.program', await this.ensureSignWrapper()]);
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
