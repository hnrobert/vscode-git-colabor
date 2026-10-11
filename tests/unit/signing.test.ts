import { describe, expect, it } from 'vitest';
import {
  describeSigning,
  identitySigningKey,
  overlayWindowSigning,
  sameKey,
  signingMatch,
} from '../../src/session/signing.js';
import type { SigningJson } from '../../src/types.js';

const off: SigningJson = { enabled: false, key: null, format: 'openpgp', scope: null, origin: null, managed: false };
const globalGpg: SigningJson = {
  enabled: true,
  key: '440D7FEC95663AF8',
  format: 'openpgp',
  scope: 'global',
  origin: '/home/me/.gitconfig',
  managed: false,
  keyEmails: ['me@personal.dev'],
};

const alice = { id: 'a', email: 'alice@x.com', sshKeyPath: '/k/id_alice', gpgKey: 'AAAABBBBCCCCDDDD1111222233334444' };
const bob = { id: 'b', email: 'bob@x.com', sshKeyPath: '/k/id_bob' };

describe('identitySigningKey', () => {
  it('prefers a bound GPG key over the SSH key', () => {
    expect(identitySigningKey({ hasKey: true, sshKeyPath: '/k/id', gpgKey: 'FPR' })).toEqual({ format: 'openpgp', key: 'FPR' });
  });

  it('signs an agent-held SSH key through its .pub half', () => {
    const exists = (p: string) => p === '/k/id.pub';
    expect(identitySigningKey({ hasKey: true, sshKeyPath: '/k/id', inAgent: true }, exists)).toEqual({ format: 'ssh', key: '/k/id.pub' });
    expect(identitySigningKey({ hasKey: true, sshKeyPath: '/k/id', inAgent: false }, exists)).toEqual({ format: 'ssh', key: '/k/id' });
  });

  it('has nothing to sign with when the identity has no key', () => {
    expect(identitySigningKey({ hasKey: false, sshKeyPath: '/k/missing' })).toBeUndefined();
  });
});

describe('overlayWindowSigning', () => {
  it('window Stop turns signing off even when global config signs, keeping the file state below', () => {
    const s = overlayWindowSigning(globalGpg, 'off');
    expect(s).toMatchObject({ enabled: false, scope: 'window' });
    expect(s.below).toBe(globalGpg);
  });

  it('a window key replaces whatever the config files say', () => {
    expect(overlayWindowSigning(off, { format: 'ssh', key: '/k/id_alice' })).toMatchObject({
      enabled: true,
      format: 'ssh',
      key: '/k/id_alice',
      scope: 'window',
    });
  });

  it('an untouched window leaves the effective file state as is', () => {
    expect(overlayWindowSigning(globalGpg, undefined)).toBe(globalGpg);
  });
});

describe('sameKey', () => {
  it('matches a GPG key id against the tail of its fingerprint', () => {
    expect(sameKey('0x1111222233334444', 'AAAABBBBCCCCDDDD1111222233334444')).toBe(true);
    expect(sameKey('9999222233334444', 'AAAABBBBCCCCDDDD1111222233334444')).toBe(false);
  });

  it('treats an SSH key and its .pub half as the same key', () => {
    expect(sameKey('/k/id_alice.pub', '/k/id_alice')).toBe(true);
    expect(sameKey('/k/id_alice', '/k/id_bob')).toBe(false);
  });
});

describe('signingMatch', () => {
  it('the identity signing with its own key is a match', () => {
    const s = { ...globalGpg, key: alice.gpgKey, keyEmails: undefined };
    expect(signingMatch(s, alice, [alice, bob])).toBe('match');
  });

  it('a GPG key without the committer email is a mismatch (e.g. a personal key from ~/.gitconfig)', () => {
    expect(signingMatch(globalGpg, alice, [alice, bob])).toBe('mismatch');
    expect(signingMatch({ ...globalGpg, keyEmails: ['alice@x.com'] }, alice, [alice, bob])).toBe('match');
  });

  it("another identity's SSH key is a mismatch, an unknown key never warns", () => {
    const ssh = { ...off, enabled: true, format: 'ssh', scope: 'local', key: '/k/id_bob.pub' };
    expect(signingMatch(ssh, alice, [alice, bob])).toBe('mismatch');
    expect(signingMatch({ ...ssh, key: '/elsewhere/id' }, alice, [alice, bob])).toBe('unknown');
  });

  it('nothing to compare when not signing or no identity is active', () => {
    expect(signingMatch(off, alice, [alice])).toBe('unknown');
    expect(signingMatch(globalGpg, undefined, [alice])).toBe('unknown');
  });
});

describe('describeSigning', () => {
  it('names the format, key and the layer it comes from', () => {
    expect(describeSigning(globalGpg)).toBe('GPG 440D7FEC95663AF8 · global');
    expect(describeSigning({ ...off, enabled: true, format: 'ssh', key: '/k/id_alice.pub', scope: 'local', managed: true })).toBe(
      'SSH id_alice.pub · repo config (colabor)',
    );
  });

  it('says where an explicit off comes from, and plain off when nothing is set', () => {
    expect(describeSigning(overlayWindowSigning(globalGpg, 'off'))).toBe('off · this window');
    expect(describeSigning(off)).toBe('off');
  });
});
