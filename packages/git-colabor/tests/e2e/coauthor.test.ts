import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as coauthor from '../../src/cli/coauthor.js';
import { getAllConfig } from '../../src/core/git/config.js';
import { historyCommitters } from '../../src/core/git/committers.js';
import { repoAuthors } from '../../src/core/git/shortlog.js';
import { dispatch as dispatchIdentity } from '../../src/cli/identity.js';
import type { GlobalFlags } from '../../src/cli/parse-args.js';

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

let root: string;
let home: string;
let dataDir: string;
let prevHome: string | undefined;
let prevMap: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-e2e-'));
  home = await mkdtemp(join(tmpdir(), 'ca-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'ca-data-'));
  prevHome = process.env.HOME;
  prevMap = process.env.GIT_COLABOR_MAP;
  process.env.HOME = home;
  process.env.GIT_COLABOR_MAP = join(dataDir, 'identities.json');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@x.com']);
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevMap === undefined) delete process.env.GIT_COLABOR_MAP;
  else process.env.GIT_COLABOR_MAP = prevMap;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('coauthor e2e (add/rm/ls, identity-based)', () => {
  it('add --always writes colabor.selected (multi) + commit template', async () => {
    // seed identities
    const { addIdentity } = await import('../../src/core/identity/map.js');
    await addIdentity({ name: 'Jane Doe', email: 'jane@x.com' });
    await addIdentity({ name: 'Amy Doe', email: 'amy@x.com' });

    await coauthor.add(['jane@x.com'], { always: true }, root);
    await coauthor.add(['amy@x.com'], { always: true }, root);

    const all = await getAllConfig('colabor.selected', 'local', root);
    expect(all.split(/\r?\n/)).toEqual(['Jane Doe <jane@x.com>', 'Amy Doe <amy@x.com>']);
  });

  it('add (default/oneshot) writes colabor.oneshot', async () => {
    await coauthor.add(['jane@x.com'], {}, root);
    const raw = await getAllConfig('colabor.oneshot', 'local', root);
    expect(raw).toContain('Jane Doe <jane@x.com>');
  });

  it('ls shows both selected and available', async () => {
    const r = await coauthor.ls([], root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as {
      available: { email: string }[];
      selected: { email: string; mode: string }[];
    };
    // jane and amy are in both (selected via --always, oneshot)
    expect(data.selected.length).toBeGreaterThanOrEqual(2);
    expect(data.available.length).toBeGreaterThanOrEqual(2);
  });

  it('rm removes from all scopes', async () => {
    const r = await coauthor.rm(['jane@x.com'], root);
    expect(r.ok).toBe(true);
    const sel = await getAllConfig('colabor.selected', 'local', root);
    expect(sel).not.toContain('jane@x.com');
    const oneshot = await getAllConfig('colabor.oneshot', 'local', root);
    expect(oneshot).not.toContain('jane@x.com');
  });

  it('add of unknown email fails', async () => {
    const r = await coauthor.add(['nope@nowhere.com'], {}, root).catch((e) => e);
    expect(r).toBeInstanceOf(Error);
  });

  it('Co-authored-by trailer authors appear in history scan, suggest, and identity import', async () => {
    // a commit authored by the configured identity, crediting a trailer-only partner
    git(root, ['commit', '-q', '--allow-empty', '-m', 'pair work\n\nCo-authored-by: Trailer Pal <pal@x.io>']);
    const committers = await historyCommitters(root);
    expect(committers.some((c) => c.email === 'pal@x.io')).toBe(true); // trailer author counted
    const authors = await repoAuthors(undefined, root);
    expect(authors.some((a) => a.email === 'pal@x.io')).toBe(true); // suggest candidate too
    const r = await dispatchIdentity('import', ['--json'], { cwd: root, flags: {} as GlobalFlags });
    expect((r.data as { added: { email: string }[] }).added.some((a) => a.email === 'pal@x.io')).toBe(true);
  });
});
