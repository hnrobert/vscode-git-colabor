import * as vscode from 'vscode';
import { pickRepository } from '../scm/Sync.js';
import { appendTrailer, parseCoAuthors, removeTrailerOnce } from '../scm/trailers.js';
import { requireRepo, run, type CommandDeps } from './shared.js';

export async function soloCoAuthors(deps: CommandDeps): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  await run(deps, ['coauthor', 'solo'], { cwd });
}

/**
 * Toggle one co-author in the SCM commit-message input: append its trailer
 * (formatted into the trailer block at the end) when absent, remove one
 * occurrence when present. Keeps the CLI selection / commit template in
 * sync behind the scenes — but only when every trailer in the box maps to
 * the catalogue, so manually typed trailers are never clobbered.
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

  // best-effort CLI sync so `colabor.selected` + commit template follow the box
  const cwd = deps.git.selectedRepoRoot();
  if (!cwd) {
    deps.provider?.refresh();
    return;
  }
  const after = parseCoAuthors(repo.inputBox.value);
  const catalogue = [...(deps.provider?.current?.selected ?? []), ...(deps.provider?.current?.available ?? [])];
  const byEmail = new Map(catalogue.map((a) => [a.email.toLowerCase(), a.key]));
  const keys = after.map((a) => byEmail.get(a.email.toLowerCase()));
  if (keys.every((k): k is string => typeof k === 'string')) {
    if (keys.length === 0) await run(deps, ['coauthor', 'solo'], { cwd });
    else await run(deps, ['coauthor', 'use', ...new Set(keys)], { cwd });
  } else {
    deps.log.info('box has trailers outside the catalogue; leaving CLI selection unchanged');
  }
  deps.provider?.refresh();
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
    { placeHolder: 'Select an identity to unhide (restore for auto-import)' },
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
