import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addIdentity,
  idOf,
  getIdentity,
  listIdentities,
  readMap,
  removeIdentity,
  setDefault,
} from '../../src/core/identity/map.js';

let dir: string;
let prev: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ca-map-'));
  prev = process.env.GIT_COLABOR_MAP;
  process.env.GIT_COLABOR_MAP = join(dir, 'identities.json');
});

afterEach(async () => {
  if (prev === undefined) delete process.env.GIT_COLABOR_MAP;
  else process.env.GIT_COLABOR_MAP = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('identity map', () => {
  it('(name, email) is the primary key — id aliases `Name <email>`, same email + different name stays distinct', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    expect(idOf(a.name, a.email)).toBe('Alice <alice@x.com>'); // the DERIVED ref (never stored)
    expect('id' in a).toBe(false); // no id field exists on the row
    const again = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    expect(again.createdAt).toBe(a.createdAt); // exact (name,email) re-add is idempotent
    const other = await addIdentity({ name: 'Alice Renamed', email: 'alice@x.com' });
    expect(idOf(other.name, other.email)).toBe('Alice Renamed <alice@x.com>'); // shared email ≠ same identity
  });

  it('add + get round-trips', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    const got = await getIdentity(idOf(a.name, a.email));
    expect(got.email).toBe('alice@x.com');
    expect(got.createdAt.length).toBeGreaterThan(0);
  });

  it('list + setDefault', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    await setDefault(idOf(a.name, a.email));
    const { identities, defaultIdentity } = await listIdentities();
    expect(identities).toHaveLength(1);
    expect(defaultIdentity).toBe('alice <alice@x.com>'); // store key = lowercase composite
  });

  it('remove deletes and clears default', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    const ref = idOf(a.name, a.email);
    await setDefault(ref);
    await removeIdentity(ref);
    const { identities, defaultIdentity } = await listIdentities();
    expect(identities).toHaveLength(0);
    expect(defaultIdentity).toBeUndefined();
  });

  it('persists across reads (atomic write) — identities are a plain list', async () => {
    await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    const { identities } = await readMap();
    expect(Array.isArray(identities)).toBe(true);
    expect(identities.find((i) => i.email === 'alice@x.com')).toBeDefined();
    expect(identities.find((i) => 'id' in i)).toBeUndefined(); // no id field anywhere
  });

  it('writes the map file mode 0600', async () => {
    await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    const st = await stat(join(dir, 'identities.json'));
    expect(st.mode & 0o777).toBe(0o600);
  });
});
