import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { addIdentity, getKeyBinding, hideIdentityEmail, listIdentities, removeIdentity, setPushKey, setSignKey, unhideIdentityEmail, updateIdentity } from '../../src/core/identity/map.js';
import { applyIdentity } from '../../src/core/identity/apply.js';
import { setCommitSigning, signingStatus } from '../../src/core/identity/sign.js';
import { logoutIdentity } from '../../src/core/identity/logout.js';
import { fingerprintOfFile, importKey } from '../../src/core/identity/keys.js';
import { getConfig } from '../../src/core/git/config.js';
import { readAudit } from '../../src/core/logging/audit.js';
import { historyCommitters } from '../../src/core/git/committers.js';
import { loadKey } from '../../src/core/identity/agent.js';
import { writeFile, chmod as chmodFile } from 'node:fs/promises';
import { importFromHistory, dispatch } from '../../src/cli/identity.js';
import { idOf } from '../../src/core/identity/map.js';
import type { GlobalFlags } from '../../src/cli/parse-args.js';
import { resolveActive } from '../../src/core/identity/resolve.js';

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
let prevAudit: string | undefined;

let agentPid: number | undefined;
let prevAuthSock: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-id-e2e-'));
  home = await mkdtemp(join(tmpdir(), 'ca-id-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'ca-id-data-'));
  prevHome = process.env.HOME;
  prevMap = process.env.GIT_COLABOR_MAP;
  prevAudit = process.env.GIT_COLABOR_AUDIT_FILE;
  process.env.HOME = home; // isolates ~/.gitmessage, global git config, and keysDir()
  process.env.GIT_COLABOR_MAP = join(dataDir, 'identities.json');
  process.env.GIT_COLABOR_AUDIT_FILE = join(dataDir, 'audit.log');
  // PRIVATE ssh-agent: loadKey/agent tests run real `ssh-add` — without this
  // they would load the test keys into the USER's real agent (exactly the
  // leak this once caused: one 'load' key per e2e run).
  prevAuthSock = process.env.SSH_AUTH_SOCK;
  const agentSock = join(dataDir, 'test-agent.sock');
  const agent = spawnSync('ssh-agent', ['-a', agentSock], { encoding: 'utf8' });
  const pidMatch = agent.stdout.match(/SSH_AGENT_PID=(\d+)/);
  if (agent.status !== 0 || !pidMatch) throw new Error(`test ssh-agent failed to start: ${agent.stderr}`);
  process.env.SSH_AUTH_SOCK = agentSock;
  agentPid = Number(pidMatch[1]);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Original Name']);
  git(root, ['config', 'user.email', 'original@x.com']);
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevMap === undefined) delete process.env.GIT_COLABOR_MAP;
  else process.env.GIT_COLABOR_MAP = prevMap;
  if (prevAudit === undefined) delete process.env.GIT_COLABOR_AUDIT_FILE;
  else process.env.GIT_COLABOR_AUDIT_FILE = prevAudit;
  if (prevAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = prevAuthSock;
  if (agentPid !== undefined) {
    try {
      process.kill(agentPid, 'SIGTERM'); // the private agent dies with the suite
    } catch {
      // already gone
    }
  }
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('identity e2e (real git + real ssh-keygen)', () => {
  it('adds a name/email-only identity', async () => {
    const a = await addIdentity({ name: 'Alice', email: 'alice@x.com' });
    const { identities } = await listIdentities();
    expect(identities.find((i) => idOf(i.name, i.email) === idOf(a.name, a.email))?.email).toBe('alice@x.com');
  });

  it('applyIdentity writes standard keys only — no markers, no state.json, no backups', async () => {
    const b = await addIdentity({ name: 'Bob', email: 'bob@x.com' });
    const { result } = await applyIdentity(idOf(b.name, b.email), { source: 'cli', cwd: root });
    expect(result.name).toBe('Bob');
    expect(await getConfig('user.name', 'local', root)).toBe('Bob');
    expect(await getConfig('user.email', 'local', root)).toBe('bob@x.com');
    // config is 100% clean of colabor.* identity markers
    expect(await getConfig('colabor.managed', 'local', root)).toBeUndefined();
    expect(await getConfig('colabor.managed-by', 'local', root)).toBeUndefined();
    // no state.json written
    expect(existsSync(join(root, '.git/colabor/state.json'))).toBe(false);
  });

  it('resolveActive derives the active identity from config (email→name)', async () => {
    const c = await addIdentity({ name: 'Carol', email: 'carol@x.com' });
    await applyIdentity(idOf(c.name, c.email), { source: 'cli', cwd: root });
    const resolved = await resolveActive(root);
    expect(idOf(resolved!.identity.name, resolved!.identity.email)).toBe(idOf(c.name, c.email));
    // unknown (name,email) auto-enrolls with a deterministic id
    git(root, ['config', '--local', 'user.name', 'New Person']);
    git(root, ['config', '--local', 'user.email', 'new@x.com']);
    const r2 = await resolveActive(root, { enroll: true });
    expect(r2?.enrolled).toBe(true);
    expect(r2?.identity.name).toBe('New Person');
    // re-resolving the same config is idempotent (same id, not re-enrolled)
    const r3 = await resolveActive(root, { enroll: true });
    expect(r3?.enrolled).toBe(false);
    expect(idOf(r3!.identity.name, r3!.identity.email)).toBe(idOf(r2!.identity.name, r2!.identity.email));
  });

  it('audit log records identity.use', async () => {
    const entries = await readAudit();
    expect(entries.some((e) => e.action === 'identity.use' && e.identityName === 'Bob')).toBe(true);
  });

  it('a pre-email map (id_-keyed) migrates to the list shape on read; hash refs no longer resolve', async () => {
    const { writeMap } = await import('../../src/core/identity/map.js');
    // old shape: identities + keyBindings keyed by the id_ hash, default too
    await writeMap({
      schemaVersion: 1,
      identities: {
        id_deadbeef12: { id: 'id_deadbeef12', name: 'Old One', email: 'Old@X.com', createdAt: '2026-01-01T00:00:00.000Z' },
      },
      keyBindings: { id_deadbeef12: { pushKey: { path: '/k/old', fingerprint: 'SHA256:x' } } },
      defaultIdentity: 'id_deadbeef12',
    } as never);
    const r = await dispatch('status', ['--json'], { cwd: root, flags: {} as GlobalFlags });
    if (!r.ok) throw new Error('status dispatch failed');
    const row = (r.data as { identities: { email: string; isDefault: boolean }[] }).identities.find(
      (i) => i.email === 'Old@X.com',
    );
    expect(row).toBeDefined();
    // an old-hash default marker can no longer resolve — dropped at migration
    expect(row?.isDefault).toBe(false);
    // the binding followed the re-key (checked directly — hasKey also
    // requires the key FILE to exist)
    const { getKeyBinding } = await import('../../src/core/identity/map.js');
    expect((await getKeyBinding('OLD@x.com')).pushKey?.path).toBe('/k/old'); // case-insensitive email ref
    // any-case email resolves; the legacy hash does NOT (legacy ids are gone)
    const byEmail = await dispatch('use', ['old@x.com', '--json'], { cwd: root, flags: {} as GlobalFlags });
    const byLegacy = await dispatch('use', ['id_deadbeef12', '--json'], { cwd: root, flags: {} as GlobalFlags }).catch(
      () => null,
    );
    expect(byEmail.ok).toBe(true);
    expect(byLegacy === null || byLegacy.ok === false).toBe(true);
    // restore a sane local config after the use
    git(root, ['config', '--local', 'user.name', 'Original Name']);
    git(root, ['config', '--local', 'user.email', 'original@x.com']);
  });

  it('a 1-based index ref resolves in `identity ls` order; out of range errors', async () => {
    const { identities } = await listIdentities();
    expect(identities.length).toBeGreaterThan(1);
    const first = identities[0];
    const r = await dispatch('use', ['1', '--json'], { cwd: root, flags: {} as GlobalFlags });
    if (!r.ok) throw new Error('use-by-index failed');
    expect((r.data as { identity: { name: string; email: string } }).identity.email).toBe(first.email);
    const out = await dispatch('use', ['9999', '--json'], { cwd: root, flags: {} as GlobalFlags }).catch(() => null);
    expect(out === null || out.ok === false).toBe(true);
    git(root, ['config', '--local', 'user.name', 'Original Name']);
    git(root, ['config', '--local', 'user.email', 'original@x.com']);
  });

  it('alias: settable, unique, shown in JSON, and usable as a CLI ref', async () => {
    const a = await addIdentity({ name: 'Alias Guy', email: 'alias@x.com' });
    const b = await addIdentity({ name: 'Alias Two', email: 'alias2@x.com' });
    const ref = idOf(a.name, a.email);
    // set + JSON exposure
    const set1 = await dispatch('set', [ref, '--alias', 'guy@work', '--json'], { cwd: root, flags: {} as GlobalFlags });
    if (!set1.ok) throw new Error('set --alias failed');
    expect((set1.data as { identity: { alias: string | null } }).identity.alias).toBe('guy@work'); // @ allowed — resolution is alias-first, not shape-based
    // usable as a ref — even though it looks like an email (alias wins)
    const use = await dispatch('use', ['guy@work', '--json'], { cwd: root, flags: {} as GlobalFlags });
    expect(use.ok && (use.data as { identity: { email: string } }).identity.email === 'alias@x.com').toBe(true);
    // uniqueness + numeric rejection
    const dup = await dispatch('set', [idOf(b.name, b.email), '--alias', 'guy@work', '--json'], { cwd: root, flags: {} as GlobalFlags }).catch(() => null);
    expect(dup === null || dup.ok === false).toBe(true);
    const num = await dispatch('set', [ref, '--alias', '42', '--json'], { cwd: root, flags: {} as GlobalFlags }).catch(() => null);
    expect(num === null || num.ok === false).toBe(true);
    // clear
    const cleared = await dispatch('set', ['guy@work', '--no-alias', '--json'], { cwd: root, flags: {} as GlobalFlags });
    expect(cleared.ok && (cleared.data as { identity: { alias: string | null } }).identity.alias === null).toBe(true);
    git(root, ['config', '--local', 'user.name', 'Original Name']);
    git(root, ['config', '--local', 'user.email', 'original@x.com']);
  });

  it('status reports per-scope config identities (repo vs global) and enrolls unknowns', async () => {
    // local carries a KNOWN person, global carries an UNKNOWN one
    const known = await addIdentity({ name: 'Repo Local', email: 'repolocal@x.com' });
    git(root, ['config', '--local', 'user.name', 'Repo Local']);
    git(root, ['config', '--local', 'user.email', 'repolocal@x.com']);
    git(root, ['config', '--global', 'user.name', 'Global Stranger']);
    git(root, ['config', '--global', 'user.email', 'stranger@x.com']);
    try {
      const r = await dispatch('status', ['--json'], { cwd: root, flags: {} as GlobalFlags });
      if (!r.ok) throw new Error('status dispatch failed');
      const data = r.data as {
        configIdentities: { repo: { id: string; email: string } | null; global: { id: string; email: string } | null };
        identities: { id: string; email: string; fromConfig?: boolean }[];
      };
      expect(data.configIdentities.repo?.email).toBe('repolocal@x.com');
      expect(data.configIdentities.repo?.id).toBe(idOf(known.name, known.email)); // known person matched by email, not re-enrolled
      expect(data.configIdentities.global?.email).toBe('stranger@x.com');
      // the unknown global identity enrolled (fromConfig) and appears as a row
      const globalRow = data.identities.find((i) => i.email === 'stranger@x.com');
      expect(globalRow?.id).toBe(data.configIdentities.global?.id);
      expect(globalRow?.fromConfig).toBe(true);
    } finally {
      git(root, ['config', '--local', 'user.name', 'Original Name']);
      git(root, ['config', '--local', 'user.email', 'original@x.com']);
      git(root, ['config', '--global', '--unset', 'user.name']);
      git(root, ['config', '--global', '--unset', 'user.email']);
    }
  });

  it('a config (name, email) that no row carries exactly ENROLLS — shared emails never collapse', async () => {
    await addIdentity({ name: 'Bob', email: 'robert@x.com' });
    git(root, ['config', '--local', 'user.name', 'Robert He']);
    git(root, ['config', '--local', 'user.email', 'robert@x.com']);
    try {
      const resolved = await resolveActive(root, { enroll: true });
      expect(idOf(resolved!.identity.name, resolved!.identity.email)).toBe('Robert He <robert@x.com>'); // (name,email) = new identity
      expect(resolved?.enrolled).toBe(true);
      const r = await dispatch('status', ['--json'], { cwd: root, flags: {} as GlobalFlags });
      if (!r.ok) throw new Error('status dispatch failed');
      const data = r.data as { configIdentities: { repo: { id: string } | null } };
      expect(data.configIdentities.repo?.id).toBe('Robert He <robert@x.com>');
      const { identities } = await listIdentities();
      expect(identities.filter((i) => i.email === 'robert@x.com')).toHaveLength(2); // both rows exist
    } finally {
      git(root, ['config', '--local', 'user.name', 'Original Name']);
      git(root, ['config', '--local', 'user.email', 'original@x.com']);
    }
  });

  it('a hidden email is never enrolled from config; unset-config + standing-down round-trip', async () => {
    // hidden person named by config: reported, not enrolled
    await hideIdentityEmail('ghost@x.com');
    git(root, ['config', '--global', 'user.name', 'Ghost']);
    git(root, ['config', '--global', 'user.email', 'ghost@x.com']);
    let r = await dispatch('status', ['--json'], { cwd: root, flags: {} as GlobalFlags });
    if (!r.ok) throw new Error('status dispatch failed');
    let data = r.data as { configIdentities: { global: { id: string; email: string } | null } };
    expect(data.configIdentities.global?.email).toBe('ghost@x.com');
    expect(data.configIdentities.global?.id).toBe(''); // hidden — no store row
    const { identities } = await listIdentities();
    expect(identities.find((i) => i.email === 'ghost@x.com')).toBeUndefined();
    git(root, ['config', '--global', '--unset', 'user.name']);
    git(root, ['config', '--global', '--unset', 'user.email']);
    await unhideIdentityEmail('ghost@x.com');

    // unset-config local: strips the layer and arms standing-down; a local use re-arms
    const u = await addIdentity({ name: 'Unsetter', email: 'unsetter@x.com' });
    await applyIdentity(idOf(u.name, u.email), { source: 'cli', cwd: root });
    const uc = await dispatch('unset-config', [idOf(u.name, u.email), '--json'], { cwd: root, flags: {} as GlobalFlags });
    if (!uc.ok) throw new Error('unset-config dispatch failed');
    const cleared = (uc.data as { cleared: { identityLayer: boolean } }).cleared;
    expect(cleared.identityLayer).toBe(true);
    expect(await getConfig('user.name', 'local', root)).toBeUndefined();
    r = await dispatch('status', ['--json'], { cwd: root, flags: {} as GlobalFlags });
    if (!r.ok) throw new Error('status dispatch failed');
    expect((r.data as { standingDown: boolean }).standingDown).toBe(true);
    // an explicit local apply re-arms auto-apply
    await applyIdentity(idOf(u.name, u.email), { source: 'cli', cwd: root });
    r = await dispatch('status', ['--json'], { cwd: root, flags: {} as GlobalFlags });
    if (!r.ok) throw new Error('status dispatch failed');
    expect((r.data as { standingDown: boolean }).standingDown).toBe(false);
    git(root, ['config', '--local', 'user.name', 'Original Name']);
    git(root, ['config', '--local', 'user.email', 'original@x.com']);
  });

  it('identity use reports the agent state (the extension passphrase gate reads it)', async () => {
    const k = await addIdentity({ name: 'Agenter', email: 'agenter@x.com' });
    // global scope keeps the repo's local config untouched for the tests after
    const r = await dispatch('use', [idOf(k.name, k.email), '--config-scope', 'global', '--json'], { cwd: root, flags: {} as GlobalFlags });
    if (!r.ok) throw new Error('use dispatch failed');
    expect((r.data as { agent: unknown }).agent).not.toBeUndefined();
    git(root, ['config', '--global', '--unset', 'user.name']);
    git(root, ['config', '--global', '--unset', 'user.email']);
  });

  it('identity use --config-scope global writes the global config, repo-local untouched', async () => {
    const g = await addIdentity({ name: 'Globalia', email: 'globalia@x.com' });
    const { result } = await applyIdentity(idOf(g.name, g.email), { source: 'cli', cwd: root, configScope: 'global' });
    expect(result.name).toBe('Globalia');
    expect(await getConfig('user.name', 'global')).toBe('Globalia');
    expect(await getConfig('user.email', 'global')).toBe('globalia@x.com');
    // the repo's own config is untouched by a global-scope apply
    expect(await getConfig('user.name', 'local', root)).toBe('Original Name');
    // the CLI flag parses and reaches the same path
    const r = await dispatch('use', [idOf(g.name, g.email), '--config-scope', 'global', '--json'], {
      cwd: root,
      flags: {} as GlobalFlags,
    });
    if (!r.ok) throw new Error('use dispatch failed');
    expect((r.data as { applied: { configScope: string } }).applied.configScope).toBe('global');
    expect(await getConfig('user.name', 'global')).toBe('Globalia');
    git(root, ['config', '--global', '--unset', 'user.name']);
    git(root, ['config', '--global', '--unset', 'user.email']);
  });

  it('importKey references the source file (no copy) with a matching fingerprint', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-'));
    const keyPath = join(keyDir, 'id_test');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'test'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    expect(imp.encrypted).toBe(false);
    expect(imp.path).toBe(keyPath); // reference mode: the identity points at the source
    expect(await fingerprintOfFile(keyPath)).toBe(imp.fingerprint);
    await stat(keyPath); // source untouched
    await rm(keyDir, { recursive: true, force: true });
  });

  it('apply falls back to key-less when the referenced key file is gone', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key3-'));
    const keyPath = join(keyDir, 'id_gone');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'gone'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const id = await addIdentity({ name: 'GoneKey', email: 'gone@x.com' });
    await setPushKey(idOf(id.name, id.email), { path: imp.path, fingerprint: imp.fingerprint });
    await rm(keyDir, { recursive: true, force: true }); // break the reference

    const { result } = await applyIdentity(idOf(id.name, id.email), { source: 'cli', cwd: root });
    expect(result.keyMissing).toBe(true);
    expect(result.sshCommand).toBeUndefined();
    expect(await getConfig('user.name', 'local', root)).toBe('GoneKey');
    expect(await getConfig('core.sshCommand', 'local', root)).toBeUndefined();
  });

  it('loadKey verifies passphrases correctly with or without an ssh-agent', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-load-'));
    const keyPath = join(keyDir, 'id_enc');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 's3cret', '-f', keyPath, '-C', 'load'], { encoding: 'utf8' });
    const fingerprint = await fingerprintOfFile(keyPath);
    // a fake askpass: answers from TEST_PASS (kept off argv), like the real bridge
    const askpass = join(keyDir, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\nprintf "%s\\n" "$TEST_PASS"\n');
    await chmodFile(askpass, 0o700);
    const prevPass = process.env.TEST_PASS;

    process.env.TEST_PASS = 's3cret';
    const okLoad = await loadKey({
      keyPath,
      fingerprint,
      askpassScriptPath: askpass,
      socketPath: '/nonexistent/fake.sock', // force the askpass strategy; no real bridge needed
      token: 'fake-token',
    });
    expect(okLoad.loaded).toBe(true);
    expect(['askpass', 'keygen-verify']).toContain(okLoad.via);

    process.env.TEST_PASS = 'wrong-pass';
    const badLoad = await loadKey({
      keyPath,
      fingerprint,
      askpassScriptPath: askpass,
      socketPath: '/nonexistent/fake.sock',
      token: 'fake-token',
    });
    expect(badLoad.loaded).toBe(false); // wrong passphrase is detected — no false "wrong password" for correct ones

    if (prevPass === undefined) delete process.env.TEST_PASS;
    else process.env.TEST_PASS = prevPass;
    await rm(keyDir, { recursive: true, force: true });
  });

  it('signing is opt-in: apply writes none; identity sign toggles; revert restores', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-sign-'));
    const keyPath = join(keyDir, 'id_sign');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'sign'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const withKey = await addIdentity({ name: 'Signer', email: 'signer@x.com' });
    await setPushKey(idOf(withKey.name, withKey.email), { path: imp.path, fingerprint: imp.fingerprint });
    await applyIdentity(idOf(withKey.name, withKey.email), { source: 'cli', cwd: root });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined(); // opt-in: NOT auto-signed

    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(withKey.name, withKey.email), on: true });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBe('true');
    expect(await getConfig('gpg.format', 'local', root)).toBe('ssh');
    expect(await getConfig('user.signingKey', 'local', root)).toBe(keyPath);

    // switching identity while signing is on re-binds to the new usable key
    const key2Path = join(keyDir, 'id_sign2');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key2Path, '-C', 'sign2'], { encoding: 'utf8' });
    const imp2 = await importKey(key2Path);
    const second = await addIdentity({ name: 'Signer2', email: 'signer2@x.com' });
    await setPushKey(idOf(second.name, second.email), { path: imp2.path, fingerprint: imp2.fingerprint });
    await applyIdentity(idOf(second.name, second.email), { source: 'cli', cwd: root });
    expect(await getConfig('user.signingKey', 'local', root)).toBe(key2Path);

    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(second.name, second.email), on: false });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined();
    expect(await getConfig('user.signingKey', 'local', root)).toBeUndefined();

    // (revert removed — signing off already cleared the layer)
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined();
    await rm(keyDir, { recursive: true, force: true });
  });

  it('signing is remembered per identity: switching to a key-less identity turns it off, switching back re-enables it', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-remember-'));
    const keyPath = join(keyDir, 'id_remember');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'remember'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const signer = await addIdentity({ name: 'Remember', email: 'remember@x.com' });
    await setPushKey(idOf(signer.name, signer.email), { path: imp.path, fingerprint: imp.fingerprint });
    const plain = await addIdentity({ name: 'Plain', email: 'plain@x.com' });

    // signing on → config signs AND the preference is stored
    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(signer.name, signer.email), on: true });
    expect(await getKeyBinding(idOf(signer.name, signer.email))).toMatchObject({ signCommits: true });

    // switching to a key-less identity stops signing (no key to sign with)
    await applyIdentity(idOf(plain.name, plain.email), { source: 'cli', cwd: root });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined();

    // switching back re-enables signing — no explicit sign call needed
    await applyIdentity(idOf(signer.name, signer.email), { source: 'cli', cwd: root });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBe('true');
    expect(await getConfig('user.signingKey', 'local', root)).toBe(keyPath);

    // and an explicit OFF drops the preference for good
    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(signer.name, signer.email), on: false });
    expect((await getKeyBinding(idOf(signer.name, signer.email))).signCommits).not.toBe(true);
    await applyIdentity(idOf(signer.name, signer.email), { source: 'cli', cwd: root });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined();

    await rm(keyDir, { recursive: true, force: true });
  });

  it('signing off really stops signing when global config still signs, and status names the scope', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-global-'));
    const keyPath = join(keyDir, 'id_sign');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'sign'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const signer = await addIdentity({ name: 'Globe', email: 'globe@x.com' });
    await setPushKey(idOf(signer.name, signer.email), { path: imp.path, fingerprint: imp.fingerprint });
    git(root, ['config', '--global', 'commit.gpgsign', 'true']);
    try {
      const inherited = await signingStatus(root);
      expect(inherited).toMatchObject({ enabled: true, scope: 'global', managed: false });
      expect(inherited.origin).toBe(join(home, '.gitconfig'));

      await applyIdentity(idOf(signer.name, signer.email), { source: 'cli', cwd: root });
      await setCommitSigning({ source: 'cli', cwd: root, id: idOf(signer.name, signer.email), on: true });
      expect(await signingStatus(root)).toMatchObject({ enabled: true, scope: 'local', format: 'ssh', key: keyPath });

      // unsetting alone would fall back to the global `true` — off pins false locally
      await setCommitSigning({ source: 'cli', cwd: root, on: false });
      expect(await getConfig('commit.gpgsign', 'local', root)).toBe('false');
      expect(await getConfig('user.signingKey', 'local', root)).toBeUndefined();
      expect(await signingStatus(root)).toMatchObject({ enabled: false, scope: 'local' });

      // switching to a key-less identity while signing is just as final
      await setCommitSigning({ source: 'cli', cwd: root, id: idOf(signer.name, signer.email), on: true });
      const keyless = await addIdentity({ name: 'NoKey', email: 'nokey@x.com' });
      await applyIdentity(idOf(keyless.name, keyless.email), { source: 'cli', cwd: root });
      // keyless identity apply clears the signing layer (no state flag anymore)
      expect(await getConfig('commit.gpgsign', 'local', root)).toBe('false');
      expect(await getConfig('user.signingKey', 'local', root)).toBeUndefined();
    } finally {
      git(root, ['config', '--global', '--unset', 'commit.gpgsign']);
    }
    // nothing below signs any more → off leaves no local override behind
    await setCommitSigning({ source: 'cli', cwd: root, on: false });
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined();
    await rm(keyDir, { recursive: true, force: true });
  });

  it('an identity bound to a GPG key signs with OpenPGP, and status reports the key owner', async () => {
    // stand-in for gpg: always lists one signing key owned by gpg-user@x.com
    const binDir = await mkdtemp(join(tmpdir(), 'ca-fake-gpg-'));
    const fakeGpg = join(binDir, 'gpg');
    const fpr = 'AAAABBBBCCCCDDDDEEEEFFFF1111222233334444';
    await writeFile(
      fakeGpg,
      [
        '#!/bin/sh',
        "echo 'sec:u:255:22:1111222233334444:1700000000:::u:::scESC:::+:::ed25519:::0:'",
        `echo 'fpr:::::::::${fpr}:'`,
        "echo 'uid:u::::1700000000::H::GPG User <gpg-user@x.com>::::::::::0:'",
        '',
      ].join('\n'),
    );
    await chmodFile(fakeGpg, 0o755);
    git(root, ['config', '--global', 'gpg.program', fakeGpg]);
    try {
      const g = await addIdentity({ name: 'GpgUser', email: 'gpg-user@x.com' });
      await setSignKey(idOf(g.name, g.email), { format: 'openpgp', key: fpr });
      await applyIdentity(idOf(g.name, g.email), { source: 'cli', cwd: root });
      await setCommitSigning({ source: 'cli', cwd: root, id: idOf(g.name, g.email), on: true });
      expect(await getConfig('gpg.format', 'local', root)).toBe('openpgp');
      expect(await getConfig('user.signingKey', 'local', root)).toBe(fpr);
      expect(await getConfig('gpg.ssh.program', 'local', root)).toBeUndefined();
      expect(await signingStatus(root)).toMatchObject({
        enabled: true,
        format: 'openpgp',
        managed: true,
        keyEmails: ['gpg-user@x.com'],
      });
      await setCommitSigning({ source: 'cli', cwd: root, on: false });
    } finally {
      git(root, ['config', '--global', '--unset', 'gpg.program']);
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('logout removes the key from the agent but never deletes the file', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key2-'));
    const keyPath = join(keyDir, 'id_test');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'test'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const id = await addIdentity({ name: 'Carol', email: 'carol@x.com' });
    await setPushKey(idOf(id.name, id.email), { path: imp.path, fingerprint: imp.fingerprint });
    git(root, ['config', '--local', 'user.name', 'Carol']);
    git(root, ['config', '--local', 'user.email', 'carol@x.com']);

    const r = await logoutIdentity({ source: 'cli', cwd: root, id: idOf(id.name, id.email) });
    expect(r.agentRemoved).toBe(false); // no agent under test — removal is best-effort
    await stat(keyPath); // reference mode: the user's file survives logout
    // Carol was the config-active identity → her whole layer is gone
    expect(r.cleared.config).toBe(true);
    expect(await getConfig('core.sshCommand', 'local', root)).toBeUndefined();

    await rm(keyDir, { recursive: true, force: true });
  });

  it('switching to a key-less identity turns signing off even when only an outer scope signs', async () => {
    // global config signs with a foreign key; repo-local carries nothing
    git(root, ['config', '--global', 'commit.gpgsign', 'true']);
    git(root, ['config', '--global', 'user.signingKey', '/keys/id_personal']);
    git(root, ['config', '--global', 'gpg.format', 'ssh']);
    try {
      expect((await signingStatus(root)).enabled).toBe(true); // inherited from global
      const plain = await addIdentity({ name: 'Bare', email: 'bare@x.com' });
      await applyIdentity(idOf(plain.name, plain.email), { source: 'cli', cwd: root });
      // signing follows the identity: no key → really off, pinned locally
      expect(await getConfig('commit.gpgsign', 'local', root)).toBe('false');
      expect(await signingStatus(root)).toMatchObject({ enabled: false, scope: 'local' });
    } finally {
      git(root, ['config', '--local', '--unset', 'commit.gpgsign']);
      git(root, ['config', '--global', '--unset', 'commit.gpgsign']);
      git(root, ['config', '--global', '--unset', 'user.signingKey']);
      git(root, ['config', '--global', '--unset', 'gpg.format']);
    }
  });

  it('a dedicated sign key (set --sign-key) wins over the auth key, and unbinding falls back', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-dual-'));
    const authPath = join(keyDir, 'id_auth');
    const signPath = join(keyDir, 'id_signonly');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', authPath, '-C', 'auth'], { encoding: 'utf8' });
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signPath, '-C', 'sign'], { encoding: 'utf8' });
    const auth = await importKey(authPath);
    const sign = await importKey(signPath);
    const dual = await addIdentity({ name: 'Dual', email: 'dual@x.com' });
    await setPushKey(idOf(dual.name, dual.email), { path: auth.path, fingerprint: auth.fingerprint });

    // no sign key bound → signing uses the AUTH key
    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(dual.name, dual.email), on: true });
    expect(await getConfig('user.signingKey', 'local', root)).toBe(authPath);

    // binding a dedicated sign key moves signing to it (push key untouched)
    await setSignKey(idOf(dual.name, dual.email), { format: 'ssh', path: sign.path, fingerprint: sign.fingerprint });
    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(dual.name, dual.email), on: true });
    expect(await getConfig('user.signingKey', 'local', root)).toBe(signPath);
    expect((await getKeyBinding(idOf(dual.name, dual.email))).pushKey?.path).toBe(auth.path);

    // unbinding falls back to the auth key
    await setSignKey(idOf(dual.name, dual.email), undefined);
    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(dual.name, dual.email), on: true });
    expect(await getConfig('user.signingKey', 'local', root)).toBe(authPath);

    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(dual.name, dual.email), on: false });
    await rm(keyDir, { recursive: true, force: true });
  });

  it('logout clears the identity’s leftover ssh/sign keys even after the repo moved on', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key3-'));
    const keyPath = join(keyDir, 'id_left');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'left'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const dave = await addIdentity({ name: 'Dave', email: 'dave@x.com' });
    await setPushKey(idOf(dave.name, dave.email), { path: imp.path, fingerprint: imp.fingerprint });
    await applyIdentity(idOf(dave.name, dave.email), { source: 'cli', cwd: root }); // writes sshCommand
    await setCommitSigning({ source: 'cli', cwd: root, id: idOf(dave.name, dave.email), on: true }); // writes signing keys

    // the repo moves on with RAW git config — Dave's keys linger behind
    git(root, ['config', '--local', 'user.name', 'Eve']);
    git(root, ['config', '--local', 'user.email', 'eve@x.com']);
    expect(await getConfig('core.sshCommand', 'local', root)).toBeDefined();
    expect(await getConfig('user.signingKey', 'local', root)).toBe(keyPath);

    const r = await logoutIdentity({ source: 'cli', cwd: root, id: idOf(dave.name, dave.email) });
    // Dave's keys are gone from config…
    expect(r.cleared.sshCommand).toBe(true);
    expect(r.cleared.signing).toBe(true);
    expect(await getConfig('core.sshCommand', 'local', root)).toBeUndefined();
    expect(await getConfig('user.signingKey', 'local', root)).toBeUndefined();
    expect(await getConfig('commit.gpgsign', 'local', root)).toBeUndefined();
    expect(await getConfig('gpg.format', 'local', root)).toBeUndefined();
    // …but Eve's committer config survives (name/email clear on match only)
    expect(await getConfig('user.name', 'local', root)).toBe('Eve');
    expect(await getConfig('user.email', 'local', root)).toBe('eve@x.com');

    await rm(keyDir, { recursive: true, force: true });
  });

  it('logout --no-agent skips the ssh-agent unload (the extension asks first)', async () => {
    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-noagent-'));
    const keyPath = join(keyDir, 'id_noagent');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'noagent'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    const id = await addIdentity({ name: 'NoAgent', email: 'noagent@x.com' });
    await setPushKey(idOf(id.name, id.email), { path: imp.path, fingerprint: imp.fingerprint });
    git(root, ['config', '--local', 'user.name', 'NoAgent']);
    git(root, ['config', '--local', 'user.email', 'noagent@x.com']);
    try {
      const r = await dispatch('logout', [idOf(id.name, id.email), '--no-agent', '--json'], { cwd: root, flags: {} as GlobalFlags });
      if (!r.ok) throw new Error('logout dispatch failed');
      expect((r.data as { cleared: { agent: boolean } }).cleared.agent).toBe(false);
      // config still cleared even though the agent was left alone
      expect(await getConfig('user.name', 'local', root)).toBeUndefined();
      git(root, ['config', '--local', 'user.name', 'Original Name']);
      git(root, ['config', '--local', 'user.email', 'original@x.com']);
    } finally {
      await rm(keyDir, { recursive: true, force: true });
    }
  });

  it('audit log never contains the passphrase command secret or key body', async () => {
    const id = await addIdentity({ name: 'Sec', email: 'sec@x.com' });
    await applyIdentity(idOf(id.name, id.email), { source: 'cli', cwd: root });
    const entries = await readAudit();
    const blob = entries.map((e) => JSON.stringify(e)).join('\n');
    // the audit schema records key FINGERPRINTS by design (they are public
    // identifiers); passphrases and key bodies must never appear
    expect(blob).not.toContain('TOPSECRET'); // passphrase-shaped strings never appear
    expect(blob).not.toContain('PRIVATE KEY');
    expect(blob).not.toContain('BEGIN OPENSSH');
  });

  it('historyCommitters lists distinct committers, most frequent first', async () => {
    git(root, ['-c', 'user.name=Committer One', '-c', 'user.email=c1@x.com', 'commit', '-q', '--allow-empty', '-m', 'i1']);
    git(root, ['-c', 'user.name=Committer One', '-c', 'user.email=c1@x.com', 'commit', '-q', '--allow-empty', '-m', 'i2']);
    git(root, ['-c', 'user.name=Committer Two', '-c', 'user.email=c2@x.com', 'commit', '-q', '--allow-empty', '-m', 'i3']);
    const cs = await historyCommitters(root);
    expect(cs.map((c) => c.email)).toEqual(['c1@x.com', 'c2@x.com']);
    expect(cs[0]).toMatchObject({ name: 'Committer One' });
  });

  it('identity import adds every history committer once, then is a no-op', async () => {
    const first = await importFromHistory({ cwd: root } as Parameters<typeof importFromHistory>[0]);
    const d1 = (first as { ok: true; data: { added: { email: string }[]; skipped: number } }).data;
    expect(d1.added.map((a) => a.email).sort()).toEqual(['c1@x.com', 'c2@x.com']);
    const { identities } = await listIdentities();
    for (const e of ['c1@x.com', 'c2@x.com']) {
      expect(identities.some((i) => i.email === e)).toBe(true);
    }
    const second = await importFromHistory({ cwd: root } as Parameters<typeof importFromHistory>[0]);
    const d2 = (second as { ok: true; data: { added: unknown[]; skipped: number } }).data;
    expect(d2.added).toEqual([]);
    expect(d2.skipped).toBe(d1.added.length);
  });

  it('identity set renames and re-references the key', async () => {
    const { identities } = await listIdentities();
    const target = identities.find((i) => i.email === 'c1@x.com')!;
    const renamed = await updateIdentity(idOf(target.name, target.email), { name: 'Committer Renamed' });
    expect(renamed.name).toBe('Committer Renamed');
    expect(renamed.email).toBe('c1@x.com');
    expect(idOf(renamed.name, renamed.email)).toBe('Committer Renamed <c1@x.com>'); // re-keyed — old refs die, the returned ref lives
    const ref = idOf(renamed.name, renamed.email);

    const keyDir = await mkdtemp(join(tmpdir(), 'ca-key-set-'));
    const keyPath = join(keyDir, 'id_set');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'set'], { encoding: 'utf8' });
    const imp = await importKey(keyPath);
    await setPushKey(ref, { path: imp.path, fingerprint: imp.fingerprint });
    expect((await getKeyBinding(ref)).pushKey?.path).toBe(keyPath);

    await setPushKey(ref, undefined);
    expect((await getKeyBinding(ref)).pushKey).toBeUndefined();
    await rm(keyDir, { recursive: true, force: true });
  });

  it('rm of an imported identity hides it from future imports; a manual add un-hides', async () => {
    const { identities } = await listIdentities();
    const target = identities.find((i) => i.email === 'c2@x.com')!;
    expect(target.scope).toBe('project'); // history import ⟺ project scope
    await removeIdentity(idOf(target.name, target.email));
    await hideIdentityEmail(target.email);

    const again = await importFromHistory({ cwd: root } as Parameters<typeof importFromHistory>[0]);
    const d = (again as { ok: true; data: { added: { email: string }[] } }).data;
    expect(d.added.map((a) => a.email)).not.toContain('c2@x.com'); // hidden — no resurrection

    const manual = await addIdentity({ name: 'Committer Two', email: 'C2@x.com' }); // manual add clears hidden
    const third = await importFromHistory({ cwd: root } as Parameters<typeof importFromHistory>[0]);
    const d3 = (third as { ok: true; data: { added: { email: string }[] } }).data;
    expect(d3.added.map((a) => a.email)).not.toContain('C2@x.com'); // already present via manual add
    const mapNow = await listIdentities();
    expect(mapNow.identities.some((i) => idOf(i.name, i.email) === idOf(manual.name, manual.email))).toBe(true);
  });
});
