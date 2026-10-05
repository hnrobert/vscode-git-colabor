import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { colaborDir } from '../askpass/AskpassServer.js';

/** Run a binary quietly; resolves stdout (trimmed) or rejects with stderr. */
function capture(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(killTimer);
      reject(e);
    });
    child.on('close', (c) => {
      clearTimeout(killTimer);
      if (c === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `${cmd} exited ${c}`));
    });
  });
}

/** `ssh-keygen -lf` output → { fingerprint, algo } ("256 SHA256:xxx comment (ED25519)"). */
function parseKeygenLf(out: string): { fingerprint: string; algo: string } {
  const fp = out.match(/(SHA256:[A-Za-z0-9+/=]+)/)?.[1];
  const algo = out.match(/\(([^)]+)\)$/)?.[1]?.toLowerCase() ?? '';
  if (!fp) throw new Error(`unparseable ssh-keygen output: ${out}`);
  return { fingerprint: fp, algo };
}

/** First non-existing `<dir>/<base>` — `id_ed25519`, then `id_ed25519-2`, `-3`… */
function nonColliding(dir: string, base: string): string {
  if (!existsSync(join(dir, base))) return base;
  for (let i = 2; i < 100; i++) {
    const name = `${base}-${i}`;
    if (!existsSync(join(dir, name))) return name;
  }
  return `${base}-${Date.now()}`;
}

export type GeneratedKey = {
  path: string;
  fingerprint: string;
  algo: string;
  encrypted: boolean;
  /** the passphrase, when one was chosen — for the caller to bank in the session store */
  passphrase?: string;
};

/**
 * Generate a fresh SSH key via ssh-keygen. The passphrase, when set, is fed
 * through an env-var + SSH_ASKPASS script: never on argv (ps-visible), never
 * on disk (the script only echoes an env var of its own process).
 */
