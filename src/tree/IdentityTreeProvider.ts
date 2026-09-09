import * as vscode from 'vscode';
import { ColaborItem } from './items.js';
import { pickRepository } from '../scm/Sync.js';
import { parseCoAuthors } from '../scm/trailers.js';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import type { StatusJson } from '../types.js';

/**
 * TreeDataProvider for the `gitColabor.identitiesView` SCM view. Renders the active identity,
 * the identity list, and one merged co-author list whose rows show `+`/`-` depending on whether
 * that author's trailer is present in the SCM commit-message input. Clicking a row toggles it.
 */
export class IdentityTreeProvider implements vscode.TreeDataProvider<ColaborItem> {
  private readonly _onDidChange = new vscode.EventEmitter<ColaborItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private status: StatusJson | undefined;
  /** fired after each reload with the latest status (for status bar / SCM sync) */
  readonly onDidReload = new vscode.EventEmitter<StatusJson | undefined>();
  /** most recent status (for the status bar) */
  get current(): StatusJson | undefined {
    return this.status;
  }

  constructor(private readonly cli: CliClient, private readonly git: GitApi) {}

  /** Re-fetch `identity status` and refresh the tree. */
  async reload(): Promise<StatusJson | undefined> {
    const root = this.git.selectedRepoRoot();
    const r = await this.cli.run(['identity', 'status'], { cwd: root });
    this.status = r.ok ? (r.data as StatusJson) : undefined;
    this._onDidChange.fire(undefined);
    this.onDidReload.fire(this.status);
    return this.status;
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: ColaborItem): ColaborItem {
    return element;
  }

  async getChildren(element?: ColaborItem): Promise<ColaborItem[]> {
    if (!this.status) return [];
    if (!element) return this.roots();
    switch (element.kind) {
      case 'identities-group':
        return this.identityItems();
      case 'coauthor-group':
        return this.coAuthorItems();
      default:
        return [];
    }
  }

  private roots(): ColaborItem[] {
    const s = this.status!;
    const items: ColaborItem[] = [];

    if (s.activeIdentity) {
      const a = s.activeIdentity;
      items.push(
        new ColaborItem(`${a.name} <${a.email}>`, 'active-identity', {
          description: a.hasKey ? 'key ✓' : undefined,
          tooltip: `Active identity${a.sshKeyFingerprint ? `\nkey: ${a.sshKeyFingerprint}` : ''}\nmanaged-by: ${s.managedBy ?? '?'}`,
          icon: 'person',
        }),
      );
    } else if (s.inRepo) {
      items.push(
        new ColaborItem('No identity active — pick one below', 'no-identity', { icon: 'warning' }),
      );
    } else {
      items.push(new ColaborItem('Open a git repository to begin', 'no-identity', { icon: 'info' }));
    }

    items.push(
      new ColaborItem('Identities', 'identities-group', {
        collapsible: vscode.TreeItemCollapsibleState.Expanded,
        description: String(s.identities.length),
        icon: 'list-selection',
      }),
    );

    if (s.inRepo) {
      items.push(
        new ColaborItem('Co-authors', 'coauthor-group', {
          collapsible: vscode.TreeItemCollapsibleState.Expanded,
          description: `${this.inputBoxEmails().size}/${s.selected.length + s.available.length} in message`,
          icon: 'organization',
        }),
      );
    }
    return items;
  }

  private identityItems(): ColaborItem[] {
    return this.status!.identities.map((i) => {
      const item = new ColaborItem(`${i.isDefault ? '$(star) ' : ''}${i.name}`, i.active ? 'active-identity' : 'identity', {
        description: `${i.email}${i.hasKey ? ' 🔑' : ''}`,
        tooltip: `${i.name} <${i.email}>${i.sshKeyFingerprint ? `\n${i.sshKeyFingerprint}` : ''}${i.active ? '\n(active)' : ''}`,
        icon: i.active ? 'check' : 'person',
      });
      if (!i.active) {
        item.command = { command: 'gitColabor._useIdentityById', title: 'Use Identity', arguments: [i.id] };
      }
      return item;
    });
  }

  /**
   * One merged co-author list (selected first, then available, deduped by
   * email). Each row's icon is `-` when the author's trailer is present in
   * the SCM commit-message input, `+` otherwise; clicking toggles it.
   */
  private coAuthorItems(): ColaborItem[] {
    const present = this.inputBoxEmails();
    const merged = [...this.status!.selected, ...this.status!.available];
    const seen = new Set<string>();
    const items: ColaborItem[] = [];
    for (const a of merged) {
      const id = a.email.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      const isInMessage = present.has(id);
      const item = new ColaborItem(a.name, 'coauthor-item', {
        description: a.email,
        tooltip: `${a.name} <${a.email}>\nclick to ${isInMessage ? 'remove' : 'append'} in the commit message`,
        icon: isInMessage ? 'dash' : 'plus',
      });
      item.command = {
        command: 'gitColabor._toggleCoAuthor',
        title: isInMessage ? 'Remove co-author' : 'Add co-author',
        arguments: [a.name, a.email],
      };
      items.push(item);
    }
    return items;
  }

  /** Lowercased emails of the co-author trailers currently in the SCM input box. */
  private inputBoxEmails(): Set<string> {
    const value = pickRepository(this.git)?.inputBox.value ?? '';
    return new Set(parseCoAuthors(value).map((a) => a.email.toLowerCase()));
  }
}
