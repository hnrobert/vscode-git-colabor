import * as vscode from 'vscode';
import { ColaborItem } from './items.js';
import { pickRepository } from '../scm/Sync.js';
import { parseCoAuthors } from '../scm/trailers.js';
import { coAuthorMemoryScopeMap } from '../config.js';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';
import type { StatusIdentityJson, StatusJson } from '../types.js';

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
  /** repo root already auto-imported for (identity import is idempotent, run once per repo) */
  private importedRoot: string | undefined;
  /** fired after each reload with the latest status (for status bar / SCM sync) */
  readonly onDidReload = new vscode.EventEmitter<StatusJson | undefined>();
  /** most recent status (for the status bar) */
  get current(): StatusJson | undefined {
    return this.status;
  }

  constructor(private readonly cli: CliClient, private readonly git: GitApi) {}

  /** Re-fetch `identity status` + repo committers (in parallel) and paint once. */
  async reload(): Promise<StatusJson | undefined> {
    const root = this.git.selectedRepoRoot();
    const [statusRes, suggRes] = await Promise.all([
      this.cli.run(['identity', 'status'], { cwd: root }),
      root
        ? this.cli.run(['coauthor', 'suggest', '--json'], { cwd: root }).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    this.status = statusRes.ok ? (statusRes.data as StatusJson) : undefined;
    // always set (never leave stale data from a previous repo)
    this.historyCandidates = suggRes?.ok
      ? ((suggRes.data as { candidates?: Candidate[] }).candidates ?? []).map((a) => ({
          name: a.name,
          email: a.email,
        }))
      : [];
    // single paint with complete, correct data for the CURRENT repo
    this._onDidChange.fire(undefined);
    this.onDidReload.fire(this.status);

    // auto-import committers (once per repo, background, idempotent)
    if (root && this.status?.inRepo && root !== this.importedRoot) {
      this.importedRoot = root;
      void this.cli
        .run(['identity', 'import', '--json'], { cwd: root })
        .then((r) => {
          const added = r.ok ? ((r.data as { added?: unknown[] }).added ?? []) : [];
          if (added.length > 0) void this.reload();
        })
        .catch(() => {});
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
      new ColaborItem('Identity', 'identities-group', {
        collapsible: vscode.TreeItemCollapsibleState.Expanded,
        // count matches what the list actually shows (filtered), not the
        // raw identity map size — prevents "10" in the title vs "1" below
        description: String(this.filterByPriority(s.identities).length),
        icon: 'person',
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

  /**
   * Priority dedup: user > machine > project. A lower-priority identity is
   * suppressed when a higher-priority one matches on name + key + remote
   * (email when no key/remote). The active identity always shows.
   * Project-scope identities only show when their email appears in the
   * current repo's committer history (historyCandidates, re-scanned on every
   * reload). To make one visible everywhere, right-click → "Remember on Machine".
   */
  private filterByPriority(identities: StatusIdentityJson[]): StatusIdentityJson[] {
    const rank = (s?: string) => (s === 'user' ? 0 : s === 'machine' ? 1 : 2);
    const repoEmails = new Set(this.historyCandidates.map((c) => c.email.toLowerCase()));
    const inRepo = !!this.status?.inRepo;
    const sorted = [...identities].sort((a, b) => rank(a.scope) - rank(b.scope));
    const seen = new Set<string>();
    const out: StatusIdentityJson[] = [];
    for (const id of sorted) {
      if (id.active) {
        out.push(id);
        continue;
      }
      // project-scope: strictly filtered to the current repo's committers
      // (suggest runs synchronously with status, so this is always accurate)
      const isProject = (id.scope ?? (id.imported ? 'project' : 'machine')) === 'project';
      if (isProject && inRepo && !repoEmails.has(id.email.toLowerCase())) continue;
      const key = id.sshKeyPath ? `${id.name}|${id.sshKeyPath}|${id.host ?? ''}` : `${id.email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
    return out.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return rank(a.scope) - rank(b.scope);
    });
  }

  /**
   * Identity rows filtered by the priority display rule:
   *   user (vscode config) > machine (identities.json) > project (repo scan)
   * A lower-priority identity is HIDDEN when a higher-priority one has the
   * same name + key + remote. Identities with no key and no remote match by
   * email. The active identity always shows regardless of scope.
   */
  private identityItems(): ColaborItem[] {
    const s = this.status!;
    const memoryMap = coAuthorMemoryScopeMap(s.identities.map((i) => i.email));
    const visible = this.filterByPriority(s.identities);
    return visible.map((i) => {
      const signingWithThisKey =
        !!s.signing?.enabled && !!s.signing.key && s.signing.key === (i as { sshKeyPath?: string }).sshKeyPath;
      const icon = i.active ? (signingWithThisKey ? 'verified' : 'check') : 'account';
      // source label reflects where this identity was found
      const saved = memoryMap.get(i.email.toLowerCase()) ?? { user: false, workspace: false };
      const sourceLabel =
        i.scope === 'user' || saved.user
          ? 'found in user memory'
          : i.scope === 'machine' || (!i.scope && !i.imported)
            ? 'found in machine memory'
            : 'found in repo';
      const item = new ColaborItem(i.name, i.active ? 'active-identity' : 'identity', {
        description: `${i.email} · ${sourceLabel}${i.isDefault ? ' · default' : ''}${i.disabled ? ' · disabled' : ''}`,
        tooltip: `${i.name} <${i.email}>${i.sshKeyFingerprint ? `\n${i.sshKeyFingerprint}` : ''}${i.active ? '\n(active)' : ''}${signingWithThisKey ? '\n(signing commits)' : ''}\n(${sourceLabel})${i.disabled ? '\n(disabled — click to retry with a passphrase)' : ''}`,
        icon,
        iconColor: i.hasKey ? 'gitDecoration.addedResourceForeground' : undefined,
        payload: { id: i.id, name: i.name, email: i.email },
      });
      // contextValue bits drive the right-click menus: -ru/-rm = remembered
      // on user/machine, -g = imported from repo history, -k = usable key,
      // -s = repo signs with THIS key (reuses `saved` from the source label)
      const isUserScope = i.scope === 'user' || saved.user;
      const isMachineScope = i.scope === 'machine' || (!i.scope && !i.imported);
      item.contextValue =
        item.kind +
        (isUserScope ? '-ru' : '') +
        (isMachineScope ? '-rm' : '') +
        (i.imported ? '-g' : '') +
        (i.hasKey ? '-k' : '') +
        (signingWithThisKey ? '-s' : '');
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
  /**
   * Co-author candidates STRICTLY mirror the identity display list (same
   * priority filter, same dedup) minus the currently active identity. No
   * .git-coauthors, no settings memory, no raw history — only what appears
   * in the Identities group can be a co-author.
   */
  private coAuthorCandidates(): Candidate[] {
    const s = this.status;
    if (!s) return [];
    const activeEmail = s.activeIdentity?.email.toLowerCase();
    return this.filterByPriority(s.identities)
      .filter((i) => i.email.toLowerCase() !== activeEmail)
      .map((i) => ({ name: i.name, email: i.email }));
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
        icon: isInMessage ? 'diff-remove' : 'diff-insert',
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
