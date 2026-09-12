import * as vscode from 'vscode';

export type ItemKind =
  | 'active-identity'
  | 'no-identity'
  | 'identity'
  | 'identities-group'
  | 'coauthor-group'
  | 'coauthor-item';

export type ItemOpts = {
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  collapsible?: vscode.TreeItemCollapsibleState;
  icon?: string;
  /** ThemeColor id (e.g. 'gitDecoration.addedResourceForeground') tinting the icon. */
  iconColor?: string;
  command?: vscode.Command;
  /** Data for context-menu commands (menus pass the TreeItem, not command arguments). */
  payload?: { id?: string; name: string; email: string };
};

/** A TreeItem whose contextValue is the ItemKind (drives the view/item/context menus). */
export class ColaborItem extends vscode.TreeItem {
  readonly kind: ItemKind;
  readonly payload?: { id?: string; name: string; email: string };
  constructor(label: string, kind: ItemKind, opts: ItemOpts = {}) {
    super(label, opts.collapsible ?? vscode.TreeItemCollapsibleState.None);
    this.kind = kind;
    this.contextValue = kind;
    this.description = opts.description;
    this.tooltip = opts.tooltip;
    if (opts.icon) this.iconPath = new vscode.ThemeIcon(opts.icon, opts.iconColor ? new vscode.ThemeColor(opts.iconColor) : undefined);
    this.command = opts.command;
    this.payload = opts.payload;
  }
}
