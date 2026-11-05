/**
 * Config-driven identity resolution: the repo's effective git config is the
 * single source of truth for who is active. Matching cascade:
 *   1. user.email (case-insensitive) narrows the candidates
 *   2. user.name (trim + case-insensitive) narrows further
 *   3. the key referenced by core.sshCommand / user.signingKey discriminates
 * An effective (name, email) with no store match auto-enrolls as a new
 * identity (deterministic id — idempotent). Key preferences discovered in
 * config update the identity's key bindings.
 */

import { getEffectiveConfig } from '../git/config.js';
import { addIdentity, getKeyBinding, idOf, listIdentities, setPushKey, setSignKey } from './map.js';
import { fingerprintOfFile } from './keys.js';
import type { Identity, SshKeyRef } from '../types.js';

export type ResolvedActive = {
  identity: Identity;
  /** auto-enrolled during this resolution (new store entry) */
  enrolled: boolean;
  /** key preferences exist for this identity */
  keyPref: { push: boolean; sign: boolean };
};

const norm = (s: string): string => s.trim().toLowerCase();

/** Extract the `-i <path>` key path from an ssh command string. */
export function keyPathFromSshCommand(cmd: string | undefined): string | undefined {
  if (!cmd) return undefined;
  const m = cmd.match(/(?:^|\s)-i\s+(\S+)/);
  return m?.[1];
}

/** Fingerprint a key file, or undefined when unreadable. */
async function fpOf(path: string): Promise<string | undefined> {
  try {
    return await fingerprintOfFile(path);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the active identity from the repo's effective config. Returns
 * undefined when config carries no (name, email) or nothing matches and
 * enrollment is off.
 */
export async function resolveActive(
  cwd: string | undefined,
  opts: { enroll?: boolean } = {},
): Promise<ResolvedActive | undefined> {
  const [n, e] = await Promise.all([
    getEffectiveConfig('user.name', cwd),
    getEffectiveConfig('user.email', cwd),
  ]);
  if (!n?.value || !e?.value) return undefined;
  const name = n.value;
  const email = e.value;

  const { identities } = await listIdentities();

  // 1+2: email then name — (name, email) is the primary key. A config name
  // that differs from every same-email row is a DIFFERENT identity (a
  // shared address like noreply@github.com must not collapse people).
  let match: Identity | undefined = identities.find(
    (i) => norm(i.email) === norm(email) && norm(i.name) === norm(name),
  );

  let enrolled = false;
  if (!match) {
    if (!opts.enroll) return undefined;
    // auto-enroll: deterministic id makes this idempotent
    match = await addIdentity({ name, email, scope: 'machine', fromConfig: true });
    enrolled = true;
  }

  // 3: key discrimination — when the config references a key that differs
  // from the stored preference, UPDATE the binding (key rotation is a normal
  // event, not an identity fork)
  const sshCmd = await getEffectiveConfig('core.sshCommand', cwd);
  const cfgPushPath = keyPathFromSshCommand(sshCmd?.value);
  if (cfgPushPath) {
    const fp = await fpOf(cfgPushPath);
    const binding = await getKeyBinding(idOf(match.name, match.email));
    if (!binding.pushKey || binding.pushKey.path !== cfgPushPath || (fp && binding.pushKey.fingerprint !== fp)) {
      const ref: SshKeyRef = { path: cfgPushPath, fingerprint: fp ?? binding.pushKey?.fingerprint ?? '' };
      await setPushKey(idOf(match.name, match.email), ref);
    }
  }
  const signKeyCfg = await getEffectiveConfig('user.signingKey', cwd);
  const gpgFormat = await getEffectiveConfig('gpg.format', cwd);
  if (signKeyCfg?.value) {
    const binding = await getKeyBinding(idOf(match.name, match.email));
    const cur = binding.signKey;
    if (gpgFormat?.value === 'openpgp') {
      if (!cur || cur.format !== 'openpgp' || cur.key !== signKeyCfg.value) {
        await setSignKey(idOf(match.name, match.email), { format: 'openpgp', key: signKeyCfg.value });
      }
    } else {
      // ssh signing: the value is the private key path (or .pub when agent-held)
      const path = signKeyCfg.value.replace(/\.pub$/, '');
      if (!cur || cur.format !== 'ssh' || cur.path !== path) {
        const fp = await fpOf(path);
        if (fp) await setSignKey(idOf(match.name, match.email), { format: 'ssh', path, fingerprint: fp });
      }
    }
  }

  const finalBinding = await getKeyBinding(idOf(match.name, match.email));
  return {
    identity: match,
    enrolled,
    keyPref: { push: !!finalBinding.pushKey, sign: !!finalBinding.signKey },
  };
}
