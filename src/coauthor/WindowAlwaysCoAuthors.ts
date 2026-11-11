import type * as vscode from 'vscode';
import type { CliClient } from '../cli/CliClient.js';
import type { GitApi } from '../git-ext/GitApi.js';

/**
 * WINDOW-scoped always-co-authors: the window remembers its
 * pinned authors (workspaceState) and keeps EVERY open repo's local
 * `colabor.selected` in sync — switching repos in the window keeps the
 * trailers coming, and a repo opened later is caught up on the next refresh.
 * The status/tree read the CURRENT repo's selection, so the sync makes the
 * "· always" marker and the Stop menu consistent everywhere in the window.
 */

type PinnedAuthor = { name: string; email: string };

const KEY = 'windowAlwaysCoAuthors';

export class WindowAlwaysCoAuthors {
  constructor(private readonly store: vscode.Memento, private readonly log: { info(m: string): void; warn(m: string): void }) {}

  private list(): PinnedAuthor[] {
    return this.store.get<PinnedAuthor[]>(KEY, []);
  }

  private async save(list: PinnedAuthor[]): Promise<void> {
    await this.store.update(KEY, list);
  }

  isPinned(email: string): boolean {
    return this.list().some((a) => a.email.toLowerCase() === email.toLowerCase());
  }

  /** Pin/unpin + sync every open repo's selection through the CLI. */
  async toggle(cli: CliClient, git: GitApi, author: PinnedAuthor, pin: boolean): Promise<void> {
    let list = this.list();
    if (pin) {
      if (!list.some((a) => a.email.toLowerCase() === author.email.toLowerCase())) list = [...list, author];
    } else {
      list = list.filter((a) => a.email.toLowerCase() !== author.email.toLowerCase());
    }
    await this.save(list);
    if (!pin) {
      await this.removeFromAll(cli, git, author.email);
    }
    await this.sync(cli, git); // pin: catch every repo up in one pass
    this.log.info(`window always co-authors: ${list.map((a) => a.email).join(', ') || '(none)'}`);
  }

  /**
   * Catch-up ONLY: bring the window set into every open repo's local
   * selection. Repo-local pins made out-of-band (terminal CLI in one repo)
   * are NOT the window's business and are left alone — unpinning goes
   * through toggle(), which removes from every repo explicitly.
   */
  async sync(cli: CliClient, git: GitApi): Promise<void> {
    const pinned = this.list();
    if (pinned.length === 0) return;
    for (const root of git.repoRoots) {
      try {
        const statusRes = await cli.run(['identity', 'status'], { cwd: root });
        if (!statusRes.ok) continue;
        const selected: { name: string; email: string }[] =
          (statusRes.data as { selected?: { name: string; email: string }[] }).selected ?? [];
        const has = new Set(selected.map((a) => a.email.toLowerCase()));
        for (const a of pinned) {
          if (has.has(a.email.toLowerCase())) continue;
          await cli.run(['coauthor', 'add', a.email, '--always'], { cwd: root }); // newly opened repo — catch up
        }
      } catch {
        // best-effort per repo
      }
    }
  }

  /** Unpin removes from EVERY open repo (the window set is the source of truth). */
  private async removeFromAll(cli: CliClient, git: GitApi, email: string): Promise<void> {
    for (const root of git.repoRoots) {
      await cli.run(['coauthor', 'rm', email], { cwd: root }).catch(() => {});
    }
  }
}
