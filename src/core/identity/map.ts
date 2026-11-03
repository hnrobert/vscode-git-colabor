import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Errors } from '../errors.js';
import { mapPath } from '../paths.js';
import { atomicWriteJson } from '../io.js';
import type { Identity, IdentityMap, KeyBinding, SshKeyRef, SignKeyRef } from '../types.js';

/** Deterministic identity id: stable across key changes and re-adding (idempotent auto-enroll). */
export function identityId(name: string, email: string): string {
  return 'id_' + createHash('sha256').update(`${name}\n${email}`).digest('hex').slice(0, 12);
}

export async function readMap(): Promise<IdentityMap> {
  try {
    const txt = await readFile(mapPath(), 'utf8');
    const parsed = JSON.parse(txt) as Partial<IdentityMap>;
    const identities = { ...parsed.identities };
    const keyBindings: Record<string, KeyBinding> = { ...(parsed.keyBindings ?? {}) };
    for (const id of Object.keys(identities)) {
      const row = identities[id] as Identity & {
        // legacy fields (pre keyBindings) — migrated below
        sshKeyPath?: string;
        sshKeyFingerprint?: string;
        sshKeyEncrypted?: boolean;
        gpgKey?: string;
        passphraseCommand?: string;
        disabled?: boolean;
        remoteKeys?: Record<string, string>;
        scope?: string;
      };
      // migrate the single-slot key into the bindings table (once)
      if (row.sshKeyPath && row.sshKeyFingerprint && !keyBindings[id]?.pushKey) {
        const ref: SshKeyRef = { path: row.sshKeyPath, fingerprint: row.sshKeyFingerprint };
        if (row.sshKeyEncrypted) ref.encrypted = true;
        const existing = keyBindings[id] ?? {};
        keyBindings[id] = { ...existing, pushKey: ref };
      }
      if (row.gpgKey && !keyBindings[id]?.signKey) {
        const existing = keyBindings[id] ?? {};
        keyBindings[id] = { ...existing, signKey: { format: 'openpgp', key: row.gpgKey } };
      }
      // strip legacy fields so they vanish on next write
      delete row.sshKeyPath;
      delete row.sshKeyFingerprint;
      delete row.sshKeyEncrypted;
      delete row.gpgKey;
      delete row.passphraseCommand;
      delete row.disabled;
      delete row.remoteKeys;
      const legacyScope = row.scope as string | undefined;
      if (legacyScope === 'user' || legacyScope === 'vscode') row.scope = 'machine';
    }
    const migrated = {
      schemaVersion: 1,
      identities,
      keyBindings,
      defaultIdentity: parsed.defaultIdentity,
      hidden: parsed.hidden,
      standingDown: parsed.standingDown,
    } satisfies IdentityMap;
    // persist the migration immediately so a read-only command (ls/status)
    // still lands the new keyBindings on disk
    if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
      await writeMap(migrated);
    }
    return migrated;
  } catch {
    return { schemaVersion: 1, identities: {} };
  }
}

export async function writeMap(map: IdentityMap): Promise<void> {
  await atomicWriteJson(mapPath(), map, 0o600);
}

export async function getIdentity(id: string): Promise<Identity> {
  const map = await readMap();
  const found = map.identities[id];
  if (!found) throw Errors.usage(`identity "${id}" not found`);
  return found;
}

/** Find an identity by (name, email) — the uniqueness key. */
export async function findIdentity(name: string, email: string): Promise<Identity | undefined> {
  const map = await readMap();
  return Object.values(map.identities).find(
    (i) => i.email.toLowerCase() === email.toLowerCase() && i.name.trim() === name.trim(),
  );
}

export type NewIdentity = Omit<Identity, 'id' | 'createdAt'> & { id?: string };

export async function addIdentity(input: NewIdentity): Promise<Identity> {
  const map = await readMap();
  const id = input.id ?? identityId(input.name, input.email);
  const identity: Identity = { ...input, id, createdAt: new Date().toISOString() };
  if (map.identities[id]) return map.identities[id]; // idempotent (deterministic id)
  map.identities[id] = identity;
  // a manual add of a previously hidden committer un-hides it for future imports
  if (map.hidden?.[identity.email.toLowerCase()]) delete map.hidden[identity.email.toLowerCase()];
  await writeMap(map);
  return identity;
}

