import { spawnSync } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { parseCommandArgs, type CmdParsed, type GlobalFlags } from './parse-args.js';
import { Errors } from '../core/errors.js';
import { ok } from './json.js';
import {
  addIdentity,
  getKeyBinding,
  getIdentity,
  hideIdentityEmail,
  listHiddenEmails,
  listIdentities,
  markStandingDown,
  isStandingDown,
  readMap,
  removeIdentity,
  setDefault,
  setPushKey,
  setSignCommits,
  setSignKey,
  unhideIdentityEmail,
} from '../core/identity/map.js';
import { historyCommitters } from '../core/git/committers.js';
import { getConfig } from '../core/git/config.js';
import { importKey } from '../core/identity/keys.js';
import { applyIdentity, applyResolvedIdentity } from '../core/identity/apply.js';
import { setCommitSigning, signingStatus } from '../core/identity/sign.js';
import { logoutIdentity } from '../core/identity/logout.js';
import { appendAudit, readAudit } from '../core/logging/audit.js';
import { agentFingerprints, keyInAgent, listAgent, loadKey, removeKey, verifyKey } from '../core/identity/agent.js';
import { insideWorkTree } from '../core/git/rev.js';
import { repoStatus } from '../core/repo/status.js';
import { resolveActive } from '../core/identity/resolve.js';
import { auditLogPath, mapPath } from '../core/paths.js';
import type { Diagnostic, Identity, JsonResult, Source, Warning } from '../core/types.js';

export type IdCtx = {
  cwd?: string;
  flags: GlobalFlags;
  askpassScriptPath?: string;
  socketPath?: string;
  token?: string;
};

const USE_SPEC = { valueFlags: ['--source', '--as-name', '--as-email', '--config-scope'], boolFlags: [] };
const ADD_SPEC = {
  valueFlags: ['--name', '--email', '--key', '--host', '--source'],
  boolFlags: ['--default'],
};
const AUDIT_SPEC = { valueFlags: ['--repo', '--since', '--tail'] };
const APPLY_SPEC = { valueFlags: ['--name', '--email', '--ssh-command', '--source'] };
const SET_SPEC = {
  valueFlags: ['--name', '--email', '--key', '--gpg-key', '--sign-key', '--scope'],
  boolFlags: ['--no-key', '--no-gpg-key', '--no-sign-key', '--sign-commits', '--no-sign-commits'],
};
const SIGN_SPEC = { valueFlags: [], boolFlags: ['--off'] };
const UNSET_SPEC = { valueFlags: ['--scope'], boolFlags: [] };
const AGENT_SPEC = { valueFlags: [], boolFlags: ['--remove', '--verify'] };

/** Row shape consumed by the extension — key facts derived from the bindings table. */
function identityToJson(i: Identity, defaultId?: string, agentPrints?: Set<string>, binding?: Awaited<ReturnType<typeof getKeyBinding>>) {
  const push = binding?.pushKey;
  const sign = binding?.signKey;
  return {
    id: i.id,
    name: i.name,
    email: i.email,
    host: i.host,
    // reference mode: a key counts only while the referenced file is still there
    hasKey: !!push && existsSync(push.path),
    sshKeyPath: push?.path,
    sshKeyFingerprint: push?.fingerprint,
    keyEncrypted: !!push?.encrypted,
    /** key fingerprint currently held by ssh-agent (live check) */
    inAgent: !!push?.fingerprint && (agentPrints?.has(push.fingerprint) ?? false),
    signKey: sign
      ? sign.format === 'openpgp'
        ? { format: sign.format, key: sign.key }
        : {
            format: sign.format,
            path: sign.path,
            fingerprint: sign.fingerprint,
            ...(sign.encrypted ? { encrypted: true } : {}),
          }
      : null,
    imported: !!i.imported,
    fromConfig: !!i.fromConfig,
    scope: i.scope ?? (i.imported ? 'project' : 'machine'),
    isDefault: i.id === defaultId,
    /** the user turned commit signing on for this identity */
    signCommits: !!binding?.signCommits,
  };
}

function asSource(v: string | undefined): Source {
  return v === 'ext' ? 'ext' : 'cli';
}

