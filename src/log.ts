import * as vscode from 'vscode';

/**
 * LogOutputChannel wrapper honoring `gitColabor.logLevel`. The API's channel
 * level is read-only (it follows the window's developer log level), so the
 * setting is enforced here: messages below the configured severity never
 * reach the channel. The level is read per call — setting changes apply
 * immediately, no restart needed.
 */
class LevelFilteredLog implements vscode.LogOutputChannel {
  constructor(
    private readonly inner: vscode.LogOutputChannel,
    private readonly configured: () => vscode.LogLevel,
  ) {}

  private pass(l: vscode.LogLevel): boolean {
    return l >= this.configured(); // LogLevel ascends with severity; Off(6) filters everything
  }

  get name(): string {
    return this.inner.name;
  }
  get logLevel(): vscode.LogLevel {
    return this.inner.logLevel;
  }
  get onDidChangeLogLevel(): vscode.Event<vscode.LogLevel> {
    return this.inner.onDidChangeLogLevel;
  }
  trace(message: string): void {
    if (this.pass(vscode.LogLevel.Trace)) this.inner.trace(message);
  }
  debug(message: string): void {
    if (this.pass(vscode.LogLevel.Debug)) this.inner.debug(message);
  }
  info(message: string): void {
    if (this.pass(vscode.LogLevel.Info)) this.inner.info(message);
  }
  warn(message: string): void {
    if (this.pass(vscode.LogLevel.Warning)) this.inner.warn(message);
  }
  error(message: string): void {
    if (this.pass(vscode.LogLevel.Error)) this.inner.error(message);
  }
  append(value: string): void {
    this.inner.append(value);
  }
  appendLine(value: string): void {
    this.inner.appendLine(value);
  }
  replace(value: string): void {
    this.inner.replace(value);
  }
  clear(): void {
    this.inner.clear();
  }
  show(preserveFocus?: boolean): void;
  show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  show(a?: vscode.ViewColumn | boolean, b?: boolean): void {
    (this.inner.show as (x?: unknown, y?: unknown) => void)(a, b);
  }
  hide(): void {
    this.inner.hide();
  }
  dispose(): void {
    this.inner.dispose();
  }
}

function mapLevel(v: string | undefined): vscode.LogLevel {
  switch (v) {
    case 'trace':
      return vscode.LogLevel.Trace;
    case 'debug':
      return vscode.LogLevel.Debug;
    case 'warning':
    case 'warn':
      return vscode.LogLevel.Warning;
    case 'error':
      return vscode.LogLevel.Error;
    case 'off':
      return vscode.LogLevel.Off;
    default:
      return vscode.LogLevel.Info;
  }
}

let channel: vscode.LogOutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  const inner = vscode.window.createOutputChannel('Git Colabor', { log: true });
  const wrapped: vscode.LogOutputChannel = new LevelFilteredLog(
    inner,
    () => mapLevel(vscode.workspace.getConfiguration('gitColabor').get<string>('logLevel')),
  );
  context.subscriptions.push({ dispose: () => inner.dispose() });
  channel = wrapped;
  return channel;
}

export function log(): vscode.LogOutputChannel {
  if (!channel) throw new Error('log() called before initLog()');
  return channel;
}
