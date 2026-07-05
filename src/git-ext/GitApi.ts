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

  activate(): GitApiShape | undefined {
    const ext = vscode.extensions.getExtension('vscode.git');
    const getApi = ext?.exports?.getAPI;
    if (typeof getApi !== 'function') return undefined;
    try {
      this._api = getApi(1) as GitApiShape;
    } catch {
      this._api = undefined;
    }
    return this._api;
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

  /** Resolve a single repo root to operate on (selected if multi-root, else the first). */
  selectedRepoRoot(): string | undefined {
    if (!this._api || this._api.repositories.length === 0) return undefined;
    if (this._api.repositories.length === 1) return this._api.repositories[0].rootUri.fsPath;
    const sel = this._api.repositories.find((r) => r.ui.selected);
    return (sel ?? this._api.repositories[0]).rootUri.fsPath;
  }
}
