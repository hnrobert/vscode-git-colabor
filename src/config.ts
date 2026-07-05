import * as vscode from 'vscode';

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
