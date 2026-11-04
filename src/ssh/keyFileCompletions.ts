import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Pure filesystem side of the key picker (no vscode imports — unit-testable):
 * tilde/path normalization, per-directory classification (which files are
 * private keys, which are encrypted), and prefix-filtered completions.
 * Completion rows list DIRECTORIES and PRIVATE KEYS only — other files are
 * not pickable and therefore not shown.
 */

export type CompletionRow = {
  label: string;
  description: string;
  detail: string;
  /** directory to drill into */
  dirPath?: string;
  /** a private-key file to pick */
  keyPath?: string;
};

/** Normalize IME input: slashes become their ASCII forms. */
export function normalizeTypedPath(v: string): string {
  return v.replace(/／/g, '/');
}

export function pathLike(v: string): boolean {
  const t = normalizeTypedPath(v);
  return t.startsWith('~') || t.startsWith('/') || t.startsWith('./') || t.startsWith('../');
}

export function expandTilde(v: string, home: string): string {
  return normalizeTypedPath(v).replace(/^~(?=\/|$)/, home);
}

/** every private-key format carries a BEGIN … PRIVATE KEY armor header */
export async function isPrivateKeyFile(path: string): Promise<boolean> {
  try {
    const head = (await readFile(path, 'utf8')).slice(0, 256);
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(head);
  } catch {
    return false;
  }
}

const KINDS: Record<string, string> = {
  OPENSSH: 'OpenSSH',
  RSA: 'RSA',
  EC: 'EC',
  DSA: 'DSA',
  ENCRYPTED: 'PKCS#8',
  '': 'PrivateKey',
};

type FileClass = { kind: string; encrypted: boolean | null };

/** OpenSSH-format keys carry no PEM encryption marker — probe with ssh-keygen. */
async function probeEncrypted(path: string): Promise<boolean | null> {
  try {
    await exec('ssh-keygen', ['-y', '-P', '', '-f', path], { timeout: 2000 });
    return false; // empty passphrase accepted → unencrypted
  } catch (e) {
    const err = e as { message?: string; stderr?: string };
    const msg = `${err.message ?? ''} ${err.stderr ?? ''}`;
    return /passphrase|incorrect|failed to load|error in libcrypto/i.test(msg) ? true : null;
  }
}

async function classifyFile(path: string): Promise<FileClass | undefined> {
  let head: string;
  try {
    head = (await readFile(path, 'utf8')).slice(0, 512);
  } catch {
    return undefined;
  }
  const m = head.match(/-----BEGIN ([A-Z ]*?) ?PRIVATE KEY-----/);
  if (!m) return undefined; // not a key
  const kind = KINDS[m[1] ?? ''] ?? m[1] ?? 'PrivateKey';
  if (head.includes('ENCRYPTED')) return { kind, encrypted: true }; // PEM Proc-Type
  if (kind === 'OpenSSH') return { kind, encrypted: await probeEncrypted(path) };
  return { kind, encrypted: false };
}

/** One classified listing per directory per picker invocation (cached). */
export type DirCache = Map<string, CompletionRow[]>;

/**
 * Directories first, then private keys (encrypted marked); non-key files are
 * omitted. Hidden entries (`.ssh`, `.hidden_key`…) are ALWAYS included — the
 * user's keys usually live in them.
 */
export async function listDirRows(dir: string, cache: DirCache): Promise<CompletionRow[]> {
  const cached = cache.get(dir);
  if (cached) return cached;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: CompletionRow[] = [];
  const keys: CompletionRow[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = dir.endsWith('/') ? dir + e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) {
      dirs.push({ label: `$(folder) ${e.name}/`, description: full, detail: 'directory', dirPath: full });
    } else if (e.isFile()) {
      const cls = await classifyFile(full);
      if (!cls) continue; // not a private key — not pickable, not shown
      const enc = cls.encrypted === true;
      keys.push({
        label: `${enc ? '$(lock)' : '$(key)'} ${e.name}`,
        description: dir,
        detail: `${cls.kind} private key${enc ? ' · encrypted (passphrase needed)' : ''}`,
        keyPath: full,
      });
    }
  }
  const rows = [...dirs, ...keys];
  cache.set(dir, rows);
  return rows;
}

/**
 * Completions for a typed path: `~` / `~/` list the home directory itself;
 * a trailing `/` lists that directory; otherwise the last segment
 * prefix-filters the parent's listing.
 *
 * IMPORTANT: the QuickPick input is FILTER TEXT — VS Code fuzzily filters
 * whatever items we set against it. Completion rows therefore carry the
 * TYPED path in their label (e.g. "~/Doc" → "$(folder) ~/Documents/"), so
 * the platform filter always passes; description holds the absolute path.
 */
export async function pathCompletions(value: string, home: string, cache: DirCache): Promise<CompletionRow[]> {
  const expanded = expandTilde(value, home);
  const endsInDir = value.endsWith('/') || value === '~';
  const idx = expanded.lastIndexOf('/');
  const dirPart = endsInDir ? expanded : idx >= 0 ? expanded.slice(0, idx) || '/' : '.';
  const prefix = endsInDir ? '' : expanded.slice(idx + 1).toLowerCase();
  const rows = await listDirRows(dirPart, cache);
  // how the completed path looks in the user's own spelling: the typed value
  // plus the rest of the entry's name ("~/Doc" + "uments/")
  const labelOf = (name: string, isDir: boolean): string => {
    const head = value === '~' ? '~/' : endsInDir ? value : value.slice(0, value.length - prefix.length);
    return `${head}${name}${isDir ? '/' : ''}`;
  };
  const out = rows
    .filter((r) => {
      if (prefix === '') return true;
      const name = r.dirPath ? r.dirPath.split('/').pop() : r.keyPath?.split('/').pop();
      return (name ?? '').toLowerCase().startsWith(prefix);
    })
    .map((r) => {
      const isDir = !!r.dirPath;
      const name = (r.dirPath ?? r.keyPath ?? '').split('/').pop() ?? '';
      return { ...r, label: `${isDir ? '$(folder)' : r.label.startsWith('$(lock)') ? '$(lock)' : '$(key)'} ${labelOf(name, isDir)}` };
    });
  return out;
}