export async function dispatch(command: string | undefined, tokens: string[], ctx: IdCtx): Promise<JsonResult> {
  switch (command) {
    case undefined:
    case 'ls':
      return ls();
    case 'use':
      return use(parseCommandArgs(tokens, USE_SPEC), ctx);
    case 'add':
      return add(parseCommandArgs(tokens, ADD_SPEC));
    case 'import':
      return importFromHistory(ctx);
    case 'set':
      return setIdentity(parseCommandArgs(tokens, SET_SPEC), ctx);
    case 'sign':
      return sign(parseCommandArgs(tokens, SIGN_SPEC), ctx);
    case 'gpg-keys':
      return gpgKeys(ctx);
    case 'unhide':
      return unhide(parseCommandArgs(tokens));
    case 'hidden':
      return hiddenLs();
    case 'rm':
      return rm(parseCommandArgs(tokens));
    case 'logout':
      return logout(parseCommandArgs(tokens), ctx);
    case 'unset-config':
      return unsetConfigForIdentity(parseCommandArgs(tokens, UNSET_SPEC), ctx);
    case 'agent':
      return agentKey(parseCommandArgs(tokens, AGENT_SPEC), ctx);
    case 'hide':
      return hideIdentityCmd(parseCommandArgs(tokens));
    case 'audit':
      return audit(parseCommandArgs(tokens, AUDIT_SPEC));
    case 'doctor':
      return doctor(ctx);
    case 'status':
      return status(ctx);
    case '_apply':
      return hiddenApply(parseCommandArgs(tokens, APPLY_SPEC), ctx);
    default:
      throw Errors.usage(`unknown identity command "${command}"`);
  }
}

async function ls(): Promise<JsonResult> {
  const map = await readMap();
  const { identities, defaultIdentity } = await listIdentities();
  const prints = await agentFingerprints();
  const hidden = new Set(await listHiddenEmails());
  const visible = identities.filter((i) => !hidden.has(i.email.toLowerCase()));
  return ok({ identities: visible.map((i) => identityToJson(i, defaultIdentity, prints, map.keyBindings?.[i.id])), defaultIdentity });
}

/** `identity hide <email>` — hide an identity on this machine (display + import). */
async function hideIdentityCmd(p: CmdParsed): Promise<JsonResult> {
  const email = p.positionals[0];
  if (!email) throw Errors.usage('git colabor identity hide <email>');
  await hideIdentityEmail(email);
  await appendAudit({
    action: 'identity.hide',
    source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
    message: email.toLowerCase(),
  });
  return ok({ hidden: email.toLowerCase() });
}

/**
 * The ONLY path that puts a key into ssh-agent: `identity agent <id>` loads
 * it, `--remove` takes it out, `--verify` proves the session passphrase is
 * correct without loading.
 */
async function agentKey(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity agent <id> [--remove | --verify]');
  const identity = await getIdentity(id);
  const binding = await getKeyBinding(id);
  if (!binding.pushKey) throw Errors.usage(`identity "${id}" has no SSH push key`);
  const { path: keyPath, fingerprint } = binding.pushKey;
  const remove = p.bools.has('--remove');
  const verify = p.bools.has('--verify');
  if (remove && verify) throw Errors.usage('--remove and --verify are mutually exclusive');

  if (remove) {
    const removed = await removeKey(keyPath);
    await appendAudit({
      action: 'key.remove',
      source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
      identity: id,
      identityName: identity.name,
      fingerprint,
    });
    return ok({ removed, inAgent: await keyInAgent(fingerprint) }, removed ? [] : [
      { code: 'not-in-agent', message: 'key was not loaded in ssh-agent' },
    ]);
  }

  const askpassScriptPath = ctx.askpassScriptPath ? await (await import('../core/identity/apply.js')).ensureAskpassWrapper(ctx.askpassScriptPath) : undefined;
  if (verify) {
    const verified = await verifyKey({ keyPath, fingerprint, askpassScriptPath, socketPath: ctx.socketPath, token: ctx.token });
    return ok({ verified, inAgent: await keyInAgent(fingerprint) });
  }

  const loaded = await loadKey({ keyPath, fingerprint, askpassScriptPath, socketPath: ctx.socketPath, token: ctx.token, useAppleKeychain: true });
  if (loaded.loaded) {
    await appendAudit({
      action: 'key.load',
      source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
      identity: id,
      identityName: identity.name,
      fingerprint,
      message: `via ${loaded.via}`,
    });
  }
  return ok(
    { loaded: loaded.loaded, via: loaded.via, inAgent: await keyInAgent(fingerprint), message: loaded.message },
    loaded.loaded ? [] : [{ code: 'key-not-loaded', message: loaded.message ?? `via ${loaded.via}` }],
  );
}

