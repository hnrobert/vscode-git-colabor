import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanPrivateKeys } from '../ssh/scanPrivateKeys.js';
import { generateKeyWizard, pasteKeyWizard } from '../ssh/keyWizard.js';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import type { SessionIdentityController } from '../session/SessionIdentity.js';
import type { IdentityTreeProvider } from '../tree/IdentityTreeProvider.js';
import type { IdentityJson, JsonResult } from '../types.js';

export type CommandDeps = {
  cli: CliClient;
  git: GitApi;
  /** per-window identity controller (env-injected, never writes repo config) */
  session: SessionIdentityController;
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

type KeyPickItem = vscode.QuickPickItem & { path?: string; skip?: boolean; clear?: boolean; generate?: boolean; paste?: boolean };

/**
 * Pick the SSH private key for an identity: prefills the expanded `~/.ssh/`
 * path and offers the private key files actually found there
 * (content-scanned); any other path can be typed instead, Esc skips.
 * With `allowClear`, an extra entry returns `null` meaning "remove the key".
 * Two wizard entries create a key on the fly: "Generate New Key…" (type /
 * directory / file name / comment / optional passphrase) and "Paste Private
 * Key…" (multi-line paste via an untitled document). A generated passphrase
 * is banked straight into the session store via `deps`, when given.
 */
export async function pickPrivateKey(allowClear = false, deps?: CommandDeps): Promise<string | null | undefined> {
  const dir = join(homedir(), '.ssh');
  const picked = await new Promise<{ item?: KeyPickItem; typed: string }>((resolve) => {
    const pick = vscode.window.createQuickPick<KeyPickItem>();
    pick.title = 'SSH private key';
    pick.placeholder = 'Pick a key from ~/.ssh, type a path, generate or paste one — Esc to skip';
    // NOTE: no programmatic pick.value prefill — a prefilled value acts as a
    // filter (with matchOn*) and hides every item, showing an empty list
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    let typed = '';
    pick.onDidChangeValue((v) => (typed = v));
    void scanPrivateKeys(dir)
      .catch(() => [])
      .then((keys) => {
        const items: KeyPickItem[] = [
          ...keys.map((k) => ({ label: `$(key) ${k.name}`, description: k.path, detail: k.kind, path: k.path })),
          { label: '$(add) Generate New Key…', detail: 'ed25519 / rsa / ecdsa — directory, file name, comment, optional passphrase', generate: true },
          { label: '$(clippy) Paste Private Key…', detail: 'paste an existing private key, choose where to save it', paste: true },
          { label: '$(circle-slash) No SSH key (skip)', skip: true },
        ];
        if (allowClear) items.push({ label: '$(trash) Clear the key reference', clear: true });
        pick.items = items;
        // first scanned key, or Generate when ~/.ssh has none
        pick.activeItems = [items[0]];
      });
    pick.onDidAccept(() => {
      resolve({ item: pick.activeItems[0], typed });
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve({ item: undefined, typed });
      pick.dispose();
    });
    pick.show();
  });

  const { item, typed } = picked;
  if (!item) {
    // no active item — a typed path still counts
    const t = typed.trim();
    return t !== '' && !t.endsWith('/') ? t : undefined;
  }
  if (item.skip) return undefined;
  if (item.clear) return null;
  if (item.path) return item.path;
  if (item.generate) {
    const generated = await generateKeyWizard();
    if (!generated) return undefined;
    if (generated.encrypted && generated.passphrase && deps) {
      deps.sessionPassphrases.set(generated.fingerprint, generated.passphrase);
      deps.log.info(`passphrase for generated key ${generated.fingerprint} banked (session only)`);
    }
    return generated.path;
  }
  if (item.paste) {
    const pasted = await pasteKeyWizard();
    return pasted?.path;
  }
  return undefined;
}