/** Patch editable fields of an identity (name/email/scope). */
export async function updateIdentity(
  id: string,
  patch: Partial<Pick<Identity, 'name' | 'email' | 'scope' | 'host' | 'fromConfig'>>,
): Promise<Identity> {
  const map = await readMap();
  const identity = map.identities[id];
  if (!identity) throw Errors.usage(`identity "${id}" not found`);
  map.identities[id] = { ...identity, ...patch };
  await writeMap(map);
  return map.identities[id];
}

// --- key bindings (preference records, machine scope by construction) ---

export async function getKeyBinding(id: string): Promise<KeyBinding> {
  const map = await readMap();
  return map.keyBindings?.[id] ?? {};
}

export async function setKeyBinding(id: string, binding: KeyBinding): Promise<void> {
  const map = await readMap();
  if (!map.identities[id]) throw Errors.usage(`identity "${id}" not found`);
  map.keyBindings = { ...map.keyBindings, [id]: binding };
  await writeMap(map);
}

export async function setPushKey(id: string, ref: SshKeyRef | undefined): Promise<void> {
  const b = await getKeyBinding(id);
  await setKeyBinding(id, { ...b, pushKey: ref });
}

export async function setSignKey(id: string, ref: SignKeyRef | undefined): Promise<void> {
  const b = await getKeyBinding(id);
  await setKeyBinding(id, { ...b, signKey: ref });
}

/** Record the per-identity commit-signing preference (re-applied on every later use). */
export async function setSignCommits(id: string, on: boolean): Promise<void> {
  const b = await getKeyBinding(id);
  await setKeyBinding(id, { ...b, signCommits: on ? true : undefined });
}

/** Hide an email from future auto-imports (hide machine-level). */
export async function hideIdentityEmail(email: string): Promise<void> {
  const map = await readMap();
  map.hidden = { ...map.hidden, [email.toLowerCase()]: true };
  await writeMap(map);
}

// --- standing-down roots (repos whose config the user explicitly stripped) ---
// Shared machine-level state (identities.json): every window AND terminal
// sees it, and any local-scope apply clears it — the CLI is the single
// writer, so "leave this repo alone" survives window restarts and holds
// across multi-root windows.

/** Record that colabor should not auto-apply to this repo root ("Unset in git repo config"). */
export async function markStandingDown(root: string): Promise<void> {
  const map = await readMap();
  const roots = new Set(map.standingDown ?? []);
  roots.add(root);
  map.standingDown = [...roots];
  await writeMap(map);
}

/** An explicit local-scope apply re-arms auto-apply for this repo root. */
export async function clearStandingDown(root: string): Promise<void> {
  const map = await readMap();
  if (!map.standingDown?.includes(root)) return;
  map.standingDown = map.standingDown.filter((r) => r !== root);
  await writeMap(map);
}

/** Is colabor standing down for this repo root? */
export async function isStandingDown(root: string): Promise<boolean> {
  const map = await readMap();
  return (map.standingDown ?? []).includes(root);
}

/** Remove an email from the hidden list (unhide / restore). */
export async function unhideIdentityEmail(email: string): Promise<boolean> {
  const map = await readMap();
  const key = email.toLowerCase();
  if (!map.hidden?.[key]) return false;
  delete map.hidden[key];
  await writeMap(map);
  return true;
}

/** All hidden emails (lowercased) for the "show hidden identities" picker. */
export async function listHiddenEmails(): Promise<string[]> {
  const map = await readMap();
  return Object.keys(map.hidden ?? {});
}

export async function removeIdentity(id: string): Promise<void> {
  const map = await readMap();
  if (!map.identities[id]) throw Errors.usage(`identity "${id}" not found`);
  delete map.identities[id];
  if (map.keyBindings?.[id]) delete map.keyBindings[id];
  if (map.defaultIdentity === id) delete map.defaultIdentity;
  await writeMap(map);
}

export async function setDefault(id: string): Promise<void> {
  const map = await readMap();
  if (!map.identities[id]) throw Errors.usage(`identity "${id}" not found`);
  map.defaultIdentity = id;
  await writeMap(map);
}

export async function listIdentities(): Promise<{ identities: Identity[]; defaultIdentity?: string }> {
  const map = await readMap();
  return { identities: Object.values(map.identities), defaultIdentity: map.defaultIdentity };
}