async function use(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity use <id>');
  const scopeVal = p.values['--config-scope'];
  if (scopeVal !== undefined && scopeVal !== 'local' && scopeVal !== 'global') {
    throw Errors.usage(`--config-scope must be local|global, got "${scopeVal}"`);
  }
  const { identity, result } = await applyIdentity(id, {
    source: asSource(p.values['--source']),
    cwd: ctx.cwd,
    asName: p.values['--as-name'],
    asEmail: p.values['--as-email'],
    askpassScriptPath: ctx.askpassScriptPath,
    socketPath: ctx.socketPath,
    token: ctx.token,
    configScope: scopeVal === 'global' ? 'global' : 'local',
  });
  const warnings: Warning[] = [];
  if (result.keyMissing) {
    warnings.push({
      code: 'key-missing',
      message: `push key file missing or unreadable — applied without a key (no core.sshCommand)`,
    });
  }
  if (result.keyDegraded) {
    warnings.push({
      code: 'key-degraded',
      message: `passphrase unavailable — identity applied WITHOUT the push/sign key; retry via the extension or ssh-add`,
    });
  }
  const map = await readMap();
  return ok(
    {
      identity: identityToJson(identity, undefined, undefined, map.keyBindings?.[identity.id]),
      applied: {
        userName: result.name,
        userEmail: result.email,
        sshCommand: result.sshCommand ?? null,
        configScope: scopeVal === 'global' ? 'global' : 'local',
      },
      keyApplied: result.keyApplied,
      agent: result.agent ?? null,
    },
    warnings,
  );
}

async function add(p: CmdParsed): Promise<JsonResult> {
  const name = p.values['--name'];
  const email = p.values['--email'];
  if (!name || !email) {
    throw Errors.usage('git colabor identity add --name <n> --email <e> [--key <path>] [--host <h>] [--default]');
  }
  const warnings: Warning[] = [];
  let encrypted: boolean | null = null;
  const keySource = p.values['--key'];
  if (keySource) {
    if (!existsSync(keySource)) throw Errors.usage(`key file not found: ${keySource}`);
    const imp = await importKey(keySource);
    encrypted = imp.encrypted;
    if (imp.encrypted) {
      warnings.push({ code: 'encrypted-key', message: 'key is encrypted; it loads via the extension askpass session or an ssh-agent' });
    } else {
      warnings.push({ code: 'unencrypted-key', message: 'key is UNENCRYPTED — anyone who reads the key file can use it. Consider encrypting it.' });
    }
  }
  const identity = await addIdentity({ name, email, host: p.values['--host'] });
  // key is a PREFERENCE: record it in the bindings table, apply nothing here
  if (keySource) {
    const imp = await importKey(keySource);
    await setPushKey(identity.id, { path: imp.path, fingerprint: imp.fingerprint, ...(imp.encrypted ? { encrypted: true } : {}) });
  }
  if (p.bools.has('--default')) await setDefault(identity.id);
  const map = await readMap();
  return ok({ identity: identityToJson(identity, undefined, undefined, map.keyBindings?.[identity.id]), encrypted }, warnings);
}

/**
 * Add every distinct committer from the repo history as a (key-less)
 * identity. Idempotent via deterministic ids; skips hidden emails.
 */
export async function importFromHistory(ctx: IdCtx): Promise<JsonResult> {
  if (!(await insideWorkTree(ctx.cwd))) throw Errors.notARepo(ctx.cwd);
  const committers = await historyCommitters(ctx.cwd);
  const map = await readMap();
  const known = new Set(Object.values(map.identities).map((i) => i.email.toLowerCase()));
  const hidden = new Set(Object.keys(map.hidden ?? {}));
  const added: Identity[] = [];
  for (const c of committers) {
    const id = c.email.toLowerCase();
    if (known.has(id) || hidden.has(id)) continue;
    const identity = await addIdentity({ name: c.name, email: c.email, imported: true, scope: 'project' });
    known.add(id);
    added.push(identity);
  }
  if (added.length > 0) {
    await appendAudit({
      action: 'identity.import',
      source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
      message: `imported ${added.length} committer(s) from history`,
    });
  }
  const warnings: Warning[] = committers.length === 0 ? [{ code: 'empty', message: 'no commits found in history' }] : [];
  return ok({ added, skipped: committers.length - added.length }, warnings);
}

async function rm(p: CmdParsed): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity rm <id>');
  let email: string | undefined;
  let wasImported = false;
  try {
    const identity = await getIdentity(id);
    email = identity.email;
    wasImported = !!identity.imported;
  } catch {
    // fall through — removeIdentity reports the not-found error
  }
  await removeIdentity(id);
  if (wasImported && email) await hideIdentityEmail(email);
  return ok({ removed: id, hidden: wasImported ? (email ?? '').toLowerCase() : undefined });
}

