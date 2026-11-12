import { describe, it, expect } from 'vitest';
import { parseSecretKeys } from '../../src/core/identity/gpg.js';

// shape of `gpg --list-secret-keys --with-colons` (trimmed to the fields we read)
const sample = [
  'sec:u:255:22:1111222233334444:1700000000:::u:::scESC:::+:::ed25519:::0:',
  'fpr:::::::::AAAABBBBCCCCDDDDEEEEFFFF1111222233334444:',
  'uid:u::::1700000000::H1::Alice Example <Alice@X.com>::::::::::0:',
  'uid:r::::1700000000::H2::Old Alice <old@x.com>::::::::::0:',
  'uid:u::::1700000000::H3::Team\\x3a Alice <alice@team.dev>::::::::::0:',
  'ssb:u:255:18:5555666677778888:1700000000::::::e:::+:::cv25519::',
  'fpr:::::::::99990000111122223333444455556666777788889:',
  'sec:r:255:22:AAAA0000BBBB1111:1600000000:::u:::scESC:::+:::ed25519:::0:',
  'fpr:::::::::REVOKED0000000000000000000000AAAA0000BBBB1111:',
  'uid:r::::1600000000::H4::Revoked <rev@x.com>::::::::::0:',
  'sec:u:3072:1:CCCC2222DDDD3333:1600000000:::u:::eE:::+:::rsa3072:::0:',
  'fpr:::::::::ENCRYPTONLY0000000000000000000CCCC2222DDDD3333:',
  'uid:u::::1600000000::H5::Crypt <crypt@x.com>::::::::::0:',
  '',
].join('\n');

describe('parseSecretKeys', () => {
  it('keeps only keys usable for signing (S capability, not revoked/expired)', () => {
    expect(parseSecretKeys(sample).map((k) => k.keyId)).toEqual(['1111222233334444']);
  });

  it('takes the primary fingerprint, never a subkey one', () => {
    expect(parseSecretKeys(sample)[0]?.fingerprint).toBe('AAAABBBBCCCCDDDDEEEEFFFF1111222233334444');
  });

  it('lists valid user ids with unescaped text and lowercased emails', () => {
    const [key] = parseSecretKeys(sample);
    expect(key?.uids).toEqual(['Alice Example <Alice@X.com>', 'Team: Alice <alice@team.dev>']);
    expect(key?.emails).toEqual(['alice@x.com', 'alice@team.dev']);
  });

  it('returns [] for empty output', () => {
    expect(parseSecretKeys('')).toEqual([]);
  });
});
