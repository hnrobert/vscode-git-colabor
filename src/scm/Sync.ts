import type { GitApi, GitRepository } from '../git-ext/GitApi.js';
import type { CoAuthorBriefJson } from '../types.js';

/** Idempotently reseed the built-in Git SCM commit-message input with the current co-author trailers. */
export function reseedInput(current: string, selected: CoAuthorBriefJson[]): string {
  const kept = current.split(/\r?\n/).filter((l) => !/^Co-authored-by:/.test(l));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  if (selected.length === 0) return kept.join('\n');
  const trailers = selected.map((a) => `Co-authored-by: ${a.name} <${a.email}>`);
  return [...kept, '', ...trailers].join('\n');
}

export class ScmSync {
  private prevKey = '';

  constructor(private readonly git: GitApi) {}

  /** Reseed the SCM input if the selected set changed since the last call. */
  sync(selected: CoAuthorBriefJson[]): void {
    const repo = this.selectedRepo();
    if (!repo) return;
    const key = selected.map((a) => a.email).sort().join(',');
    if (key === this.prevKey) return; // unchanged — don't clobber a user typing
    this.prevKey = key;
    repo.inputBox.value = reseedInput(repo.inputBox.value, selected);
  }

  private selectedRepo(): GitRepository | undefined {
    const repos = this.git.repositories;
    if (repos.length === 0) return undefined;
    return repos.find((r) => r.ui.selected) ?? repos[0];
  }
}