/**
 * Edit an identity in place. --key/--gpg-key set PREFERENCES (bindings table
 * only — nothing is applied until the next use/session).
 */
async function setIdentity(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) {
    throw Errors.usage(
      'git colabor identity set <id> --name <n> | --email <e> | --key <path> | --no-key | --gpg-key <k> | --no-gpg-key | --sign-key <path> | --no-sign-key | --sign-commits | --no-sign-commits | --scope <s>',
    );
  }
  await getIdentity(id); // validates existence
  const warnings: Warning[] = [];
  const { updateIdentity } = await import('../core/identity/map.js');
  const patch: Parameters<typeof updateIdentity>[1] = {};
  if (p.values['--name']) patch.name = p.values['--name'];
  if (p.values['--email']) patch.email = p.values['--email'];
  if (p.values['--scope']) {
    const s = p.values['--scope'];
    if (s !== 'machine' && s !== 'project') throw Errors.usage(`--scope must be machine|project, got "${s}"`);
    patch.scope = s;
  }
  let keyTouched = false;
  if (p.bools.has('--no-key')) {
    await setPushKey(id, undefined);
    keyTouched = true;
  }
  if (p.values['--key']) {
    const keySource = p.values['--key'];
    if (!existsSync(keySource)) throw Errors.usage(`key file not found: ${keySource}`);
    const imp = await importKey(keySource);
    await setPushKey(id, { path: imp.path, fingerprint: imp.fingerprint, ...(imp.encrypted ? { encrypted: true } : {}) });
    keyTouched = true;
    if (imp.encrypted) {
      warnings.push({ code: 'encrypted-key', message: 'key is encrypted; it loads via the extension askpass session or an ssh-agent' });
    }
  }
  if (p.bools.has('--no-gpg-key') || p.bools.has('--no-sign-key')) {
    await setSignKey(id, undefined);
    keyTouched = true;
  }
  if (p.values['--gpg-key']) {
    const { listSigningKeys } = await import('../core/identity/gpg.js');
    const [key, ...more] = await listSigningKeys(ctx.cwd, p.values['--gpg-key']);
    if (!key) throw Errors.usage(`no usable secret GPG signing key matches "${p.values['--gpg-key']}"`);
    if (more.length > 0) throw Errors.usage(`"${p.values['--gpg-key']}" matches several GPG keys — pass a fingerprint`);
    await setSignKey(id, { format: 'openpgp', key: key.fingerprint });
    keyTouched = true;
  }
  if (p.values['--sign-key']) {
    const signSource = p.values['--sign-key'];
    if (!existsSync(signSource)) throw Errors.usage(`key file not found: ${signSource}`);
    const imp = await importKey(signSource);
    await setSignKey(id, { format: 'ssh', path: imp.path, fingerprint: imp.fingerprint, ...(imp.encrypted ? { encrypted: true } : {}) });
    keyTouched = true;
    if (imp.encrypted) {
      warnings.push({ code: 'encrypted-key', message: 'sign key is encrypted; it signs via the extension askpass session or an ssh-agent' });
    }
  }
  if (p.bools.has('--sign-commits')) {
    await setSignCommits(id, true);
    keyTouched = true;
  }
  if (p.bools.has('--no-sign-commits')) {
    await setSignCommits(id, false);
    keyTouched = true;
  }
  if (Object.keys(patch).length === 0 && !keyTouched) {
    throw Errors.usage(
      'identity set needs at least one of --name / --email / --key / --no-key / --gpg-key / --no-gpg-key / --sign-key / --no-sign-key / --sign-commits / --no-sign-commits / --scope',
    );
  }
  const next = Object.keys(patch).length > 0 ? await updateIdentity(id, patch) : await getIdentity(id);
  await appendAudit({
    action: 'identity.set',
    source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
    identity: id,
    identityName: next.name,
    message: `set ${[...Object.keys(patch), ...(keyTouched ? ['key'] : [])].join(', ')}`,
  });
  const map = await readMap();
  return ok({ identity: identityToJson(next, undefined, undefined, map.keyBindings?.[id]) }, warnings);
}

async function logout(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const r = await logoutIdentity({ source: 'cli', cwd: ctx.cwd, id: p.positionals[0] });
  return ok({ identity: r.identity, cleared: r.cleared });
}

