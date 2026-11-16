import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
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
  /** per-identity signing preference — identities that signed before sign again */
  signCommits?: boolean;
  /** override the injected committer fields (keys/signing still follow the identity) */
  asName?: string;
  asEmail?: string;
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
    /** mirrors the injection into INTEGRATED TERMINALS (new shells don't
     *  inherit the extension host's env — a terminal `git push` used to fall
     *  back to ~/.ssh.config / the agent and push with the wrong key) */
    private readonly terminalEnv?: vscode.EnvironmentVariableCollection,
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
    // asName/asEmail override the COMMITTER fields only; the key binding
    // and signing preference still follow the identity itself
    this.current = {
      id: identity.id,
      name: identity.asName ?? identity.name,
      email: identity.asEmail ?? identity.email,
      sshCommand,
      signingKey,
    };
    // signing follows the identity: a stored preference re-enables it, and a
    // key-less identity can never keep it on
    if (identity.signCommits && signingKey) this.signingMode = 'identity';
    else if (this.signingMode === 'identity' && !signingKey) this.signingMode = 'off';
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
    for (const k of ['GIT_SSH_COMMAND', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'])
      delete process.env[k];
    this.mirrorToTerminals([]);
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
    // Belt-and-braces: the same state as PLAIN env vars. GIT_CONFIG_* needs
    // git ≥ 2.31 (older hosts silently ignore the whole layer — wrong key on
    // push, wrong committer), while these have worked since forever and
    // outrank every config file:
    //   GIT_SSH_COMMAND > core.sshCommand
    //   GIT_AUTHOR_/GIT_COMMITTER_* > user.name / user.email
    // Signing stays on GIT_CONFIG_* only (no plain env var exists for it).
    const setOrDelete = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    setOrDelete('GIT_SSH_COMMAND', s?.sshCommand);
    setOrDelete('GIT_AUTHOR_NAME', s?.name);
    setOrDelete('GIT_AUTHOR_EMAIL', s?.email);
    setOrDelete('GIT_COMMITTER_NAME', s?.name);
    setOrDelete('GIT_COMMITTER_EMAIL', s?.email);
    this.mirrorToTerminals(pairs);
  }

  /**
   * Same GIT_CONFIG_* pairs into this window's INTEGRATED TERMINALS via the
   * environment variable collection. The collection is per-extension and
   * sticky across reloads, so it is rebuilt wholesale each time (and cleared
   * on session clear) — applied to terminals created after the change;
   * already-open terminals keep their original environment.
   */
  private mirrorToTerminals(pairs: Array<[string, string]>): void {
    const c = this.terminalEnv;
    if (!c) return;
    try {
      // plain env vars first — they work on any git version
      const s = this.current;
      const direct: Array<[string, string | undefined]> = [
        ['GIT_SSH_COMMAND', s?.sshCommand],
        ['GIT_AUTHOR_NAME', s?.name],
        ['GIT_AUTHOR_EMAIL', s?.email],
        ['GIT_COMMITTER_NAME', s?.name],
        ['GIT_COMMITTER_EMAIL', s?.email],
      ];
      for (const [k, v] of direct) {
        if (v === undefined) c.delete(k);
        else c.replace(k, v);
      }
      // GIT_CONFIG_* pairs (signing + config parity) on top
      c.delete('GIT_CONFIG_COUNT');
      for (let i = 0; i < 32; i++) {
        c.delete(`GIT_CONFIG_KEY_${i}`);
        c.delete(`GIT_CONFIG_VALUE_${i}`);
      }
      if (pairs.length === 0) return;
      c.replace('GIT_CONFIG_COUNT', String(pairs.length));
      pairs.forEach(([k, v], i) => {
        c.replace(`GIT_CONFIG_KEY_${i}`, k);
        c.replace(`GIT_CONFIG_VALUE_${i}`, v);
      });
    } catch (e) {
      this.log.warn(`terminal env mirror failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
