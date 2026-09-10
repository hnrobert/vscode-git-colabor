import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanPrivateKeys } from '../../src/ssh/scanPrivateKeys.js';

let dir: string;
const setup = async (files: Record<string, string>): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), 'sshscan-'));
  for (const [name, content] of Object.entries(files)) {
    if (content === '<dir>') await mkdir(join(dir, name));
    else await writeFile(join(dir, name), content);
  }
  return dir;
};
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('scanPrivateKeys', () => {
  it('lists only private key files with their format', async () => {
    const d = await setup({
      'id_ed25519': '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
      'id_rsa': '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n',
      'work.key': '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF\n-----END ENCRYPTED PRIVATE KEY-----\n',
      'id_ed25519.pub': 'ssh-ed25519 AAAAC3 public line\n',
      'config': 'Host nas\n  User robert\n',
      'known_hosts': 'nas.example.com ssh-ed25519 AAAA\n',
      'notes.txt': 'not a key\n',
      'subdir': '<dir>',
    });
    const keys = await scanPrivateKeys(d);
    expect(keys.map((k) => k.name)).toEqual(['id_ed25519', 'id_rsa', 'work.key']);
    expect(keys[0]).toMatchObject({ kind: 'OpenSSH' });
    expect(keys[1]).toMatchObject({ kind: 'RSA' });
    expect(keys[2]).toMatchObject({ kind: 'PKCS#8 (encrypted)' });
    expect(keys[0].path).toBe(join(d, 'id_ed25519'));
  });

  it('returns empty for a missing directory', async () => {
    expect(await scanPrivateKeys('/nonexistent/.ssh-definitely-missing')).toEqual([]);
  });
});
