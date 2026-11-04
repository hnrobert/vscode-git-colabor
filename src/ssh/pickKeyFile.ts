import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

/**
 * The ONE SSH-private-key picker (auth key, sign key): a custom QuickPick
 * that lists known keys (candidates + a ~/.ssh scan), autocompletes a typed
 * filesystem path live (dirs drill down, files select — every directory is
 * classified: which files are keys, which are encrypted), and offers a
 * Browse dialog defaulting to ~/.ssh. Extras (generate / paste / skip /
 * clear) are enabled per caller.
 */

export type KeyFileCandidate = {
  /** absolute path of an existing private key */
  path: string;
  /** row label, e.g. "$(key) id_ed25519" */
  label: string;
  /** usually the directory */
  description?: string;
  /** e.g. "referenced by Robert He (auth key)" */
  detail?: string;
};

export type KeyFilePick =
  | { kind: 'path'; path: string }
  | { kind: 'generate' }
  | { kind: 'paste' }
  | { kind: 'skip' }
  | { kind: 'clear' };

type Item = vscode.QuickPickItem & {
  keyPath?: string;
  /** completion entry: a directory to drill into */
  dirPath?: string;
  /** a path the user typed or browsed to — content-checked before accepting */
  unverified?: boolean;
  generate?: boolean;
  paste?: boolean;
  skip?: boolean;
  clear?: boolean;
  browse?: boolean;
};

const BROWSE_LABEL = 'Browse for a key file…';

const pathLike = (v: string): boolean =>
  v.startsWith('~') || v.startsWith('/') || v.startsWith('./') || v.startsWith('../');

const expandTilde = (v: string): string => v.replace(/^~(?=\/|$)/, homedir());

/** every private-key format carries a BEGIN … PRIVATE KEY armor header */
export async function isPrivateKeyFile(path: string): Promise<boolean> {
  try {
    const head = (await readFile(path, 'utf8')).slice(0, 256);
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(head);
  } catch {
    return false;
  }
}

// --- directory classification (shared by the static list and completions) ---

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
    const msg = e instanceof Error ? e.message : String(e);
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
  if (kind === 'OpenSSH') {
    const enc = await probeEncrypted(path);
    return { kind, encrypted: enc };
  }
  return { kind, encrypted: false };
}

/** One classified listing per directory per picker invocation (keys first). */
type DirCache = Map<string, Item[]>;

async function listDirItems(dir: string, cache: DirCache): Promise<Item[]> {
  const cached = cache.get(dir);
  if (cached) return cached;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: Item[] = [];
  const keys: Item[] = [];
  const files: Item[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue; // completion re-shows dotfiles while typing a dot
    const full = dir.endsWith('/') ? dir + e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) {
      dirs.push({ label: `$(folder) ${e.name}/`, description: full, detail: 'directory', dirPath: full });
    } else if (e.isFile()) {
      const cls = await classifyFile(full);
      if (cls) {
        const enc = cls.encrypted === true;
        keys.push({
          label: `${enc ? '$(lock)' : '$(key)'} ${e.name}`,
          description: dir,
          detail: `${cls.kind} private key${enc ? ' · encrypted (passphrase needed)' : ''}`,
          keyPath: full,
          unverified: true,
        });
      } else {
        files.push({ label: `$(file) ${e.name}`, description: full, keyPath: full, unverified: true });
      }
    }
  }
  const items = [...dirs, ...keys, ...files];
  cache.set(dir, items);
  return items;
}

/**
 * Live filesystem completions for a typed path. A bare `~` / `~/` lists the
 * home directory itself; otherwise the last segment filters the parent's
 * classified listing (dirs → keys → other files).
 */
async function pathCompletions(value: string, cache: DirCache): Promise<Item[]> {
  const expanded = expandTilde(value);
  const endsInDir = value.endsWith('/') || value === '~';
  const idx = expanded.lastIndexOf('/');
  const dirPart = endsInDir ? expanded : idx >= 0 ? expanded.slice(0, idx) || '/' : '.';
  const prefix = endsInDir ? '' : expanded.slice(idx + 1).toLowerCase();
  const items = await listDirItems(dirPart, cache);
  if (prefix === '') return items;
  const filtered = items.filter((i) => {
    const name = i.dirPath ? `${i.dirPath.split('/').pop()}/` : i.keyPath ? i.keyPath.split('/').pop() : i.label;
    return (name ?? '').toLowerCase().startsWith(prefix);
  });
  // dotfiles: hidden from the listing, but typing a dot prefix reveals them
  if (prefix.startsWith('.')) {
    try {
      const extra = await readdir(dirPart, { withFileTypes: true });
      for (const e of extra) {
        if (!e.name.toLowerCase().startsWith(prefix)) continue;
        const full = dirPart.endsWith('/') ? dirPart + e.name : `${dirPart}/${e.name}`;
        if (e.isDirectory()) filtered.push({ label: `$(folder) ${e.name}/`, description: full, detail: 'directory', dirPath: full });
        else if (e.isFile()) {
          const cls = await classifyFile(full);
          filtered.push(
            cls
              ? { label: `${cls.encrypted === true ? '$(lock)' : '$(key)'} ${e.name}`, description: dirPart, detail: `${cls.kind} private key${cls.encrypted === true ? ' · encrypted (passphrase needed)' : ''}`, keyPath: full, unverified: true }
              : { label: `$(file) ${e.name}`, description: full, keyPath: full, unverified: true },
          );
        }
      }
    } catch {
      // unreadable — the filtered listing stands
    }
  }
  return filtered;
}

