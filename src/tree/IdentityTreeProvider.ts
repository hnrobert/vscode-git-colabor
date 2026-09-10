import * as vscode from 'vscode';
import { ColaborItem } from './items.js';
import { pickRepository } from '../scm/Sync.js';
import { parseCoAuthors } from '../scm/trailers.js';
import { coAuthorMemories, coAuthorMemoryScopeMap } from '../config.js';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import type { StatusJson } from '../types.js';

type Candidate = { name: string; email: string };

/**
 * TreeDataProvider for the `gitColabor.identitiesView` SCM view. Renders the active identity,
 * the identity list, and one merged co-author list whose rows show `+`/`-` depending on whether
 * that author's trailer is present in the SCM commit-message input. Clicking a row toggles it.
 * Candidates merge the `.git-coauthors` catalogue, remembered co-authors
 * (user/machine/workspace settings), and the repo's historical commit authors.
 */
export class IdentityTreeProvider implements vscode.TreeDataProvider<ColaborItem> {
  private readonly _onDidChange = new vscode.EventEmitter<ColaborItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private status: StatusJson | undefined;
  /** authors found in the repo's commit history (`coauthor suggest`) */
  private historyCandidates: Candidate[] = [];
  /** guards stale `coauthor suggest` responses from overwriting newer reloads */
  private suggestGen = 0;
  /** repo root already auto-imported for (identity import is idempotent, run once per repo) */
  private importedRoot: string | undefined;
  /** fired after each reload with the latest status (for status bar / SCM sync) */
  readonly onDidReload = new vscode.EventEmitter<StatusJson | undefined>();
  /** most recent status (for the status bar) */
  get current(): StatusJson | undefined {
    return this.status;
  }

  constructor(private readonly cli: CliClient, private readonly git: GitApi) {}

  /** Re-fetch `identity status` and refresh the tree; history authors load in the background. */
  async reload(): Promise<StatusJson | undefined> {
    const root = this.git.selectedRepoRoot();
    const r = await this.cli.run(['identity', 'status'], { cwd: root });
    this.status = r.ok ? (r.data as StatusJson) : undefined;
    this.historyCandidates = [];
    // paint the tree as soon as status is in — `coauthor suggest` runs
    // `git shortlog` over the whole history and used to block first render
    this._onDidChange.fire(undefined);
    this.onDidReload.fire(this.status);
    const gen = ++this.suggestGen;
    if (root && this.status?.inRepo) {
      void this.cli
        .run(['coauthor', 'suggest', '--json'], { cwd: root })
        .then((sugg) => {
          if (gen !== this.suggestGen) return; // a newer reload superseded us
          this.historyCandidates = ((sugg.data as { candidates?: Candidate[] }).candidates ?? []).map((a) => ({
            name: a.name,
            email: a.email,
          }));
          this._onDidChange.fire(undefined); // second paint with history authors
        })
        .catch(() => {});

      // Auto-import every distinct committer from the repo history as a
      // key-less identity (once per repo — import is idempotent anyway).
      // Runs after the first paint; a second reload surfaces new identities.
      if (root !== this.importedRoot) {
        this.importedRoot = root;
        void this.cli
          .run(['identity', 'import', '--json'], { cwd: root })
          .then((r) => {
            const added = r.ok ? ((r.data as { added?: unknown[] }).added ?? []) : [];
            if (added.length > 0) void this.reload(); // same root now — no re-import loop
          })
          .catch(() => {});
      }
    }
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

    items.push(
      new ColaborItem('Identities', 'identities-group', {
        collapsible: vscode.TreeItemCollapsibleState.Expanded,
        description: String(s.identities.length),
        icon: 'list-selection',
      }),
    );

    // guidance rows sit BELOW the Identities group; the active identity is
    // marked ✓ inside it, never duplicated at the top.
    if (!s.inRepo) {
      items.push(new ColaborItem('Open a git repository to begin', 'no-identity', { icon: 'info' }));
    } else if (!s.activeIdentity) {
      items.push(new ColaborItem('No identity active — pick one above', 'no-identity', { icon: 'warning' }));
    }

    if (s.inRepo) {
      items.push(
        new ColaborItem('Co-authors', 'coauthor-group', {
          collapsible: vscode.TreeItemCollapsibleState.Expanded,
          description: `${this.inputBoxEmails().size}/${this.coAuthorCandidates().length} in message`,
          icon: 'organization',
        }),
      );
    }
    return items;
  }

  private identityItems(): ColaborItem[] {
    const s = this.status!;
    const memoryMap = coAuthorMemoryScopeMap(s.identities.map((i) => i.email));
    return s.identities.map((i) => {
      const item = new ColaborItem(`${i.isDefault ? '$(star) ' : ''}${i.name}`, i.active ? 'active-identity' : 'identity', {
        description: `${i.email}${i.hasKey ? ' 🔑' : ''}`,
        tooltip: `${i.name} <${i.email}>${i.sshKeyFingerprint ? `\n${i.sshKeyFingerprint}` : ''}${i.active ? '\n(active)' : ''}`,
        icon: i.active ? 'check' : 'person',
        payload: { id: i.id, name: i.name, email: i.email },
      });
      // memory bits drive the right-click save/remove-as-co-author menu items
      const saved = memoryMap.get(i.email.toLowerCase()) ?? { user: false, machine: false, workspace: false };
      item.contextValue =
        item.kind + (saved.user ? '-u' : '') + (saved.machine ? '-m' : '') + (saved.workspace ? '-w' : '');
      if (!i.active) {
        item.command = { command: 'gitColabor._useIdentityById', title: 'Use Identity', arguments: [i.id] };
      }
      return item;
    });
  }

  /**
   * Merged, email-deduped co-author candidates, ordered by proximity:
   * current selection → `.git-coauthors` catalogue → all known identities
   * (minus the currently-active one — you don't co-author yourself) →
   * remembered co-authors (all settings layers) → repo commit history.
   */
  private coAuthorCandidates(): Candidate[] {
    const s = this.status;
    if (!s) return [];
    const seen = new Set<string>();
    const merged: Candidate[] = [];
    const push = (name: string, email: string): void => {
      const id = email.toLowerCase();
      if (seen.has(id)) return;
      seen.add(id);
      merged.push({ name, email });
    };
    const activeEmail = s.activeIdentity?.email.toLowerCase();
    for (const a of s.selected) push(a.name, a.email);
    for (const a of s.available) push(a.name, a.email);
    for (const i of s.identities) {
      if (i.email.toLowerCase() === activeEmail) continue;
      push(i.name, i.email);
    }
    for (const a of coAuthorMemories()) push(a.name, a.email);
    for (const a of this.historyCandidates) push(a.name, a.email);
    return merged;
  }

  /**
   * One merged co-author list. Each row's icon is `-` when the author's
   * trailer is present in the SCM commit-message input, `+` otherwise;
   * clicking toggles it. The contextValue carries which memory scopes
   * (user/machine/workspace) remember the author, driving the right-click
   * save/remove menu items.
   */
  private coAuthorItems(): ColaborItem[] {
    const candidates = this.coAuthorCandidates();
    if (candidates.length === 0) {
      return [
        new ColaborItem('No co-authors found — add them to .git-coauthors, save memories, or commit with others', 'no-identity', {
          icon: 'info',
        }),
      ];
    }
    const present = this.inputBoxEmails();
    const items: ColaborItem[] = [];
    for (const a of candidates) {
      const id = a.email.toLowerCase();
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
