import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  pathLike,
  expandTilde,
  isPrivateKeyFile,
  pathCompletions,
  listDirRows,
  type DirCache,
} from '../../src/ssh/keyFileCompletions.js';

let home: string;
let sshDir: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'kp-home-'));
  sshDir = join(home, '.ssh');
  await mkdir(sshDir);
  // one unencrypted + one encrypted ed25519, a public half, and a non-key file
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(sshDir, 'id_plain'), '-C', 'plain'], { encoding: 'utf8' });
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 's3cret', '-f', join(sshDir, 'id_enc'), '-C', 'enc'], { encoding: 'utf8' });
  await writeFile(join(sshDir, 'README.txt'), 'not a key\n', 'utf8');
  await writeFile(join(sshDir, '.hidden_key'), '-----BEGIN OPENSSH PRIVATE KEY-----\nplaceholder\n', 'utf8');
  await mkdir(join(home, 'Documents'));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('tilde handling', () => {
  it('bare ~ lists the home directory itself, labels complete the typed path', async () => {
    const rows = await pathCompletions('~', home, new Map(), sshDir);
    const labels = rows.map((r) => r.label);
    // hidden dirs are visible — keys usually live in them
    expect(labels.some((n) => n.includes('~/.ssh/'))).toBe(true);
    expect(labels.some((n) => n.includes('~/Documents/'))).toBe(true);
  });

  it('~/ lists the same; ~/Doc completes to ~/Documents/', async () => {
    const cache: DirCache = new Map();
    const slash = await pathCompletions('~/', home, cache, sshDir);
    expect(slash.length).toBeGreaterThan(0);
    const doc = await pathCompletions('~/Doc', home, cache, sshDir);
    expect(doc.some((r) => r.label === '$(folder) ~/Documents/')).toBe(true);
  });

  it('a bare word searches the fallback directory with absolute labels', async () => {
    const rows = await pathCompletions('id_p', home, new Map(), sshDir);
    expect(rows.map((r) => r.label)).toEqual(['$(key) /var-ish/.ssh/id_plain'.replace('/var-ish', home)]);
    // platform fuzzy filter matches the word against the absolute label
    expect(rows[0].label.includes('id_plain')).toBe(true);
  });

  it('~/Documents/ drills into the directory', async () => {
    const rows = await pathCompletions('~/.ssh/', home, new Map(), sshDir);
    const keys = rows.filter((r) => r.keyPath).filter((r) => !r.label.includes('.hidden'));
    // labels complete the typed path — the QuickPick input is FILTER TEXT,
    // so every row must contain it to survive the platform's fuzzy filter;
    // the encryption icon rides along
    expect(keys.map((r) => r.label)).toEqual(['$(lock) ~/.ssh/id_enc', '$(key) ~/.ssh/id_plain']);
    expect(keys.map((r) => (r.description ?? '').replace(/\/$/, ''))).toEqual([sshDir, sshDir]);
    // non-key files and .pub halves never appear
    expect(rows.some((r) => r.label.includes('README'))).toBe(false);
    expect(rows.some((r) => r.label.includes('.pub'))).toBe(false);
    expect(rows.find((r) => r.label.includes('id_enc'))?.detail).toContain('encrypted');
  });
});

describe('listDirRows', () => {
  it('classifies plain vs encrypted keys and omits non-keys', async () => {
    const rows = await listDirRows(sshDir, new Map());
    expect(rows.find((r) => r.label === '$(key) id_plain')?.detail).toContain('OpenSSH');
    expect(rows.find((r) => r.label === '$(lock) id_enc')?.detail).toContain('encrypted (passphrase needed)');
    expect(rows.find((r) => r.label.includes('id_plain.pub'))).toBeUndefined();
    expect(rows.find((r) => r.label.includes('README'))).toBeUndefined();
  });

  it('hidden key files are listed too (keys live in dotfiles)', async () => {
    const rows = await listDirRows(sshDir, new Map());
    expect(rows.some((r) => r.label.includes('.hidden_key'))).toBe(true);
  });
});

describe('isPrivateKeyFile', () => {
  it('accepts real keys, rejects anything else', async () => {
    expect(await isPrivateKeyFile(join(sshDir, 'id_plain'))).toBe(true);
    expect(await isPrivateKeyFile(join(sshDir, 'README.txt'))).toBe(false);
    expect(await isPrivateKeyFile(join(sshDir, 'missing'))).toBe(false);
  });
});

describe('expandTilde / pathLike', () => {
  it('expands ~ and ~/ only as a prefix', () => {
    expect(expandTilde('~', home)).toBe(home);
    expect(expandTilde('~/.ssh', home)).toBe(join(home, '.ssh'));
    expect(expandTilde('/x/~/y', home)).toBe('/x/~/y');
  });
  it('recognizes path starts', () => {
    expect(pathLike('~')).toBe(true);
    expect(pathLike('~/.ssh/')).toBe(true);
    expect(pathLike('./rel')).toBe(true);
    expect(pathLike('../up')).toBe(true);
    expect(pathLike('id_ed25519')).toBe(false);
  });
});
