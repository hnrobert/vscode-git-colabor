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
  imported?: boolean;
  isDefault: boolean;
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

export type StatusIdentityJson = IdentityJson & { active?: boolean };

/** Shape of `git colabor identity status --json` data. */
export type StatusJson = {
  repo: string | null;
  inRepo: boolean;
  managed: boolean;
  managedBy: string | null;
  heldBy: HeldByJson | null;
  activeIdentity: IdentityJson | null;
  identities: StatusIdentityJson[];
  selected: CoAuthorBriefJson[];
  available: CoAuthorBriefJson[];
};