export async function generateKeyWizard(): Promise<GeneratedKey | undefined> {
  // 1. algorithm (ed25519 recommended default)
  const typePick = await vscode.window.showQuickPick(
    [
      { label: '$(check) ed25519', description: 'recommended — modern, fast, short keys', type: 'ed25519', bits: '' },
      { label: 'rsa', description: 'widely compatible legacy — 4096 bits', type: 'rsa', bits: '4096' },
      { label: 'ecdsa', description: 'nistp256', type: 'ecdsa', bits: '256' },
    ],
    { placeHolder: 'Key type' },
  );
  if (!typePick) return undefined;

  // 2. directory (default ~/.ssh, created when missing)
  const dir = (await vscode.window.showInputBox({
    prompt: 'Directory to save the key',
    value: join(homedir(), '.ssh'),
    ignoreFocusOut: true,
  }))?.trim();
  if (!dir) return undefined;

  // 3. file name (collision-free default)
  const name = (await vscode.window.showInputBox({
    prompt: 'File name',
    value: nonColliding(dir, `id_${typePick.type}`),
    ignoreFocusOut: true,
  }))?.trim();
  if (!name || name.includes('/')) return undefined;

  // 4. comment (default user@host, matching ssh-keygen's own default)
  const comment = await vscode.window.showInputBox({
    prompt: 'Comment',
    value: `${userInfo().username}@${hostname()}`,
    ignoreFocusOut: true,
  });
  if (comment === undefined) return undefined;

  // 5. optional passphrase (empty = unencrypted)
  const passphrase = await vscode.window.showInputBox({
    prompt: 'Passphrase (optional)',
    password: true,
    placeHolder: 'leave empty for no passphrase',
    ignoreFocusOut: true,
  });
  if (passphrase === undefined) return undefined;

  const path = join(dir, name);
  if (existsSync(path)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${path} already exists. Overwrite?`,
      { modal: true },
      'Overwrite',
    );
    if (overwrite !== 'Overwrite') return undefined;
  }
  await mkdir(dir, { recursive: true });

  const args = ['-t', typePick.type, '-C', comment || `${userInfo().username}@${hostname()}`, '-f', path];
  if (typePick.bits) args.push('-b', typePick.bits);
  try {
    if (passphrase === '') {
      // no secret: empty -N on argv is fine
      await capture('ssh-keygen', [...args, '-N', '']);
    } else {
      // passphrase via env + one-shot askpass script (echoes the env var —
      // the script itself holds no secret; ssh-keygen asks twice, both
      // answers come from the same env var, so the confirmation always matches)
      const askpassScript = join(colaborDir(), 'keygen-askpass.sh');
      const content = '#!/bin/sh\necho "$GIT_COLABOR_NEWKEY_PASS"\n';
      await writeFile(askpassScript, content, { mode: 0o700 });
      await chmod(askpassScript, 0o700);
      await capture('ssh-keygen', args, {
        ...process.env,
        GIT_COLABOR_NEWKEY_PASS: passphrase,
        SSH_ASKPASS: askpassScript,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY ?? ':0',
      });
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Git Colabor: key generation failed — ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }

  const lf = await capture('ssh-keygen', ['-lf', path]);
  const { fingerprint, algo } = parseKeygenLf(lf);
  // probe encryption the same way the CLI does: -y with an empty passphrase
  let encrypted = false;
  try {
    await capture('ssh-keygen', ['-y', '-P', '', '-f', path]);
  } catch {
    encrypted = true;
  }
  vscode.window.showInformationMessage(`Git Colabor: key generated — ${path}`);
  return { path, fingerprint, algo, encrypted, passphrase: passphrase === '' ? undefined : passphrase };
}

/**
 * Paste an existing private key: opens an untitled document (the input box
 * cannot take multi-line text), the user pastes + saves, then we validate,
 * ask for the destination and write it out with 0600.
 */
export async function pasteKeyWizard(): Promise<{ path: string } | undefined> {
  const doc = await vscode.workspace.openTextDocument({
    content: [
      '# Paste the PRIVATE key below these lines, then save (⌘S / Ctrl+S).',
      '# Lines starting with # are stripped. Close without saving to cancel.',
      '',
    ].join('\n'),
    language: 'shellscript',
  });
  await vscode.window.showTextDocument(doc, { preview: true });

  const pasted = await new Promise<string | undefined>((resolve) => {
    const onSave = vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.toString() !== doc.uri.toString()) return;
      cleanup();
      resolve(d.getText());
    });
    const onClose = vscode.workspace.onDidCloseTextDocument((d) => {
      if (d.uri.toString() !== doc.uri.toString()) return;
      cleanup();
      resolve(undefined);
    });
    const cleanup = () => {
      onSave.dispose();
      onClose.dispose();
      void Promise.resolve(vscode.commands.executeCommand('workbench.action.closeActiveEditor')).catch(() => {});
    };
  });
  if (pasted === undefined) return undefined;

  // strip instruction lines; a private key never contains # lines
  const keyText = pasted
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .trim() + '\n';
  if (!keyText.includes('PRIVATE KEY-----')) {
    vscode.window.showWarningMessage('Git Colabor: that does not look like a private key (no "PRIVATE KEY" header).');
    return undefined;
  }

  // validate via ssh-keygen on a temp copy
  const tmp = join(colaborDir(), `paste-${process.pid}.tmp`);
  await writeFile(tmp, keyText, { mode: 0o600 });
  await chmod(tmp, 0o600);
  let algo = 'key';
  try {
    const lf = await capture('ssh-keygen', ['-lf', tmp]);
    algo = parseKeygenLf(lf).algo || 'key';
  } catch (e) {
    vscode.window.showWarningMessage(`Git Colabor: ssh-keygen rejected the pasted key — ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }

  const dir = (await vscode.window.showInputBox({
    prompt: 'Directory to save the key',
    value: join(homedir(), '.ssh'),
    ignoreFocusOut: true,
  }))?.trim();
  if (!dir) return undefined;
  const name = (await vscode.window.showInputBox({
    prompt: 'File name',
    value: nonColliding(dir, `id_${algo}_imported`),
    ignoreFocusOut: true,
  }))?.trim();
  if (!name || name.includes('/')) return undefined;

  const path = join(dir, name);
  if (existsSync(path)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${path} already exists. Overwrite?`,
      { modal: true },
      'Overwrite',
    );
    if (overwrite !== 'Overwrite') return undefined;
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, keyText, { mode: 0o600 });
  await chmod(path, 0o600);
  vscode.window.showInformationMessage(`Git Colabor: key saved — ${path}`);
  return { path };
}
