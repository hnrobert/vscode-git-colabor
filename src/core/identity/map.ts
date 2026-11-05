import { readFile } from 'node:fs/promises';
import { Errors } from '../errors.js';
import { mapPath } from '../paths.js';
import { atomicWriteJson } from '../io.js';
import type { Identity, IdentityMap, KeyBinding, SshKeyRef, SignKeyRef } from '../types.js';

/**
 * The store is a LIST of self-contained rows — no keys, no ids, no side
 * tables. An identity IS its (name, email) plus attributes, and carries its
 * own key preferences in `keyBindings` on the row. Every reference
 * (`Name <email>`, or a unique bare email) resolves by scanning; exact
 * (name, email) duplicates are collapsed at migration time and prevented at
 * write time. The `defaultIdentity` marker stores the derived lowercase
 * author form.
 */

const norm = (s: string): string => s.trim().toLowerCase();

/** derived canonical author form — the store's comparison / marker form */
const refOf = (i: Pick<Identity, 'name' | 'email'>): string => `${norm(i.name)} <${norm(i.email)}>`;

/** display-case author form — the ref callers pass around; never stored */
export const idOf = (name: string, email: string): string => `${name.trim()} <${email.trim()}>`;

/** `Name <email>` → parts, when the ref carries both */
function parseAuthorRef(ref: string): { name: string; email: string } | undefined {
  const m = ref.match(/^(.*) <([^<>]+)>$/);
  return m ? { name: m[1], email: m[2] } : undefined;
}

/** Resolve a caller ref — `Name <email>`, a 1-based list index, or a unique bare email. */
function resolveRow(map: IdentityMap, ref: string): Identity {
  const author = parseAuthorRef(ref);
  if (author) {
    const hit = map.identities.find((i) => norm(i.name) === norm(author.name) && norm(i.email) === norm(author.email));
    if (hit) return hit;
  }
  // a bare number is the 1-based position in `identity ls` order
  if (/^\d+$/.test(ref.trim())) {
    const row = map.identities[Number(ref.trim()) - 1];
    if (row) return row;
    throw Errors.usage(
      `identity index ${ref.trim()} out of range — the list has ${map.identities.length} entries (see \`git colabor identity ls\`)`,
    );
  }
  if (!author) {
    const byEmail = map.identities.filter((i) => norm(i.email) === norm(ref));
    if (byEmail.length === 1) return byEmail[0];
    if (byEmail.length > 1) {
      const list = byEmail.map((i) => `"${idOf(i.name, i.email)}"`).join(', ');
      throw Errors.usage(`email "${ref}" matches several identities — use the full form: ${list}`);
    }
  }
  throw Errors.usage(`identity "${ref}" not found`);
}

type RawRow = Omit<Identity, 'keyBindings' | 'scope'> & {
  keyBindings?: KeyBinding;
  // legacy shapes read from disk (their extra fields — incl. any stored id — are ignored)
  scope?: string;
  imported?: boolean;
  sshKeyPath?: string;
  sshKeyFingerprint?: string;
  sshKeyEncrypted?: boolean;
  gpgKey?: string;
  passphraseCommand?: string;
  disabled?: boolean;
  remoteKeys?: Record<string, string>;
};