/**
 * `identity unset-config <id> [--scope local|global]` — strip an identity's
 * name/email/keys from one git-config file (content-matched; another
 * person's config survives). Local scope also arms the standing-down guard
 * so auto-apply does not silently re-write what was just removed; any
 * explicit local `identity use` clears it again.
 */
async function unsetConfigForIdentity(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  if (!id) throw Errors.usage('git colabor identity unset-config <id> [--scope local|global]');
  const scope = p.values['--scope'];
  if (scope !== undefined && scope !== 'local' && scope !== 'global') {
    throw Errors.usage(`--scope must be local|global, got "${scope}"`);
  }
  const identity = await getIdentity(id);
  const binding = await getKeyBinding(id);
  const { clearIdentityConfigLayer } = await import('../core/identity/configClear.js');
  const cleared = await clearIdentityConfigLayer(
    { name: identity.name, email: identity.email, pushKeyPath: binding.pushKey?.path, signKey: binding.signKey },
    { cwd: ctx.cwd, scope: scope === 'global' ? 'global' : 'local' },
  );
  if (scope !== 'global' && (cleared.identityLayer || cleared.sshCommand || cleared.signing)) {
    const tl = await (await import('../core/git/rev.js')).topLevel(ctx.cwd).catch(() => undefined);
    if (tl) await markStandingDown(tl);
  }
  await appendAudit({
    action: 'identity.logout',
    source: process.env.GIT_COLABOR_SOURCE === 'ext' ? 'ext' : 'cli',
    identity: id,
    identityName: identity.name,
    repo: await (await import('../core/git/rev.js')).topLevel(ctx.cwd).catch(() => undefined),
    message: `unset-config ${scope ?? 'local'}: ${[cleared.identityLayer ? 'identity' : null, cleared.sshCommand ? 'ssh key' : null, cleared.signing ? 'sign key' : null].filter(Boolean).join(' + ') || 'nothing matched'}`,
  });
  return ok({ identity: { id, name: identity.name }, cleared: { ...cleared, scope: scope ?? 'local' } });
}

async function audit(p: CmdParsed): Promise<JsonResult> {
  const entries = await readAudit({
    repo: p.values['--repo'],
    since: p.values['--since'],
    tail: p.values['--tail'] ? Number(p.values['--tail']) : undefined,
  });
  return ok({ entries });
}

/** Remove an email from the hidden list (restore for auto-import). */
async function unhide(p: CmdParsed): Promise<JsonResult> {
  const email = p.positionals[0];
  if (!email) throw Errors.usage('git colabor identity unhide <email>');
  const removed = await unhideIdentityEmail(email);
  if (!removed) throw Errors.usage(`"${email}" is not hidden`);
  return ok({ unhid: email.toLowerCase() });
}

/** List all hidden emails. */
async function hiddenLs(): Promise<JsonResult> {
  return ok({ hidden: await listHiddenEmails() });
}

/** Toggle opt-in commit signing for the repo with the identity's sign key (GPG if bound, else SSH). */
async function sign(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const id = p.positionals[0];
  const on = !p.bools.has('--off');
  if (!id && on) throw Errors.usage('git colabor identity sign <id> | identity sign [id] --off');
  const r = await setCommitSigning({ source: 'cli', cwd: ctx.cwd, id, on, askpassScriptPath: ctx.askpassScriptPath });
  return ok(r);
}

/** Secret GPG keys usable for commit signing (for `identity set --gpg-key`). */
async function gpgKeys(ctx: IdCtx): Promise<JsonResult> {
  const { listSigningKeys } = await import('../core/identity/gpg.js');
  return ok({ keys: await listSigningKeys(ctx.cwd) });
}

async function hiddenApply(p: CmdParsed, ctx: IdCtx): Promise<JsonResult> {
  const name = p.values['--name'];
  const email = p.values['--email'];
  if (!name || !email) throw Errors.usage('internal _apply requires --name and --email');
  const result = await applyResolvedIdentity({
    name,
    email,
    sshCommand: p.values['--ssh-command'],
    opts: { source: asSource(p.values['--source']), cwd: ctx.cwd },
  });
  return ok({
    applied: { userName: result.name, userEmail: result.email, sshCommand: result.sshCommand ?? null },
  });
}

