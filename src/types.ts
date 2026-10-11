// Mirror of the CLI's --json envelope (kept local so the extension does not need a runtime
// dependency on the CLI package; only this shape must stay in sync with git-colabor/src/core/types.ts).
export type JsonResult =
  | { ok: true; data: unknown; warnings?: Warning[] }
  | { ok: false; error: { code: string; message: string; hints?: string[]; exitCode: number }; data: null };

export type Warning = { code: string; message: string; details?: unknown };

export type IdentityJson = {
  id: string;
  name: string;
  email: string;
  sshKeyFingerprint?: string;
  host?: string;
  hasKey: boolean;
  /** referenced key source path (present whenever hasKey) */
  sshKeyPath?: string;
  keyEncrypted?: boolean;
  /** key fingerprint currently held by ssh-agent (live check per status call) */
  inAgent?: boolean;
  imported?: boolean;
  disabled?: boolean;
  /** store-level scope; the "vscode memory" is a settings-layer flag, not a scope value */
  scope?: 'machine' | 'project';
  remoteKeys?: Record<string, string>;
  /** bound OpenPGP signing key (fingerprint); wins over the SSH key for signing */
  gpgKey?: string;
  isDefault: boolean;
};

/** One `identity gpg-keys` row: a secret key usable for commit signing. */
export type GpgKeyJson = { fingerprint: string; keyId: string; uids: string[]; emails: string[] };

/**
 * The EFFECTIVE commit signing state — what `git commit` will actually do.
 * The CLI resolves the file scopes (local / global / system); the extension
 * overlays this window's env-injected layer as scope `window`.
 */
export type SigningJson = {
  enabled: boolean;
  /** null: OpenPGP picks a key by committer email */
  key: string | null;
  /** gpg.format: openpgp (git's default) / ssh / x509 */
  format: string;
  /** where commit.gpgsign comes from: window / local / global / system / …; null = unset everywhere */
  scope: string | null;
  /** config file of that scope */
  origin: string | null;
  /** colabor turned it on (repo `identity sign`, or this window) */
  managed: boolean;
  /** OpenPGP: emails on the signing key (mismatch detection) */
  keyEmails?: string[];
  /** window overlay only: what the repo / global config alone would do */
  below?: SigningJson;
};

export type DiagnosticJson = { check: string; status: 'ok' | 'warn' | 'fail'; detail?: string };

export type CoAuthorBriefJson = { key: string; name: string; email: string };

export type HeldByJson = {
  session: string;
  since: string;
  host: string;
  osUser: string;
  source: 'ext' | 'cli';
};

export type StatusIdentityJson = IdentityJson & { active?: boolean; sshKeyPath?: string };

/** Shape of `git colabor identity status --json` data. */
export type StatusJson = {
  repo: string | null;
  inRepo: boolean;
  managed: boolean;
  managedBy: string | null;
  heldBy: HeldByJson | null;
  signing: SigningJson;
  activeIdentity: IdentityJson | null;
  identities: StatusIdentityJson[];
  selected: CoAuthorBriefJson[];
  available: CoAuthorBriefJson[];
};
