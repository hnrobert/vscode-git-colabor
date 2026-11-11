import * as vscode from 'vscode';
import { pickRepository } from '../scm/Sync.js';
import { appendTrailer, parseCoAuthors, removeTrailerOnce } from '../scm/trailers.js';
import { requireRepo, run, type CommandDeps } from './shared.js';

export async function soloCoAuthors(deps: CommandDeps): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  // no bulk "solo" command anymore — clear every currently active co-author
  const selected = deps.provider?.current?.selected ?? [];
  for (const s of selected) {
    await run(deps, ['coauthor', 'rm', s.email], { cwd });
  }
  if (selected.length > 0) deps.log.info(`solo: removed ${selected.length} co-author(s)`);
}

/**
 * Toggle one co-author in the SCM commit-message input: append its trailer
 * (formatted into the trailer block at the end) when absent, remove one
 * occurrence when present. The toggled author is also synced with the CLI
 * selection (`coauthor add` one-shot / `coauthor rm`) so the commit template
 * follows the box; manually typed trailers are never touched.
 */
export async function toggleCoAuthor(deps: CommandDeps, name: string, email: string): Promise<void> {
  const repo = pickRepository(deps.git);
  if (!repo) {
    vscode.window.showWarningMessage('Git Colabor: no git repository in the current workspace.');
    return;
  }
  const value = repo.inputBox.value;
  const present = parseCoAuthors(value).some((a) => a.email.toLowerCase() === email.toLowerCase());
  repo.inputBox.value = present ? removeTrailerOnce(value, email) : appendTrailer(value, { name, email });
  deps.log.info(`${present ? 'removed' : 'appended'} co-author trailer for ${name} <${email}>`);

  const cwd = deps.git.selectedRepoRoot();
  if (cwd) {
    // `coauthor rm` clears EVERY scope — including the persistent selection.
    // For an always-included author the click is a one-message removal only
    // (the next reload re-seeds the trailer; right-click Stop is the way
    // out), so the CLI is not called. One-shot authors keep the full rm.
    const isAlways = deps.windowAlways.isPinned(email);
    if (!(present && isAlways)) {
      await run(deps, ['coauthor', present ? 'rm' : 'add', email], { cwd });
    }
  }
  deps.provider?.refresh();
}

/**
 * Right-click → "Always Include" / "Stop Always Including" on a co-author
 * row — git-mob style, WINDOW-scoped: the author is pinned for EVERY repo
 * open in this window (each repo's persistent selection is written and kept
 * in sync; a repo opened later is caught up on the next refresh). Solo
 * clears repo selections; this toggle is the pin's own off-switch.
 */
export async function toggleAlwaysCoAuthor(deps: CommandDeps, item: unknown, force?: 'on' | 'off'): Promise<void> {
  const payload = (item as { payload?: { name?: string; email?: string } } | undefined)?.payload;
  const name = payload?.name ?? '';
  const email = payload?.email;
  if (!email) {
    deps.log.warn('always-coauthor command invoked without an author payload');
    return;
  }
  if (deps.git.repoRoots.length === 0) {
    vscode.window.showWarningMessage('Git Colabor: no git repository in the current workspace.');
    return;
  }
  const turnOn = force === undefined ? !deps.windowAlways.isPinned(email) : force === 'on';
  await deps.windowAlways.toggle(deps.cli, deps.git, { name, email }, turnOn);
  vscode.window.showInformationMessage(
    turnOn
      ? `Git Colabor: ${name || email} co-authors every commit in every repo of this window (Solo clears).`
      : `Git Colabor: ${name || email} removed from the selection.`,
  );
  await deps.provider?.reload();
}

/** List hidden identities and let the user restore one to auto-import. */
export async function showHiddenIdentities(deps: CommandDeps): Promise<void> {
  const data = await run<{ hidden: string[] }>(deps, ['identity', 'hidden', '--json']);
  if (!data || data.hidden.length === 0) {
    vscode.window.showInformationMessage('Git Colabor: no hidden identities.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    data.hidden.map((email) => ({
      label: `$(eye) ${email}`,
      description: 'hidden — click to restore',
      email,
    })),
    { placeHolder: 'Select an identity to unhide (restores display and auto-import)' },
  );
  if (!picked) return;
  const unhidden = await run<{ unhid: string }>(deps, ['identity', 'unhide', picked.email]);
  if (!unhidden) return;
  vscode.window.showInformationMessage(`Git Colabor: ${picked.email} un-hidden.`);
  // force a re-import for every session repo — the auto-import only runs
  // once per repo, so the un-hidden email would never come back otherwise
  for (const root of deps.git.repoRoots) {
    const r = await deps.cli.run(['identity', 'import', '--json'], { cwd: root });
    if (r.ok) {
      const added = ((r.data as { added?: { email: string }[] }).added ?? []).map((a) => a.email);
      if (added.length > 0) deps.log.info(`re-imported ${added.join(', ')} in ${root}`);
    }
  }
}
