import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliClient } from '../../src/cli/CliClient.js';

// Path to the built CLI bundle (the git-colabor submodule, built separately).
const here = fileURLToPath(new URL('.', import.meta.url));
const cliBundle = resolve(here, '../../git-colabor/dist/cli.cjs');
const bundleReady = existsSync(cliBundle);

const fakeLog = { info(_m: string) {}, warn(_m: string) {}, error(_m: string) {} };

let mapDir: string;
let prevMap: string | undefined;

beforeAll(async () => {
  mapDir = await mkdtemp(join(tmpdir(), 'ca-ext-cli-'));
  prevMap = process.env.GIT_COLABOR_MAP;
  process.env.GIT_COLABOR_MAP = join(mapDir, 'identities.json');
  await writeFile(
    join(mapDir, 'identities.json'),
    JSON.stringify({ schemaVersion: 1, identities: { id_1: { id: 'id_1', name: 'A', email: 'a@x.com', createdAt: '2026-01-01T00:00:00Z' } } }),
  );
});

afterAll(async () => {
  if (prevMap === undefined) delete process.env.GIT_COLABOR_MAP;
  else process.env.GIT_COLABOR_MAP = prevMap;
  await rm(mapDir, { recursive: true, force: true });
});

describe.runIf(bundleReady)('CliClient (spawns the real bundled CLI)', () => {
  const client = new CliClient({ cliPath: cliBundle, log: fakeLog });

  it('runs identity ls and parses the --json envelope', async () => {
    const r = await client.run(['identity', 'ls']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { identities: { id: string }[] };
      expect(data.identities.some((i) => i.id === 'id_1')).toBe(true);
    }
  });

  it('forwards env (isolated GIT_COLABOR_MAP)', async () => {
    const r = await client.run(['identity', 'ls']);
    expect(r.ok).toBe(true);
  });

  it('propagates CLI errors as a non-ok envelope', async () => {
    const r = await client.run(['identity', 'use', 'does-not-exist']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.exitCode).toBe(2);
  });
});
