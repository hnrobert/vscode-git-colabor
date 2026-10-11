import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { SigningJson } from '../types.js';

/** A concrete key to sign commits with. */
export type SigningKey = { format: 'openpgp' | 'ssh'; key: string };

/**
 * This window's signing layer: `undefined` = untouched (repo / global config
 * decides), `'off'` = Stop (inject commit.gpgsign=false), a key = sign with it.
 */
export type WindowSigning = SigningKey | 'off' | undefined;

export type SigningMatch = 'match' | 'mismatch' | 'unknown';

type KeyOwner = { id: string; email: string; sshKeyPath?: string; gpgKey?: string };

const FORMAT_LABEL: Record<string, string> = { openpgp: 'GPG', ssh: 'SSH', x509: 'X.509' };

/**
 * What an identity signs with: its bound GPG key wins, else its SSH key —
 * mirrors the CLI's re-bind rule. Agent-held SSH keys sign via the `.pub`
 * half (`ssh-keygen -Y sign` consults the agent only for a public key path).
 */
export function identitySigningKey(
  i: { hasKey?: boolean; sshKeyPath?: string; inAgent?: boolean; gpgKey?: string },
  exists: (path: string) => boolean = existsSync,
): SigningKey | undefined {
  if (i.gpgKey) return { format: 'openpgp', key: i.gpgKey };
  if (!i.hasKey || !i.sshKeyPath) return undefined;
  const pub = `${i.sshKeyPath}.pub`;
  return { format: 'ssh', key: i.inAgent && exists(pub) ? pub : i.sshKeyPath };
}

/**
 * Overlay this window's layer on the file-scope state from the CLI. Env
 * config outranks every config file, so a window setting always wins; the
 * file state stays reachable as `below` for the tooltip.
 */
export function overlayWindowSigning(file: SigningJson, win: WindowSigning): SigningJson {
  if (!win) return file;
  const layer = { scope: 'window', origin: null, managed: true, below: file };
  return win === 'off'
    ? { ...layer, enabled: false, key: null, format: file.format }
    : { ...layer, enabled: true, key: win.key, format: win.format };
}

/** Same key? Ignores a `.pub` suffix; a GPG key id matches the tail of its fingerprint. */
export function sameKey(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().replace(/\.pub$/, '');
  const y = b.trim().replace(/\.pub$/, '');
  if (x === y) return true;
  const hex = (k: string) => (/^(0x)?[0-9a-f]{8,}!?$/i.test(k) ? k.replace(/^0x/i, '').replace(/!$/, '').toUpperCase() : undefined);
  const hx = hex(x);
  const hy = hex(y);
  return !!hx && !!hy && (hx.endsWith(hy) || hy.endsWith(hx));
}

/**
 * Does the signing key belong to the committer? A key another identity owns,
 * or a GPG key whose user ids lack the committer's email, is a `mismatch`
 * (hosts like GitHub show such commits as Unverified); anything we cannot
 * tell is `unknown` and never warns.
 */
export function signingMatch(s: SigningJson, active: KeyOwner | undefined, identities: KeyOwner[]): SigningMatch {
  if (!s.enabled || !s.key || !active) return 'unknown';
  const owns = (i: KeyOwner) => sameKey(s.key, s.format === 'ssh' ? i.sshKeyPath : i.gpgKey);
  if (owns(active)) return 'match';
  if (s.format === 'openpgp' && s.keyEmails?.length) {
    return s.keyEmails.includes(active.email.toLowerCase()) ? 'match' : 'mismatch';
  }
  return identities.some((i) => i.id !== active.id && owns(i)) ? 'mismatch' : 'unknown';
}

/** Where the signing state comes from, e.g. "global" / "this window" / "repo config (colabor)". */
export function signingSource(s: SigningJson): string {
  switch (s.scope) {
    case 'window':
      return 'this window';
    case 'local':
    case 'worktree':
      return s.managed ? 'repo config (colabor)' : 'repo config';
    case null:
      return 'git default';
    default:
      return s.scope; // global / system / command
  }
}

/** One-line summary: "GPG 440D7FEC95663AF8 · global", "SSH id_alice · this window", "off · repo config". */
export function describeSigning(s: SigningJson): string {
  if (!s.enabled) return s.scope ? `off · ${signingSource(s)}` : 'off';
  const key = !s.key ? '' : s.format === 'ssh' ? ` ${basename(s.key)}` : ` ${s.key.slice(-16)}`;
  return `${FORMAT_LABEL[s.format] ?? s.format}${key} · ${signingSource(s)}`;
}

export function signingTooltip(s: SigningJson, match: SigningMatch, committer?: string): string {
  const lines = [`Commit signing: ${s.enabled ? 'on' : 'off'}`];
  if (s.enabled) {
    lines.push(`Format: ${FORMAT_LABEL[s.format] ?? s.format} (gpg.format=${s.format})`);
    lines.push(`Key: ${s.key ?? '(picked by committer email)'}`);
  }
  if (s.scope === 'window') {
    lines.push(
      'Set for THIS WINDOW only (env-injected, no config file written). It covers commits made from the Source Control view; integrated-terminal commits follow repo / global config.',
    );
  } else if (s.scope) {
    lines.push(`From ${s.scope} config: ${s.origin ?? '(unknown file)'}`);
  } else {
    lines.push('commit.gpgsign is not set in any config (git default: off).');
  }
  if (s.below) lines.push(`Without this window's setting: ${describeSigning(s.below)}${s.below.origin ? ` (${s.below.origin})` : ''}`);
  if (match === 'mismatch') {
    lines.push(
      `⚠ This key does not belong to ${committer ?? 'the active identity'} — hosts like GitHub show such commits as Unverified. Right-click to sign with their key or stop signing.`,
    );
  }
  return lines.join('\n');
}