/**
 * Pick an SSH private key. Returns undefined when cancelled; a `path` result
 * is always a content-checked private key (candidate rows count as checked).
 */
export async function pickKeyFile(opts: {
  title: string;
  placeHolder: string;
  /** pre-ranked known keys, shown above the ~/.ssh scan */
  candidates?: KeyFileCandidate[];
  generate?: boolean;
  paste?: boolean;
  skip?: boolean;
  clear?: boolean;
  openLabel?: string;
}): Promise<KeyFilePick | undefined> {
  const cache: DirCache = new Map();
  const sshDir = join(homedir(), '.ssh');

  // static list: candidates first (already ranked), then a classified ~/.ssh
  // scan (keys only — with encryption icons), then extras
  const seen = new Set<string>();
  const staticItems: Item[] = [];
  for (const c of opts.candidates ?? []) {
    if (!c.path || seen.has(c.path) || !existsSync(c.path)) continue;
    seen.add(c.path);
    staticItems.push({ label: c.label, description: c.description, detail: c.detail, keyPath: c.path });
  }
  for (const i of await listDirItems(sshDir, cache)) {
    if (!i.keyPath || seen.has(i.keyPath)) continue; // keys only in the static list
    seen.add(i.keyPath);
    staticItems.push(i);
  }
  staticItems.push({ label: `$(file) ${BROWSE_LABEL}`, detail: 'pick any private key file on disk', browse: true });
  if (opts.generate) staticItems.push({ label: '$(add) Generate New Key…', detail: 'ed25519 / rsa / ecdsa — directory, file name, comment, optional passphrase', generate: true });
  if (opts.paste) staticItems.push({ label: '$(clippy) Paste Private Key…', detail: 'paste an existing private key, choose where to save it', paste: true });
  if (opts.skip) staticItems.push({ label: '$(circle-slash) No SSH key (skip)', skip: true });
  if (opts.clear) staticItems.push({ label: '$(trash) Clear the key reference', clear: true });

  const pick = vscode.window.createQuickPick<Item>();
  pick.title = opts.title;
  pick.placeholder = opts.placeHolder;
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;
  pick.items = staticItems;
  pick.activeItems = [staticItems[0]];

  const filterStatic = (q: string): Item[] => {
    const needle = q.toLowerCase();
    return staticItems.filter((i) => `${i.label} ${i.description ?? ''} ${i.detail ?? ''}`.toLowerCase().includes(needle));
  };

  const refresh = (value: string): void => {
    if (value === '') {
      pick.items = staticItems;
    } else if (pathLike(value)) {
      pick.busy = true;
      void pathCompletions(value, cache).then((rows) => {
        pick.items = rows.length > 0 ? rows : [{ label: `$(error) no matches in ${expandTilde(value)}` }];
        pick.busy = false;
      });
    } else {
      pick.items = filterStatic(value);
    }
  };
  pick.onDidChangeValue(refresh);

  return new Promise<KeyFilePick | undefined>((resolve) => {
    const finish = (r: KeyFilePick | undefined): void => {
      pick.hide();
      resolve(r);
    };
    pick.onDidAccept(async () => {
      const item = pick.activeItems[0];
      if (item?.dirPath) {
        pick.value = `${item.dirPath}/`; // drills in (onDidChangeValue refreshes)
        return;
      }
      if (item?.browse) {
        const pickedFile = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: opts.openLabel ?? 'Use this key',
          title: 'Pick an SSH private key file',
          defaultUri: vscode.Uri.file(existsSync(sshDir) ? sshDir : homedir()),
        });
        const path = pickedFile?.[0]?.fsPath;
        if (!path) return; // dialog cancelled — back to the picker
        finish((await isPrivateKeyFile(path)) ? { kind: 'path', path } : warnNotAKey());
        return;
      }
      if (item?.generate) return finish({ kind: 'generate' });
      if (item?.paste) return finish({ kind: 'paste' });
      if (item?.skip) return finish({ kind: 'skip' });
      if (item?.clear) return finish({ kind: 'clear' });
      if (item?.keyPath) {
        if (item.unverified && !(await isPrivateKeyFile(item.keyPath))) {
          void warnNotAKey();
          return;
        }
        return finish({ kind: 'path', path: item.keyPath });
      }
      // no active item — the typed value itself, when it names a file
      const typed = expandTilde(pick.value.trim());
      if (typed !== '' && existsSync(typed)) {
        finish((await isPrivateKeyFile(typed)) ? { kind: 'path', path: typed } : warnNotAKey());
      }
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
}

function warnNotAKey(): undefined {
  vscode.window.showWarningMessage('Git Colabor: that file does not look like a private key (no PRIVATE KEY header).');
  return undefined;
}
