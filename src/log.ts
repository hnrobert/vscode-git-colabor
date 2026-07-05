import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel('Git Colabor', { log: true });
  context.subscriptions.push(channel);
  return channel;
}

export function log(): vscode.LogOutputChannel {
  if (!channel) throw new Error('log() called before initLog()');
  return channel;
}
