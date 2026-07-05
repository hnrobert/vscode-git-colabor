import * as vscode from 'vscode';
import { ColaborItem } from './items.js';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import type { StatusJson } from '../types.js';

/**
 * TreeDataProvider for the `gitColabor.identitiesView` SCM view. Renders the active identity,
 * the identity list, and the per-repo co-author selection (co-authoring / available). Clicking an
 * identity switches; clicking a co-author adds/removes it.
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
      case 'coauthor-selected':
        return this.selectedItems();
      case 'coauthor-available':
        return this.availableItems();
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
        new ColaborItem('Co-authoring', 'coauthor-selected', {
          collapsible: vscode.TreeItemCollapsibleState.Collapsed,
          description: String(s.selected.length),
          icon: 'people',
        }),
        new ColaborItem('Co-authors', 'coauthor-available', {
          collapsible: vscode.TreeItemCollapsibleState.Collapsed,
          description: String(s.available.length),
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

  private selectedItems(): ColaborItem[] {
    return this.status!.selected.map((a) => {
      const item = new ColaborItem(a.name, 'coauthor-selected-item', { description: a.email, icon: 'person' });
      item.command = { command: 'gitColabor._removeCoAuthor', title: 'Remove co-author', arguments: [a.email] };
      return item;
    });
  }

  private availableItems(): ColaborItem[] {
    return this.status!.available.map((a) => {
      const item = new ColaborItem(a.name, 'coauthor-available-item', { description: a.email, icon: 'person-add' });
      item.command = { command: 'gitColabor._addCoAuthor', title: 'Add co-author', arguments: [a.key] };
      return item;
    });
  }
}
