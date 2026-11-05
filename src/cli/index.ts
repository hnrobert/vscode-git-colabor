import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Errors } from '../core/errors.js';
import { failFromError, emit } from './json.js';
import { parseCommandArgs, parseGlobals, type GlobalFlags } from './parse-args.js';

import * as coauthor from './coauthor.js';
import * as identity from './identity.js';
import type { JsonResult } from '../core/types.js';

const VERSION = '0.1.0';

// The CLI ships as a CJS bundle (dist/cli.cjs) where `__dirname` is the dist dir.
declare const __dirname: string | undefined;

/** Resolve the bundled askpass helper (dist/askpass.cjs), if present alongside this bundle. */
function resolveAskpass(): string | undefined {
  let dir: string | undefined;
  if (typeof __dirname === 'string' && __dirname.length > 0) dir = __dirname;
  else if (process.argv[1]) dir = dirname(process.argv[1]);
  if (!dir) return undefined;
  const p = join(dir, 'askpass.cjs');
  return existsSync(p) ? p : undefined;
}

function topHelp(): string {
  return [
    'git colabor — co-author + identity + SSH key management',
    '',
    'Usage:',
    '  git colabor coauthor add <email|id> [--always] [--global]',
    '       default: next commit only · --always: this repo · --global: all repos',
    '  git colabor coauthor rm <email|id>         (remove from all scopes)',
    '  git colabor coauthor ls [filter]           (available + active co-authors)',
    '  git colabor coauthor print                 (trailer blob for commit message)',
    '  git colabor coauthor suggest [filter]',
    '  git colabor identity ls',
    '  git colabor identity use <id> [--as-name <n> --as-email <e>]',
    '  git colabor identity agent <id> [--remove | --verify]   (load/unload the key in ssh-agent)',
    '  git colabor identity add --name <n> --email <e> [--key <path>]',
    '  git colabor identity import   (add all history committers as identities)',
    '  git colabor identity set <id> --name <n> | --email <e> | --key <path> | --no-key',
    '                               | --gpg-key <key> | --no-gpg-key   (GPG key to sign with)',
    '  git colabor identity sign <id> | sign [id] --off   (opt-in commit signing; GPG key if bound, else SSH)',
    '  git colabor identity gpg-keys             (secret GPG keys usable for signing)',
    '  git colabor identity disable <id>        (deactivate on key/passphrase failure)',
    '  git colabor identity rm <id>',
    '  git colabor identity logout [id]',
    '  git colabor identity status',
    '  git colabor identity audit [--repo <p>] [--tail N]',
    '  git colabor identity doctor',
    '',
    'Global flags: --json --log-level <level> -C <path> --no-color -h -v',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { flags, rest } = parseGlobals(argv);
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const subgroup = rest[0];
  const command = rest[1];
  const cmdTokens = rest.slice(2);
  if (!subgroup || flags.help) {
    process.stdout.write(`${topHelp()}\n`);
    process.exit(0);
  }
  const cwd = flags.cwd ?? process.cwd();

  let result: JsonResult;
  try {
    if (subgroup === 'coauthor') {
      result = await dispatchCoauthor(command, cmdTokens, flags, cwd);
    } else if (subgroup === 'identity') {
      result = await identity.dispatch(command, cmdTokens, {
        cwd,
        flags,
        askpassScriptPath: resolveAskpass(),
        socketPath: process.env.GIT_COLABOR_ASKPASS_SOCK,
        token: process.env.GIT_COLABOR_ASKPASS_TOKEN,
      });
    } else {
      throw Errors.usage(`unknown subgroup "${subgroup}"`);
    }
  } catch (e) {
    result = failFromError(e);
  }

  emit(result, { json: flags.json, human: (r) => humanFor(r, subgroup, command) });
}

async function dispatchCoauthor(
  command: string | undefined,
  tokens: string[],
  flags: GlobalFlags,
  cwd: string,
) {
  switch (command) {
    case 'add': {
      const p = parseCommandArgs(tokens, { boolFlags: ['--always', '--global'] });
      return coauthor.add(p.positionals, {
        always: p.bools.has('--always'),
        global: p.bools.has('--global'),
      }, cwd);
    }
    case 'rm': {
      const p = parseCommandArgs(tokens);
      return coauthor.rm(p.positionals, cwd);
    }
    case undefined:
    case 'ls': {
      const p = parseCommandArgs(tokens);
      return coauthor.ls(p.positionals, cwd);
    }
    case 'print':
      return coauthor.print({ initials: false }, cwd);
    case 'suggest': {
      const p = parseCommandArgs(tokens);
      return coauthor.suggest(p.positionals, cwd);
    }
    default:
      throw Errors.usage(`unknown coauthor command "${command}"`);
  }
}

function humanFor(r: JsonResult, subgroup: string, command?: string): string {
  if (!r.ok) {
    const lines = [`Error: ${r.error.message}`];
    for (const h of r.error.hints ?? []) lines.push(`  hint: ${h}`);
    return lines.join('\n');
  }
  const d = r.data;
  if (subgroup === 'coauthor') return coauthorHuman(command, d);
  if (subgroup === 'identity') return identityHuman(command, d);
  return JSON.stringify(d, null, 2);
}

function coauthorHuman(command: string | undefined, d: unknown): string {
  if (command === 'print') return String((d as { text?: string }).text ?? '');
  if (command === 'add') {
    const data = d as { added: { name: string; email: string }; mode: string };
    const modeLabel = data.mode === 'global' ? 'all repos' : data.mode === 'always' ? 'this repo' : 'next commit';
    return `Co-author ${data.added.name} <${data.added.email}> → ${modeLabel}`;
  }
  if (command === 'rm') {
    const data = d as { removed: { name: string; email: string }; from: string[] };
    return data.from.length
      ? `Removed ${data.removed.name} from: ${data.from.join(', ')}`
      : `${data.removed.name} was not active in any scope`;
  }
  if (command === undefined || command === 'ls') {
    const data = d as { available: { name: string; email: string }[]; selected: { name: string; email: string; mode: string }[] };
    const lines: string[] = [];
    if (data.selected.length > 0) {
      lines.push('Active co-authors:');
      for (const s of data.selected) lines.push(`  ● ${s.name} <${s.email}> (${s.mode})`);
    }
    lines.push(`Available (${data.available.length}):`);
    const selectedEmails = new Set(data.selected.map((s) => s.email.toLowerCase()));
    for (const a of data.available) {
      if (selectedEmails.has(a.email.toLowerCase())) continue;
      lines.push(`  ○ ${a.name} <${a.email}>`);
    }
    return lines.join('\n');
  }
  if (command === 'suggest') {
    const candidates = (d as { candidates?: { name: string; email: string }[] }).candidates ?? [];
    return candidates.length
      ? `Found ${candidates.length} contributor(s):\n${candidates.map((a) => `  ${a.name} <${a.email}>`).join('\n')}`
      : 'No contributors found.';
  }
  return JSON.stringify(d, null, 2);
}

type IdentityJson = {
  id: string;
  name: string;
  email: string;
  sshKeyFingerprint?: string;
  hasKey: boolean;
  inAgent?: boolean;
  isDefault: boolean;
};

function identityHuman(command: string | undefined, d: unknown): string {
  if (command === undefined || command === 'ls') {
    const identities = (d as { identities: IdentityJson[] }).identities ?? [];
    if (identities.length === 0) return 'No identities. Add one: git colabor identity add --name <n> --email <e>';
    return identities
      .map(
        (i) =>
          `${i.isDefault ? '* ' : '  '}${i.name} <${i.email}>${i.hasKey ? `  [key ${i.sshKeyFingerprint ?? ''}${i.inAgent ? ' · in agent' : ''}]` : ''}`,
      )
      .join('\n');
  }
  if (command === 'use') {
    const data = d as {
      identity: IdentityJson;
      applied: { userName: string; userEmail: string; sshCommand: string | null };
      agent?: { inAgent: boolean } | null;
    };
    const lines = [
      `Applied identity "${data.identity.name}" <${data.identity.email}>`,
      `  user.name       = ${data.applied.userName}`,
      `  user.email      = ${data.applied.userEmail}`,
    ];
    if (data.applied.sshCommand) lines.push(`  core.sshCommand = ${data.applied.sshCommand}`);
    if (data.identity.hasKey) lines.push(`  key in ssh-agent = ${data.agent?.inAgent ? 'yes' : 'no (load: git colabor identity agent <id>)'}`);
    return lines.join('\n');
  }
  if (command === 'agent') {
    const data = d as { loaded?: boolean; removed?: boolean; verified?: boolean; inAgent: boolean; message?: string };
    if (data.removed !== undefined) {
      return data.removed ? 'Key removed from ssh-agent.' : 'Key was not in ssh-agent.';
    }
    if (data.verified !== undefined) {
      return data.verified ? 'Passphrase verified (no agent write).' : 'Passphrase rejected.';
    }
    return data.inAgent
      ? 'Key loaded into ssh-agent.'
      : `Key not loaded${data.message ? `: ${data.message}` : ''}`;
  }
  if (command === 'add') {
    const data = d as { identity: IdentityJson; encrypted: boolean | null };
    return `Added identity "${data.identity.name}" <${data.identity.email}>${
      data.identity.hasKey ? ` key=${data.identity.sshKeyFingerprint ?? ''}` : ''
    }`;
  }
  if (command === 'rm') return `Removed identity ${(d as { removed: string }).removed}`;
  if (command === 'set') {
    const data = d as { identity: IdentityJson };
    return `Updated identity "${data.identity.name}" <${data.identity.email}>${
      data.identity.hasKey ? ` key=${data.identity.sshKeyFingerprint ?? ''}` : ''
    }`;
  }
  if (command === 'sign') {
    const data = d as { signing: boolean; format?: string; key?: string };
    return data.signing
      ? `Commit signing ON (${data.format} ${data.key}).`
      : 'Commit signing OFF (this repo does not sign, whatever global config says).';
  }
  if (command === 'gpg-keys') {
    const keys = (d as { keys: Array<{ fingerprint: string; uids: string[] }> }).keys;
    if (keys.length === 0) return 'No secret GPG keys usable for signing.';
    return keys.map((k) => `${k.fingerprint}  ${k.uids.join(', ')}`).join('\n');
  }
  if (command === 'import') {
    const data = d as { added: IdentityJson[]; skipped: number };
    if (data.added.length === 0) return `No new committers (skipped ${data.skipped} already-known).`;
    return `Imported ${data.added.length} identity(s) from history (skipped ${data.skipped}):\n${data.added
      .map((i) => `  ${i.name} <${i.email}>`)
      .join('\n')}`;
  }
  if (command === 'logout') {
    const data = d as { identity: { name: string }; cleared: { agent: boolean } };
    return `Logged out "${data.identity.name}" (agent: ${data.cleared.agent ? 'removed' : 'n/a'}; the key file itself is never touched)`;
  }
  if (command === 'audit') {
    const entries = (d as { entries: Array<{ ts: string; action: string; identityName?: string; result: string }> }).entries ?? [];
    if (entries.length === 0) return '(no audit entries)';
    return entries.map((e) => `${e.ts}  ${e.result.padEnd(4)}  ${e.action}  ${e.identityName ?? ''}`).join('\n');
  }
  if (command === 'doctor') {
    const diags = (d as { diagnostics: Array<{ check: string; status: string; detail?: string }> }).diagnostics ?? [];
    return diags.map((x) => `[${x.status.padEnd(4)}] ${x.check}${x.detail ? ` — ${x.detail}` : ''}`).join('\n');
  }
  return JSON.stringify(d, null, 2);
}

main().catch((e) => {
  process.stderr.write(`internal error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
