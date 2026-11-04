import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  expandTilde,
  isPrivateKeyFile,
  listDirRows,
  pathCompletions,
  pathLike,
  type CompletionRow,
  type DirCache,
} from './keyFileCompletions.js';

/**
 * The ONE SSH-private-key picker (auth key, sign key): a custom QuickPick
 * that lists known keys (candidates + a classified ~/.ssh scan), autocompletes
 * a typed filesystem path live (dirs drill down; only directories and
 * private keys are offered, encrypted keys marked), and offers a Browse
 * dialog defaulting to ~/.ssh. Extras (generate / paste / skip / clear) are
 * enabled per caller.
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
  const home = homedir();
  const sshDir = join(home, '.ssh');

  // static list: candidates first (already ranked), then a classified ~/.ssh
  // scan (keys only, with encryption icons), then extras
  const seen = new Set<string>();
  const staticItems: Item[] = [];
  for (const c of opts.candidates ?? []) {
    if (!c.path || seen.has(c.path) || !existsSync(c.path)) continue;
    seen.add(c.path);
    staticItems.push({ label: c.label, description: c.description, detail: c.detail, keyPath: c.path });
  }
  for (const row of await listDirRows(sshDir, cache)) {
    if (!row.keyPath || seen.has(row.keyPath)) continue;
    seen.add(row.keyPath);
    staticItems.push({ label: row.label, description: row.description, detail: row.detail, keyPath: row.keyPath });
  }
  staticItems.push({ label: `$(file) ${BROWSE_LABEL}`, detail: 'pick any private key file on disk', browse: true });
  if (opts.generate) staticItems.push({ label: '$(add) Generate New Key…', detail: 'ed25519 / rsa / ecdsa — directory, file name, comment, optional passphrase', generate: true });
  if (opts.paste) staticItems.push({ label: '$(clippy) Paste Private Key…', detail: 'paste an existing private key, choose where to save it', paste: true });
  if (opts.skip) staticItems.push({ label: '$(circle-slash) No SSH key (skip)', skip: true });
  if (opts.clear) staticItems.push({ label: '$(trash) Clear the key reference', clear: true });

  const pick = vscode.window.createQuickPick<Item>();
  pick.title = opts.title;
  pick.placeholder = opts.placeHolder;
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
      pathCompletions(value, home, cache)
        .then((rows: CompletionRow[]) => {
          if (rows.length > 0) {
            const items = rows.map((r) => ({ ...r, unverified: true }));
            pick.items = items;
            pick.activeItems = [items[0]];
          } else {
            // the typed value must appear in the label — the QuickPick input
            // is FILTER TEXT and hides anything it does not fuzzy-match
            pick.items = [{ label: `$(error) ${value} — no matches` }];
          }
          pick.busy = false;
        })
        .catch((e: unknown) => {
          pick.busy = false;
          vscode.window.showWarningMessage(`Git Colabor: path completion failed: ${e instanceof Error ? e.message : String(e)}`);
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
          defaultUri: vscode.Uri.file(existsSync(sshDir) ? sshDir : home),
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
      const typed = expandTilde(pick.value.trim(), home);
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
