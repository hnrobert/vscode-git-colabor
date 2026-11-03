import { topLevel } from '../git/rev.js';
import { getIdentity, getKeyBinding, listIdentities, markStandingDown } from './map.js';
import { resolveActive } from './resolve.js';
import { removeKey } from './agent.js';
import { appendAudit } from '../logging/audit.js';
import { Errors } from '../errors.js';
import type { Source } from '../types.js';

async function safeTopLevel(cwd?: string): Promise<string | undefined> {
  try {
    return await topLevel(cwd);
  } catch {
    return undefined;
  }
}

/**
 * Logout an identity's key: remove it from ssh-agent; when the identity is
 * the config-derived ACTIVE one in this repo, also clear its git-config
 * layer (user.name/email/sshCommand/signing) so the repo stops using it.
 * Does NOT remove the identity from the map (use `rm`). Key files are
 * referenced, never touched.
 */
export async function logoutIdentity(opts: {
  source: Source;
  cwd?: string;
  id?: string;
  /** false = keep the key in ssh-agent (the extension asks first) */
  removeAgentKey?: boolean;
}): Promise<{
  identity: { id: string; name: string; fingerprint?: string };
  agentRemoved: boolean;
  /** what was removed from the repo's git config (agent is above) */
  cleared: { agent: boolean; config: boolean; sshCommand: boolean; signing: boolean };
}> {
  const resolved = await resolveActive(opts.cwd);
  let id = opts.id ?? resolved?.identity.id;
  if (!id) {
    const { identities } = await listIdentities();
    if (identities.length === 1) id = identities[0].id;
    else throw Errors.usage('no active identity — specify one: git colabor identity logout <id>');
  }
  const identity = await getIdentity(id);
  const binding = await getKeyBinding(id);

  const agentRemoved = opts.removeAgentKey === false ? false : binding.pushKey ? await removeKey(binding.pushKey.path) : false;

  // config layer: the identity's name/email clear on match, and any KEY
  // configs referencing its keys go too — a previous `use` can leave them
  // behind after the repo moved on to someone else. When the identity IS
  // the config-derived active one its key configs drop unconditionally.
  // A global-scope `use` wrote ~/.gitconfig — the same content-matched clear
  // runs there (never forced: another person's global config survives).
  const { clearIdentityConfigLayer } = await import('./configClear.js');
  const layer = {
    name: identity.name,
    email: identity.email,
    pushKeyPath: binding.pushKey?.path,
    signKey: binding.signKey,
  };
  const cleared = await clearIdentityConfigLayer(layer, {
    cwd: opts.cwd,
    forceKeys: resolved?.identity.id === id,
  });
  const globalCleared = await clearIdentityConfigLayer(layer, { scope: 'global' });
  const clearedAnything = cleared.identityLayer || cleared.sshCommand || cleared.signing || globalCleared.identityLayer || globalCleared.sshCommand || globalCleared.signing;
  // co-author selection + commit template ride along when the identity's
  // config layer went away — logout leaves the repo with zero
  // colabor-managed state
  if (cleared.identityLayer) {
    const { unsetAllConfig } = await import('../git/config.js');
    const { clearTemplate } = await import('../message/template.js');
    await unsetAllConfig('colabor.selected', 'local', opts.cwd);
    await clearTemplate(opts.cwd).catch(() => {});
  }
  // logout = leave clean: auto-apply must not re-materialize the identity
  // into this repo on the next repo event
  if (cleared.identityLayer || cleared.sshCommand || cleared.signing) {
    const tl = await safeTopLevel(opts.cwd);
    if (tl) await markStandingDown(tl);
  }

  await appendAudit({
    action: 'identity.logout',
    source: opts.source,
    identity: identity.id,
    identityName: identity.name,
    fingerprint: binding.pushKey?.fingerprint,
    repo: await safeTopLevel(opts.cwd),
    message: clearedAnything
      ? `cleared ${[cleared.identityLayer ? 'config' : null, cleared.sshCommand ? 'ssh key' : null, cleared.signing ? 'sign key' : null]
          .filter(Boolean)
          .join(' + ')} + agent`
      : 'agent only',
  });

  return {
    identity: { id: identity.id, name: identity.name, fingerprint: binding.pushKey?.fingerprint },
    agentRemoved,
    cleared: {
      agent: agentRemoved,
      config: cleared.identityLayer,
      sshCommand: cleared.sshCommand,
      signing: cleared.signing,
    },
  };
}
