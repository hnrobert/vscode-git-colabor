import * as vscode from 'vscode';
import { generateKeyWizard, pasteKeyWizard } from '../ssh/keyWizard.js';
import { pickKeyFile } from '../ssh/pickKeyFile.js';
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
  /** window-scoped always-co-authors (git-mob style, every repo in this window) */
  windowAlways: import('../coauthor/WindowAlwaysCoAuthors.js').WindowAlwaysCoAuthors;
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

/**
 * Pick the SSH private key for an identity — the shared key picker
 * (pickKeyFile): a path browser rooted at ~/.ssh (autocomplete, Browse,
 * Generate/Paste wizards). "No SSH key" returns `null` when `allowClear`
 * (remove the reference) or `undefined` (just no key); Esc skips untouched.
 * A generated passphrase is banked straight into the session store via
 * `deps`, when given.
 */
export async function pickPrivateKey(allowClear = false, deps?: CommandDeps): Promise<string | null | undefined> {
  const pick = await pickKeyFile({
    title: 'SSH private key',
    placeHolder: 'Pick a key, type a path (autocompletes), or browse ~/.ssh — Esc to skip',
    generate: true,
    paste: true,
    skip: true,
    openLabel: 'Use this key',
  });
  if (!pick) return undefined;
  switch (pick.kind) {
    case 'skip':
      return allowClear ? null : undefined;
    case 'path':
      return pick.path;
    case 'generate': {
      const generated = await generateKeyWizard();
      if (!generated) return undefined;
      if (generated.encrypted && generated.passphrase && deps) {
        deps.sessionPassphrases.set(generated.fingerprint, generated.passphrase);
        deps.log.info(`passphrase for generated key ${generated.fingerprint} banked (session only)`);
      }
      return generated.path;
    }
    case 'paste':
      return (await pasteKeyWizard())?.path;
  }
}
