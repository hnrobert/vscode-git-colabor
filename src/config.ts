import * as vscode from 'vscode';
import { parseAuthorString, type ParsedAuthor } from './scm/trailers.js';

export function cliPath(context: vscode.ExtensionContext): string {
  const override = vscode.workspace.getConfiguration('gitColabor').get<string>('cliPath');
  return override && override.trim().length > 0 ? override : context.asAbsolutePath('resources/cli.cjs');
}

/** Effective `gitColabor.user.name` if explicitly set in any layer, else undefined. */
export function effectiveUserName(): string | undefined {
  return effectiveValue('gitColabor.user', 'name');
}
export function effectiveUserEmail(): string | undefined {
  return effectiveValue('gitColabor.user', 'email');
}

function effectiveValue(section: string, key: string): string | undefined {
  const inspect = vscode.workspace.getConfiguration(section).inspect<string>(key);
  const v = inspect?.workspaceFolderValue ?? inspect?.workspaceValue ?? inspect?.globalValue;
  return v && v.trim().length > 0 ? v : undefined;
}

export function getString(section: string, key: string): string | undefined {
  const v = vscode.workspace.getConfiguration(section).get<string>(key);
  return v && v.trim().length > 0 ? v : undefined;
}

export function getBool(key: string, fallback = false): boolean {
  return vscode.workspace.getConfiguration('gitColabor').get<boolean>(key) ?? fallback;
}

export function getNumber(key: string, fallback: number): number {
  return vscode.workspace.getConfiguration('gitColabor').get<number>(key) ?? fallback;
}

export function defaultIdentity(): string | undefined {
  return getString('gitColabor', 'defaultIdentity');
}
export function autoApplyOnRepoOpen(): boolean {
  return getBool('autoApplyOnRepoOpen', true);
}
export function conflictWarningStaleMinutes(): number {
  return getNumber('conflictWarningStaleMinutes', 5);
}

// --- remembered co-authors (gitColabor.coAuthorIdentities, "Name <email>" entries) ---
// The setting is machineOverridable, so it can live in three layers at once:
// user (global), machine (per host — the remote under Remote-SSH), workspace.

export type MemoryScope = 'user' | 'machine' | 'workspace';

type CoAuthorsInspection = {
  globalValue?: unknown;
  machineValue?: unknown; // only present on newer VS Code
  workspaceValue?: unknown;
};

const asAuthorList = (v: unknown): ParsedAuthor[] =>
  Array.isArray(v)
    ? v.flatMap((e) => {
        const a = parseAuthorString(String(e));
        return a ? [a] : [];
      })
    : [];

/** All three memory layers from ONE configuration inspect (cheap enough per render). */
export function coAuthorMemoriesByScope(): Record<MemoryScope, ParsedAuthor[]> {
  const inspect = vscode.workspace.getConfiguration('gitColabor').inspect('coAuthorIdentities') as
    | CoAuthorsInspection
    | undefined;
  return {
    user: asAuthorList(inspect?.globalValue),
    machine: asAuthorList(inspect?.machineValue),
    workspace: asAuthorList(inspect?.workspaceValue),
  };
}

/** Deduped union of all three memory layers (feeds the Co-authors list). */
export function coAuthorMemories(): ParsedAuthor[] {
  const seen = new Set<string>();
  const out: ParsedAuthor[] = [];
  for (const scope of ['user', 'machine', 'workspace'] as const) {
    for (const a of coAuthorMemoriesByScope()[scope]) {
      const id = a.email.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(a);
    }
  }
  return out;
}

/**
 * Which scopes remember each email — computed with a single inspect for the
 * whole batch (per-item inspect calls made large co-author lists visibly
 * slow to render).
 */
export function coAuthorMemoryScopeMap(emails: string[]): Map<string, Record<MemoryScope, boolean>> {
  const byScope = coAuthorMemoriesByScope();
  const sets: Record<MemoryScope, Set<string>> = { user: new Set(), machine: new Set(), workspace: new Set() };
  for (const scope of ['user', 'machine', 'workspace'] as const) {
    for (const a of byScope[scope]) sets[scope].add(a.email.toLowerCase());
  }
  const map = new Map<string, Record<MemoryScope, boolean>>();
  for (const e of emails) {
    const id = e.toLowerCase();
    map.set(id, { user: sets.user.has(id), machine: sets.machine.has(id), workspace: sets.workspace.has(id) });
  }
  return map;
}

function memoryTarget(scope: MemoryScope): vscode.ConfigurationTarget | undefined {
  if (scope === 'user') return vscode.ConfigurationTarget.Global;
  if (scope === 'workspace') return vscode.ConfigurationTarget.Workspace;
  // ConfigurationTarget.Machine arrived after VS Code 1.83 — detect at runtime.
  return (vscode.ConfigurationTarget as { Machine?: vscode.ConfigurationTarget }).Machine;
}

/** Save or remove an author in one memory scope. Returns false when the scope is unsupported. */
export async function setCoAuthorMemory(scope: MemoryScope, author: ParsedAuthor, save: boolean): Promise<boolean> {
  const target = memoryTarget(scope);
  if (target === undefined) return false;
  const e = author.email.toLowerCase();
  const list = coAuthorMemoriesByScope()[scope].filter((a) => a.email.toLowerCase() !== e);
  if (save) list.push(author);
  await vscode.workspace
    .getConfiguration('gitColabor')
    .update('coAuthorIdentities', list.map((a) => `${a.name} <${a.email}>`), target);
  return true;
}