async function status(ctx: IdCtx): Promise<JsonResult> {
  const rs = await repoStatus(ctx.cwd);

  // per-scope config identities (repo-local / global): BOTH user.name and
  // user.email must be set at the scope to form an identity. EMAIL is the
  // person key: an email match maps to that store row (name preference only
  // picks AMONG email matches — no same-email forks, mirroring resolveActive);
  // a hidden email with no row is reported without enrolling (hide wins).
  const scopeIdentity = async (scope: 'local' | 'global'): Promise<{ name: string; email: string; id: string } | null> => {
    const [n, e] = await Promise.all([getConfig('user.name', scope, ctx.cwd), getConfig('user.email', scope, ctx.cwd)]);
    if (!n || !e) return null;
    const norm = (s: string): string => s.trim().toLowerCase();
    const byEmail = Object.values((await readMap()).identities).filter((i) => norm(i.email) === norm(e));
    const match = byEmail.find((i) => norm(i.name) === norm(n)) ?? byEmail[0];
    if (match) return { name: n, email: e, id: match.id };
    if ((await listHiddenEmails()).includes(e.toLowerCase())) return { name: n, email: e, id: '' };
    const added = await addIdentity({ name: n, email: e, scope: 'machine', fromConfig: true });
    return { name: n, email: e, id: added.id };
  };
  const configIdentities = {
    repo: rs.inRepo ? await scopeIdentity('local') : null,
    global: await scopeIdentity('global'),
  };

  const map = await readMap();
  const { identities, defaultIdentity } = await listIdentities();
  const prints = await agentFingerprints();

  // config-driven active identity: the effective (name, email) matches the
  // store (auto-enrolling unknowns); the tree marks it active
  const resolved = rs.inRepo ? await resolveActive(ctx.cwd, { enroll: true }) : undefined;
  const active = resolved?.identity;
  const activeId = active?.id;

  const hidden = new Set(await listHiddenEmails());
  const rows = identities
    .filter((i) => i.id === activeId || !hidden.has(i.email.toLowerCase()))
    .map((i) => ({
      ...identityToJson(i, defaultIdentity, prints, map.keyBindings?.[i.id]),
      active: i.id === activeId,
    }));

  return ok({
    repo: rs.repo,
    inRepo: rs.inRepo,
    // what `git commit` will actually do here, and which scope decides it
    signing: await signingStatus(ctx.cwd),
    activeIdentity: active ? identityToJson(active, defaultIdentity, prints, map.keyBindings?.[active.id]) : null,
    enrolled: resolved?.enrolled ?? false,
    identities: rows,
    // which identity each git-config SCOPE names (repo-local / global) —
    // drives the "found in repo config" / "found in git global config" rows
    configIdentities,
    // the user stripped this repo's config and auto-apply stands down here
    // until an explicit local use (see map.ts standingDown)
    standingDown: rs.repo ? await isStandingDown(rs.repo) : false,
    selected: rs.selected,
    available: rs.available,
  });
}

async function doctor(ctx: IdCtx): Promise<JsonResult> {
  const diags: Diagnostic[] = [];
  const check = (check: string, fn: () => boolean | string, detail?: string) => {
    try {
      const r = fn();
      diags.push({ check, status: r === true ? 'ok' : r === false ? 'warn' : 'ok', detail: typeof r === 'string' ? r : detail });
    } catch (e) {
      diags.push({ check, status: 'fail', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const hasBin = (b: string) =>
    process.platform === 'win32'
      ? spawnSync('where', [b]).status === 0
      : spawnSync(`command -v ${b}`, { shell: true }).status === 0;
  check('git', () => hasBin('git'));
  check('ssh-keygen', () => hasBin('ssh-keygen'));
  check('ssh-add', () => hasBin('ssh-add'));

  try {
    accessSync(mapPath(), constants.R_OK | constants.W_OK);
    check('identity map', () => true, mapPath());
  } catch {
    check('identity map', () => true, `${mapPath()} (will be created on first add)`);
  }

  check('audit log', () => true, auditLogPath());
  check('askpass bundle', () => (!!ctx.askpassScriptPath && existsSync(ctx.askpassScriptPath)) as boolean, ctx.askpassScriptPath);

  const agentOut = await listAgent();
  check('ssh-agent', () => !agentOut.includes('Could not open a connection'), agentOut.split('\n')[0]);

  const inRepo = ctx.cwd ? await insideWorkTree(ctx.cwd) : false;
  check('inside git repo', () => inRepo, ctx.cwd);
  if (inRepo && ctx.cwd) {
    const resolved = await resolveActive(ctx.cwd);
    check('active identity', () => !!resolved, resolved?.identity.name ?? '(none — config has no match)');
  }

  return ok({ diagnostics: diags });
}
