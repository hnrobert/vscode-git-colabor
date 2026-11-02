/**
 * Core data model & shared types for git-colabor.
 * Author lives in `./authors/types.ts`; this module holds everything else.
 */

export type Source = 'ext' | 'cli';

export type Identity = {
  /** deterministic: "id_" + sha256(name + "\n" + email) — stable across key changes */
  id: string;
  name: string;
  email: string;
  /** informational, e.g. "github.com" */
  host?: string;
  /** true when auto-imported from repo history (`identity import`) */
  imported?: boolean;
  /** where this identity is remembered: machine (identities.json) or project (repo scan) */
  scope?: 'machine' | 'project';
  /** true when discovered from git config (auto-enrollment) rather than added by hand */
  fromConfig?: boolean;
  /** ISO8601 */
  createdAt: string;
};

/** A referenced SSH key: path + derived facts (machine-local by construction). */
export type SshKeyRef = {
  /** absolute path to the private key file — never a copy */
  path: string;
  /** "SHA256:…" from `ssh-keygen -lf` */
  fingerprint: string;
  /** passphrase-protected (probed at bind time) */
  encrypted?: boolean;
};

/** A signing key: SSH key reference or OpenPGP fingerprint. */
export type SignKeyRef =
  | ({ format: 'ssh' } & SshKeyRef)
  | { format: 'openpgp'; /** primary fingerprint of the secret key */ key: string };

/** Per-identity key PREFERENCES — recorded separately from the identity itself,
 *  applied only at use/session time (best effort), never at set time. */
export type KeyBinding = {
  pushKey?: SshKeyRef;
  signKey?: SignKeyRef;
};

export type IdentityMap = {
  schemaVersion: 1;
  identities: Record<string, Identity>;
  /** key preferences, keyed by identity id — machine scope by construction */
  keyBindings?: Record<string, KeyBinding>;
  defaultIdentity?: string;
  /** lowercased emails hidden from auto-import (hide machine-level) */
  hidden?: Record<string, true>;
  /** repo roots whose git config the user explicitly stripped — auto-apply
   *  stands down until an explicit local-scope apply (see map.ts) */
  standingDown?: string[];
};

export type HeldBy = {
  /** ext: vscode sessionId ; cli: `cli:<pid>@<host>` */
  session: string;
  /** ISO8601 */
  since: string;
  host: string;
  osUser: string;
  source: Source;
};

export type Backups = {
  /** undefined ⇒ originally unset */
  userName?: string;
  userEmail?: string;
  sshCommand?: string;
  commitTemplate?: string;
  commitGpgsign?: string;
  gpgFormat?: string;
  signingKey?: string;
};

export type RepoState = {
  schemaVersion: 1;
  activeIdentity?: string;
  heldBy?: HeldBy;
  /** user opted into commit signing with the active identity's key for this repo (right-click toggle) */
  signing?: boolean;
  /** captured on first touch */
  backups?: Backups;
};

export type AuditAction =
  | 'identity.use'
  | 'identity.logout'
  | 'identity.import'
  | 'identity.set'
  | 'identity.sign'
  | 'identity.disable'
  | 'identity.hide'
  | 'coauthor.use'
  | 'coauthor.solo'
  | 'key.load'
  | 'key.remove'
  | 'secret.store'
  | 'secret.delete';

export type AuditEntry = {
  ts: string;
  action: AuditAction;
  identity?: string;
  identityName?: string;
  /** SSH key fingerprint only — never the key/passphrase */
  fingerprint?: string;
  repo?: string;
  sha?: string;
  host: string;
  osUser: string;
  source: Source;
  result: 'ok' | 'warn' | 'error';
  /** redacted */
  message?: string;
};

export type Warning = { code: string; message: string; details?: unknown };

export type ErrorPayload = {
  code: string;
  message: string;
  hints?: string[];
  exitCode: number;
};

export type JsonResult =
  | { ok: true; data: unknown; warnings?: Warning[] }
  | { ok: false; error: ErrorPayload; data: null };

export type Diagnostic = { check: string; status: 'ok' | 'warn' | 'fail'; detail?: string };
