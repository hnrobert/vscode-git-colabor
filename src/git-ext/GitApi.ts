import * as vscode from 'vscode';

export type GitRepository = {
  rootUri: vscode.Uri;
  ui: { onDidChange: vscode.Event<void>; selected: boolean };
  inputBox: { value: string };
};

type GitApiShape = {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
};

/** Bridge to the built-in `vscode.git` extension's published API (v1). */
export class GitApi {
  private _api: GitApiShape | undefined;

  /**
   * Acquire the vscode.git API. Idempotent and safe to retry: under
   * Remote-SSH the git extension's activation can complete shortly after
   * ours starts, so a failed attempt must leave state clean for the next
   * one. Returns '' on success or a short reason for the log.
   */
  async activate(): Promise<string> {
    if (this._api) return '';
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return 'vscode.git not found';
    try {
      if (!ext.isActive) await ext.activate();
    } catch (e) {
      return `vscode.git activate() threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    const gitExports = ext.exports as { getAPI?: (version: number) => GitApiShape } | undefined;
    if (!gitExports || typeof gitExports.getAPI !== 'function') {
      return 'vscode.git exports has no getAPI (activation not finished?)';
    }
    try {
      // Call getAPI ON the exports object — extracting the method would lose
      // its receiver and throw "Cannot read properties of undefined
      // (reading '_model')" because getAPI reads this._model internally.
      this._api = gitExports.getAPI(1);
      return '';
    } catch (e) {
      return `getAPI(1) threw: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  get api(): GitApiShape | undefined {
    return this._api;
  }

  get repositories(): GitRepository[] {
    return this._api?.repositories ?? [];
  }

  get hasRepositories(): boolean {
    return (this._api?.repositories.length ?? 0) > 0;
  }

  /** All open repository roots — identity actions apply to every one of them. */
  get repoRoots(): string[] {
    return this._api?.repositories.map((r) => r.rootUri.fsPath) ?? [];
  }

  /** Resolve a single repo root to operate on (selected if multi-root, else the first). */
  selectedRepoRoot(): string | undefined {
    if (!this._api || this._api.repositories.length === 0) return undefined;
    if (this._api.repositories.length === 1) return this._api.repositories[0].rootUri.fsPath;
    const sel = this._api.repositories.find((r) => r.ui.selected);
    return (sel ?? this._api.repositories[0]).rootUri.fsPath;
  }

  /** Subscribe to repository open/close + each repo's UI (selection) changes. */
  subscribe(cb: () => void): vscode.Disposable {
    const api = this._api;
    if (!api) return { dispose() {} };
    const disposables: vscode.Disposable[] = [api.onDidOpenRepository(cb), api.onDidCloseRepository(cb)];
    for (const r of api.repositories) disposables.push(r.ui.onDidChange(cb));
    return { dispose() { disposables.forEach((d) => d.dispose()); } };
  }
}