/** Fold one raw row (from any era) into the normalized list shape. */
function foldRow(rows: Identity[], raw: RawRow): void {
  // migrate the single-slot key into the row's own bindings (once)
  let keyBindings = raw.keyBindings;
  if (raw.sshKeyPath && raw.sshKeyFingerprint && !keyBindings?.pushKey) {
    const ref: SshKeyRef = { path: raw.sshKeyPath, fingerprint: raw.sshKeyFingerprint };
    if (raw.sshKeyEncrypted) ref.encrypted = true;
    keyBindings = { ...keyBindings, pushKey: ref };
  }
  if (raw.gpgKey && !keyBindings?.signKey) {
    keyBindings = { ...keyBindings, signKey: { format: 'openpgp', key: raw.gpgKey } };
  }
  const scope: Identity['scope'] =
    raw.scope === 'user' || raw.scope === 'vscode'
      ? 'machine'
      : ((raw.scope as Identity['scope']) ?? (raw.imported ? 'project' : 'machine')); // imported ⟺ history ⟺ project scope
  const row: Identity = {
    name: raw.name,
    email: raw.email,
    createdAt: raw.createdAt,
    ...(raw.host !== undefined ? { host: raw.host } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(raw.fromConfig !== undefined ? { fromConfig: raw.fromConfig } : {}),
    ...(keyBindings ? { keyBindings } : {}),
  };
  const dup = rows.find((i) => norm(i.name) === norm(row.name) && norm(i.email) === norm(row.email));
  if (dup) {
    // exact duplicate (possible in keyed maps) — merge the richer bindings
    dup.keyBindings = { ...(row.keyBindings ?? {}), ...(dup.keyBindings ?? {}) };
    return;
  }
  rows.push(row);
}

export async function readMap(): Promise<IdentityMap> {
  try {
    const txt = await readFile(mapPath(), 'utf8');
    const parsed = JSON.parse(txt) as Partial<IdentityMap> & {
      // earlier shapes
      identities?: unknown;
      keyBindings?: Record<string, KeyBinding>;
    };
    const raws = Array.isArray(parsed.identities)
      ? (parsed.identities as RawRow[])
      : Object.entries((parsed.identities as unknown as Record<string, RawRow> | undefined) ?? {}).map(([k, row]) => ({
          ...row,
          keyBindings: row.keyBindings ?? parsed.keyBindings?.[k],
        }));
    const identities: Identity[] = [];
    for (const raw of raws) foldRow(identities, raw);
    // the default marker survives when its ref (any era) still resolves
    let defaultIdentity: string | undefined;
    if (parsed.defaultIdentity) {
      try {
        defaultIdentity = refOf(resolveRow({ schemaVersion: 1, identities }, parsed.defaultIdentity));
      } catch {
        defaultIdentity = undefined; // dangling marker — drop it
      }
    }
    const migrated: IdentityMap = {
      schemaVersion: 1,
      identities,
      ...(defaultIdentity ? { defaultIdentity } : {}),
      ...(parsed.hidden ? { hidden: parsed.hidden } : {}),
      ...(parsed.standingDown ? { standingDown: parsed.standingDown } : {}),
    };
    // persist the migration immediately so a read-only command (ls/status)
    // still lands the new shape on disk
    if (JSON.stringify(parsed) !== JSON.stringify(migrated)) {
      await writeMap(migrated);
    }
    return migrated;
  } catch {
    return { schemaVersion: 1, identities: [] };
  }
}

export async function writeMap(map: IdentityMap): Promise<void> {
  await atomicWriteJson(mapPath(), map, 0o600);
}

export async function getIdentity(ref: string): Promise<Identity> {
  return resolveRow(await readMap(), ref);
}

/** Find an identity by (name, email) — the uniqueness key. */
export async function findIdentity(name: string, email: string): Promise<Identity | undefined> {
  const { identities } = await readMap();
  return identities.find((i) => norm(i.email) === norm(email) && norm(i.name) === norm(name));
}

export type NewIdentity = Omit<Identity, 'createdAt'>;

export async function addIdentity(input: NewIdentity): Promise<Identity> {
  const map = await readMap();
  const dup = map.identities.find((i) => norm(i.name) === norm(input.name) && norm(i.email) === norm(input.email));
  if (dup) return dup; // idempotent — (name,email) IS the identity
  const identity: Identity = { ...input, createdAt: new Date().toISOString() };
  map.identities.push(identity);
  // a manual add of a previously hidden committer un-hides it for future imports
  const hiddenKey = norm(input.email);
  if (map.hidden?.[hiddenKey]) delete map.hidden[hiddenKey];
  await writeMap(map);
  return identity;
}

/**
 * Patch editable fields of an identity (name/email/scope). (name, email) is
 * the identity: an exact-duplicate patch is refused, and the default marker
 * follows a changed (name, email) — no fork, no side table to re-key.
 */
export async function updateIdentity(
  ref: string,
  patch: Partial<Pick<Identity, 'name' | 'email' | 'scope' | 'host' | 'fromConfig'>>,
): Promise<Identity> {
  const map = await readMap();
  const row = resolveRow(map, ref);
  const before = refOf(row);
  Object.assign(row, patch);
  const after = refOf(row);
  const clash = map.identities.find((i) => i !== row && refOf(i) === after);
  if (clash) throw Errors.usage(`"${idOf(row.name, row.email)}" already exists`);
  if (map.defaultIdentity === before) map.defaultIdentity = after;
  await writeMap(map);
  return row;
}

// --- key bindings (preference records carried ON the identity row) ---

export async function getKeyBinding(ref: string): Promise<KeyBinding> {
  return (await getIdentity(ref)).keyBindings ?? {};
}

export async function setKeyBinding(ref: string, binding: KeyBinding): Promise<void> {
  const map = await readMap();
  resolveRow(map, ref).keyBindings = binding;
  await writeMap(map);
}

export async function setPushKey(ref: string, ref_: SshKeyRef | undefined): Promise<void> {
  const b = await getKeyBinding(ref);
  await setKeyBinding(ref, { ...b, pushKey: ref_ });
}

export async function setSignKey(ref: string, key: SignKeyRef | undefined): Promise<void> {
  const b = await getKeyBinding(ref);
  await setKeyBinding(ref, { ...b, signKey: key });
}

/** Record the per-identity commit-signing preference (re-applied on every later use). */
export async function setSignCommits(ref: string, on: boolean): Promise<void> {
  const b = await getKeyBinding(ref);
  await setKeyBinding(ref, { ...b, signCommits: on ? true : undefined });
}

/** Hide an email from future auto-imports (hide machine-level). */
export async function hideIdentityEmail(email: string): Promise<void> {
  const map = await readMap();
  map.hidden = { ...map.hidden, [norm(email)]: true };
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
  const key = norm(email);
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

export async function removeIdentity(ref: string): Promise<void> {
  const map = await readMap();
  const row = resolveRow(map, ref);
  map.identities = map.identities.filter((i) => i !== row);
  if (map.defaultIdentity === refOf(row)) delete map.defaultIdentity;
  await writeMap(map);
}

export async function setDefault(ref: string): Promise<void> {
  const map = await readMap();
  map.defaultIdentity = refOf(resolveRow(map, ref));
  await writeMap(map);
}

export async function listIdentities(): Promise<{ identities: Identity[]; defaultIdentity?: string }> {
  const map = await readMap();
  return { identities: map.identities, ...(map.defaultIdentity ? { defaultIdentity: map.defaultIdentity } : {}) };
}
