import * as vscode from 'vscode';
import { requireRepo, run, type CommandDeps } from './shared.js';
import type { DiagnosticJson } from '../types.js';

export async function doctor(deps: CommandDeps): Promise<void> {
  const cwd = deps.git.selectedRepoRoot();
  const data = await run<{ diagnostics: DiagnosticJson[] }>(deps, ['identity', 'doctor'], { cwd });
  if (!data) return;
  const out = data.diagnostics.map((d) => `[${d.status}] ${d.check}${d.detail ? ` — ${d.detail}` : ''}`).join('\n');
  deps.log.info(`doctor:\n${out}`);
  const fails = data.diagnostics.filter((d) => d.status === 'fail').length;
  const choice = await vscode.window.showInformationMessage(
    `Git Colabor doctor: ${fails === 0 ? 'all checks OK' : `${fails} issue(s) found`}`,
    'Show Output',
  );
  if (choice === 'Show Output') deps.log.show();
}

export async function revertRepo(deps: CommandDeps): Promise<void> {
  const cwd = requireRepo(deps);
  if (!cwd) return;
  const confirm = await vscode.window.showWarningMessage(
    'Revert this repo to its pre-tool identity state?',
    { modal: true },
    'Revert',
  );
  if (confirm !== 'Revert') return;
  await run(deps, ['identity', 'revert'], { cwd });
}

export async function showAudit(deps: CommandDeps): Promise<void> {
  const data = await run<{ entries: unknown[] }>(deps, ['identity', 'audit', '--tail', '100']);
  if (!data) return;
  const content = (data.entries as object[]).map((e) => JSON.stringify(e)).join('\n') + '\n';
  const doc = await vscode.workspace.openTextDocument({ content, language: 'jsonl' });
  await vscode.window.showTextDocument(doc);
}
