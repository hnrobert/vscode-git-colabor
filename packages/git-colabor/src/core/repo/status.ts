import { getConfig } from '../git/config.js';
import { insideWorkTree, topLevel } from '../git/rev.js';
import { getSelected } from '../coauthors/state.js';
import { listIdentities } from '../identity/map.js';
import { genKey } from '../authors/types.js';
import { readState } from './state.js';
import type { HeldBy } from '../types.js';

export type CoAuthorBrief = { key: string; name: string; email: string };

export type RepoStatus = {
  inRepo: boolean;
  repo: string | null;
  managed: boolean;
  managedBy: string | null;
  activeIdentityId: string | null;
  heldBy: HeldBy | null;
  selected: CoAuthorBrief[];
  available: CoAuthorBrief[];
};

/**
 * Snapshot of a repo's colabor state: managed markers, active identity, selected + available
 * co-authors. Used by the CLI `identity status` command and (transitively) the extension TreeView.
 */
export async function repoStatus(cwd?: string): Promise<RepoStatus> {
  const inRepo = cwd ? await insideWorkTree(cwd) : false;
  if (!inRepo) {
    return {
      inRepo: false,
      repo: cwd ?? null,
      managed: false,
      managedBy: null,
      activeIdentityId: null,
      heldBy: null,
      selected: [],
      available: [],
    };
  }
  const [managed, managedBy, state, selected, identityMap] = await Promise.all([
    getConfig('colabor.managed', 'local', cwd),
    getConfig('colabor.managed-by', 'local', cwd),
    readState(cwd),
    getSelected(cwd),
    listIdentities(),
  ]);
  const selectedEmails = new Set(selected.map((a) => a.email));
  const available = identityMap.identities
    .filter((i) => !selectedEmails.has(i.email))
    .map((i) => ({ key: genKey(i.name, i.email), name: i.name, email: i.email }));
  return {
    inRepo: true,
    // canonical repo root (topLevel resolves symlinks, e.g. /var →
    // /private/var on macOS) — the standing-down store and every per-repo
    // comparison key off this exact form
    repo: await topLevel(cwd),
    managed: managed === 'true',
    managedBy: managedBy ?? null,
    activeIdentityId: state.activeIdentity ?? null,
    heldBy: state.heldBy ?? null,
    selected: selected.map(toBrief),
    available,
  };
}

function toBrief(a: { key: string; name: string; email: string }): CoAuthorBrief {
  return { key: a.key, name: a.name, email: a.email };
}
