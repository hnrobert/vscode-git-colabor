import * as vscode from 'vscode';
import type { StatusJson } from '../types.js';

/** Status-bar indicator: active identity + co-author count. Click → identity picker. */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'gitColabor.useIdentity';
    this.update(undefined);
    this.item.show();
  }

  update(status: StatusJson | undefined): void {
    if (!status || !status.inRepo || !status.activeIdentity) {
      this.item.text = '$(person) colabor';
      this.item.tooltip = status && !status.inRepo ? 'Git Colabor — open a git repo' : 'Git Colabor — no identity active';
      return;
    }
    const a = status.activeIdentity;
    const mob = status.selected.length > 0 ? ` · +${status.selected.length}` : '';
    this.item.text = `$(person) ${a.name}${mob}`;
    const lines = ['Git Colabor', `Identity: ${a.name} <${a.email}>`];
    if (a.sshKeyFingerprint) lines.push(`Key: ${a.sshKeyFingerprint}`);
    if (status.managedBy) lines.push(`Managed by: ${status.managedBy}`);
    this.item.tooltip = lines.join('\n');
  }

  dispose(): void {
    this.item.dispose();
  }
}
