import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setConfig, unsetConfig } from '../git/config.js';
import { dataDir } from '../paths.js';
import { topLevel } from '../git/rev.js';
import { appendAudit } from '../logging/audit.js';
import { keyInAgent } from './agent.js';
import { clearStandingDown, getIdentity, getKeyBinding, setPushKey } from './map.js';
import { keyUsable, fingerprintOfFile } from './keys.js';
import { disableSigning, writeIdentitySigning } from './sign.js';
import { discoverSessionBridge } from '../secrets/session-bridge.js';
import { getConfig } from '../git/config.js';
import type { Identity, Source } from '../types.js';

export type ApplyOpts = {
  source: Source;
  cwd?: string;
  /** askpass bridge (push-time passphrase delivery) */
  askpassScriptPath?: string;
  socketPath?: string;
  token?: string;
  /** which git-config file the identity is written to (default: repo-local) */
  configScope?: 'local' | 'global';
};

export type ApplyResult = {
  name: string;
  email: string;
  sshCommand?: string;
  /** did the push key actually make it into the apply (false = degraded)? */
  keyApplied: boolean;
  /** key preferred but the file was missing/unreadable */
  keyMissing?: boolean;
  /** key preferred but no passphrase could be obtained at apply time */
  keyDegraded?: boolean;
  /** is the push key fingerprint currently held by ssh-agent */
  agent?: { inAgent: boolean };
};

async function safeTopLevel(cwd?: string): Promise<string | undefined> {
  try {
    return await topLevel(cwd);
  } catch {
    return undefined;
  }
}

/**
 * The single writer: repo-local STANDARD git keys only — user.name /
 * user.email / core.sshCommand / signing keys. No colabor.* markers, no
 * state.json, no backups, no session locks: the repo reads as if a human
 * configured it, and the active identity is derived from config at status
 * time (see resolve.ts).
 */
export async function applyResolvedIdentity(args: {
  name: string;
  email: string;
  sshCommand?: string;
  identity?: Identity;
  opts: ApplyOpts;
}): Promise<ApplyResult> {
  const { name, email, sshCommand, identity, opts } = args;
  const scope = opts.configScope === 'global' ? 'global' : 'local';

  await setConfig('user.name', name, scope, opts.cwd);
  await setConfig('user.email', email, scope, opts.cwd);
  if (sshCommand) {
    await setConfig('core.sshCommand', sshCommand, scope, opts.cwd);
  } else if (identity) {
    // no key in effect — a leftover key from a previous identity is exactly
    // what triggers stray passphrase prompts; clear it
    await unsetConfig('core.sshCommand', scope, opts.cwd);
    // signing follows the identity: no key to sign with → really off
    const gpgsign = await getConfig('commit.gpgsign', scope, opts.cwd);
    if (gpgsign === 'true') await disableSigning(opts.cwd, scope);
  }

  // report-only: is the push key already in the agent?
  const binding = identity ? await getKeyBinding(identity.id) : undefined;
  let agent: ApplyResult['agent'];
  if (binding?.pushKey) {
    agent = { inAgent: await keyInAgent(binding.pushKey.fingerprint) };
  }

  // an explicit LOCAL apply re-arms auto-apply for this repo (it may have
  // been standing down since an "unset in git repo config")
  if (scope === 'local') {
    const tl = await safeTopLevel(opts.cwd);
    if (tl) await clearStandingDown(tl);
  }

  await appendAudit({
    action: 'identity.use',
    source: opts.source,
    identity: identity?.id,
    identityName: identity?.name ?? name,
    fingerprint: binding?.pushKey?.fingerprint,
    repo: await safeTopLevel(opts.cwd),
  });

  return { name, email, sshCommand, keyApplied: !!sshCommand, agent };
}

/**
 * The executable SSH_ASKPASS wrapper around the bundled askpass.cjs.
 * Content-compared, idempotent.
 */
export async function ensureAskpassWrapper(askpassScriptPath: string): Promise<string> {
  const wrapperPath = join(dataDir(), 'askpass-wrapper.sh');
  const content = `#!/bin/sh\nexec "${process.execPath}" "${askpassScriptPath}" "$@"\n`;
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

/**
 * Resolve an identity, then apply it. The push key is a PREFERENCE from the
 * bindings table — applied best-effort: file missing or passphrase
 * unavailable → degraded apply (identity switches, key does not).
 */
export async function applyIdentity(
  id: string,
  opts: ApplyOpts & { asName?: string; asEmail?: string },
): Promise<{ identity: Identity; result: ApplyResult }> {
  const identity = await getIdentity(id);
  const binding = await getKeyBinding(id);
  const push = binding.pushKey;

  let sshCommand: string | undefined;
  let keyMissing = false;
  const keyDegraded = false;

  if (push) {
    if (await keyUsable(push.path)) {
      // self-heal the derived fingerprint (file may have been rotated)
      const fp = await fingerprintOfFile(push.path).catch(() => undefined);
      if (fp && fp !== push.fingerprint) {
        await setPushKey(id, { ...push, fingerprint: fp });
        push.fingerprint = fp;
      }
      const bare = `ssh -i ${push.path} -o IdentitiesOnly=yes`;
      // Bake the SSH_ASKPASS prefix only when the extension bridge is
      // reachable; REQUIRE=force kills the tty fallback, so a bare bridge-less
      // bake would break every push for pure-CLI users
      const bridge = (opts.socketPath && opts.token) || discoverSessionBridge();
      if (opts.askpassScriptPath && bridge) {
        const wrapper = await ensureAskpassWrapper(opts.askpassScriptPath);
        sshCommand = `SSH_ASKPASS="${wrapper}" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ${bare}`;
      } else {
        sshCommand = bare;
      }
    } else {
      keyMissing = true;
    }
  }

  const result = await applyResolvedIdentity({
    name: opts.asName ?? identity.name,
    email: opts.asEmail ?? identity.email,
    sshCommand,
    identity,
    opts,
  });
  result.keyMissing = keyMissing;
  result.keyDegraded = keyDegraded;

  // signing re-bind: when the target scope signs, point it at this identity's sign key
  if (identity) {
    const scope = opts.configScope === 'global' ? 'global' : 'local';
    const gpgsign = await getConfig('commit.gpgsign', scope, opts.cwd);
    if (gpgsign === 'true') {
      const okSign = await writeIdentitySigning(identity, opts.cwd, opts.askpassScriptPath, scope);
      if (!okSign) await disableSigning(opts.cwd, scope);
    }
  }

  return { identity, result };
}
