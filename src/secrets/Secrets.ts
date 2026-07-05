import * as vscode from 'vscode';

const PREFIX = 'ssh-pass:';

/** Thin wrapper over `context.secrets` for SSH key passphrases keyed `ssh-pass:<fingerprint>`. */
export class Secrets {
  constructor(private readonly storage: vscode.SecretStorage) {}

  static key(fingerprint: string): string {
    return PREFIX + fingerprint;
  }

  async get(fingerprint: string): Promise<string | undefined> {
    try {
      return await this.storage.get(Secrets.key(fingerprint));
    } catch {
      return undefined;
    }
  }

  async set(fingerprint: string, passphrase: string): Promise<void> {
    await this.storage.store(Secrets.key(fingerprint), passphrase);
  }

  async delete(fingerprint: string): Promise<void> {
    try {
      await this.storage.delete(Secrets.key(fingerprint));
    } catch {
      // best-effort
    }
  }

  onDidChange(cb: (fingerprint: string | undefined) => void): vscode.Disposable {
    const storage = this.storage as vscode.SecretStorage & {
      onDidChangeSecrets?: vscode.Event<{ key: string }>;
    };
    const ev = storage.onDidChangeSecrets;
    if (!ev) return { dispose() {} };
    return ev((e) => {
      const key = e.key;
      cb(key.startsWith(PREFIX) ? key.slice(PREFIX.length) : undefined);
    });
  }
}
