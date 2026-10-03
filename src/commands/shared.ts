import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanPrivateKeys } from '../ssh/scanPrivateKeys.js';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import type { IdentityTreeProvider } from '../tree/IdentityTreeProvider.js';
import type { IdentityJson, JsonResult } from '../types.js';

export type CommandDeps = {
  cli: CliClient;
  git: GitApi;
  log: vscode.LogOutputChannel;
  provider?: IdentityTreeProvider;
  /** session-scoped key passphrases (fingerprint → passphrase); in-memory only */
  sessionPassphrases: Map<string, string>;
};

/**
 * Identity id from a tree-row invocation (context menus / inline buttons pass
 * the TreeItem); undefined when invoked from the palette or view title — the
 * caller should fall back to a quick pick then.
 */
export function rowIdentityId(item: unknown): string | undefined {
  return (item as { payload?: { id?: string } } | undefined)?.payload?.id;
}

export function requireRepo(deps: CommandDeps): string | undefined {
  const root = deps.git.selectedRepoRoot();
  if (!root) {
    vscode.window.showWarningMessage('Git Colabor: no git repository in the current workspace.');
    return undefined;
  }
  return root;
}

export function reportError(r: Extract<JsonResult, { ok: false }>): void {
  const hints = r.error.hints && r.error.hints.length > 0 ? `\n${r.error.hints.join('\n')}` : '';
  vscode.window.showErrorMessage(`Git Colabor: ${r.error.message}${hints}`);
}

export async function run<T = unknown>(deps: CommandDeps, args: string[], opts: { cwd?: string } = {}): Promise<T | undefined> {
  const r = await deps.cli.run(args, opts);
  if (!r.ok) {
    reportError(r);
    return undefined;
  }
  return r.data as T;
}

export async function pickIdentity(deps: CommandDeps, placeholder: string): Promise<IdentityJson | undefined> {
  const data = await run<{ identities: IdentityJson[] }>(deps, ['identity', 'ls']);
  if (!data) return undefined;
  if (data.identities.length === 0) {
    vscode.window.showInformationMessage('Git Colabor: no identities yet. Use "Add Identity…".');
    return undefined;
  }
  const items = data.identities.map((i) => ({
    label: `${i.isDefault ? '$(star) ' : ''}${i.name}`,
    description: i.email,
    detail: i.hasKey ? `key ${i.sshKeyFingerprint}` : 'no SSH key',
    identity: i,
  }));
  const sel = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
  return sel?.identity;
}

type KeyPickItem = vscode.QuickPickItem & { path?: string; skip?: boolean; clear?: boolean };

/**
 * Pick the SSH private key for an identity: prefills the expanded `~/.ssh/`
 * path and offers the private key files actually found there
 * (content-scanned); any other path can be typed instead, Esc skips.
 * With `allowClear`, an extra entry returns `null` meaning "remove the key".
 */
export function pickPrivateKey(allowClear = false): Promise<string | null | undefined> {
  const dir = join(homedir(), '.ssh');
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<KeyPickItem>();
    pick.title = 'SSH private key';
    pick.placeholder = 'Pick a key from ~/.ssh, type another path, or Esc to skip';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    void scanPrivateKeys(dir).then((keys) => {
      const items: KeyPickItem[] = [
        ...keys.map((k) => ({ label: `$(key) ${k.name}`, description: k.path, detail: k.kind, path: k.path })),
        { label: '$(circle-slash) No SSH key (skip)', skip: true },
      ];
      if (allowClear) items.push({ label: '$(trash) Clear the key reference', clear: true });
      pick.items = items;
      pick.activeItems = keys.length > 0 ? [items[0]] : [items[items.length - 1]];
    });
    pick.value = `${dir}/`;
    pick.onDidAccept(() => {
      const active = pick.activeItems[0];
      if (active?.skip) resolve(undefined);
      else if (active?.clear) resolve(null);
      else if (active?.path) resolve(active.path);
      else {
        const typed = pick.value.trim();
        resolve(typed !== '' && !typed.endsWith('/') ? typed : undefined);
      }
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
}
