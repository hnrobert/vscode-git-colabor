import { appendFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { auditLogPath } from '../paths.js';
import type { AuditAction, AuditEntry, Source } from '../types.js';

export type AuditInput = {
  action: AuditAction;
  source: Source;
  identity?: string;
  identityName?: string;
  /** SSH key fingerprint only — never the key body or passphrase. */
  fingerprint?: string;
  repo?: string;
  sha?: string;
  result?: 'ok' | 'warn' | 'error';
  message?: string;
};

/** Append a redacted audit entry (JSON line) to ~/.config/git-colabor/audit.log (0600). */
export async function appendAudit(input: AuditInput): Promise<void> {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    action: input.action,
    identity: input.identity,
    identityName: input.identityName,
    fingerprint: input.fingerprint,
    repo: input.repo,
    sha: input.sha,
    host: hostname(),
    osUser: userInfo().username,
    source: input.source,
    result: input.result ?? 'ok',
    message: input.message,
  };
  const file = auditLogPath();
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
    await chmod(file, 0o600).catch(() => {});
  } catch {
    // best-effort; never fail a command because audit logging failed
  }
}

/** Read + filter audit entries (newest last). */
export async function readAudit(opts: { repo?: string; since?: string; tail?: number } = {}): Promise<AuditEntry[]> {
  try {
    const txt = await readFile(auditLogPath(), 'utf8');
    let entries = txt
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry);
    if (opts.repo) entries = entries.filter((e) => e.repo === opts.repo);
    if (opts.since) {
      const t = new Date(opts.since).getTime();
      entries = entries.filter((e) => new Date(e.ts).getTime() >= t);
    }
    if (opts.tail && opts.tail > 0) entries = entries.slice(-opts.tail);
    return entries;
  } catch {
    return [];
  }
}
