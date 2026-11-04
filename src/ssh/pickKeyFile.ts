import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  expandTilde,
  isPrivateKeyFile,
  pathCompletions,
  type CompletionRow,
  type DirCache,
} from './keyFileCompletions.js';

/**
 * The ONE SSH-private-key picker (auth key, sign key) — a path browser
 * rooted at ~/.ssh. The input is PREFILLED with the absolute `~/.ssh/` path
 * (absolute-path completion from the first keystroke, no tilde ambiguity)
 * and lists that directory: folders first, then classified private keys
 * (encrypted ones locked). Typing narrows by path prefix (labels complete
 * the typed text — the QuickPick input is filter text and hides anything
 * else); a bare word searches the default listing through the platform's
 * own fuzzy filter. Candidates (e.g. the identity's own keys) pin to the
 * top and the extras (Browse / Generate / Paste / Skip / Clear) pin to the
 * bottom of EVERY listing — `alwaysShow` keeps them above the filter.
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

/**
 * Pick an SSH private key. Returns undefined when cancelled; a `path` result
 * is always a content-checked private key (candidate rows count as checked).
 */
export async function pickKeyFile(opts: {
  title: string;
  placeHolder: string;
  /** pre-ranked known keys pinned to the top (e.g. the identity's own) */
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
  const initial = `${sshDir}/`;

  // pinned top: candidates (already ranked)
  const seen = new Set<string>();
  const pinned: Item[] = [];
  for (const c of opts.candidates ?? []) {
    if (!c.path || seen.has(c.path) || !existsSync(c.path)) continue;
    seen.add(c.path);
    pinned.push({ label: c.label, description: c.description, detail: c.detail, keyPath: c.path, alwaysShow: true });
  }
  // pinned bottom: the extras, present in EVERY listing
  const extras: Item[] = [{ label: '$(file) Browse for a key file…', detail: 'pick any private key file on disk', browse: true, alwaysShow: true }];
  if (opts.generate) extras.push({ label: '$(add) Generate New Key…', detail: 'ed25519 / rsa / ecdsa — directory, file name, comment, optional passphrase', generate: true, alwaysShow: true });
  if (opts.paste) extras.push({ label: '$(clippy) Paste Private Key…', detail: 'paste an existing private key, choose where to save it', paste: true, alwaysShow: true });
  if (opts.skip) extras.push({ label: '$(circle-slash) No SSH key (skip)', skip: true, alwaysShow: true });
  if (opts.clear) extras.push({ label: '$(trash) Clear the key reference', clear: true, alwaysShow: true });

  const pick = vscode.window.createQuickPick<Item>();
  pick.title = opts.title;
  pick.placeholder = opts.placeHolder;
  pick.value = initial; // absolute ~/.ssh — path completion from the first keystroke

  const refresh = (value: string): void => {
    pick.busy = true;
    pathCompletions(value, home, cache, sshDir)
      .then((rows: CompletionRow[]) => {
        const items = [
          ...pinned,
          ...rows.map((r) => ({ ...r, unverified: true })),
          ...(rows.length > 0
            ? extras
            : [{ label: `$(error) ${value} — no matches` } as Item, ...extras]),
        ];
        pick.items = items;
        pick.activeItems = [rows.length > 0 ? items[pinned.length] : items[items.length - 1]];
        pick.busy = false;
      })
      .catch((e: unknown) => {
        pick.busy = false;
        vscode.window.showWarningMessage(`Git Colabor: path completion failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  };
  pick.onDidChangeValue(refresh);
  refresh(initial);

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
