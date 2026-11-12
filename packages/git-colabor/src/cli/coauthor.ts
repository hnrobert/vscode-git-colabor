import { Author, genKey } from '../core/authors/types.js';
import { listIdentities } from '../core/identity/map.js';
import { getSelected, setSelected } from '../core/coauthors/state.js';
import { printTrailers } from '../core/message/formatter.js';
import { repoAuthors } from '../core/git/shortlog.js';
import { insideWorkTree } from '../core/git/rev.js';
import { setConfig, unsetConfig, getAllConfig } from '../core/git/config.js';
import { dataDir } from '../core/paths.js';
import { Errors } from '../core/errors.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonResult } from '../core/types.js';
import { ok } from './json.js';

async function requireRepo(cwd?: string): Promise<void> {
  if (!(await insideWorkTree(cwd))) throw Errors.notARepo(cwd);
}

/** All identities as potential co-author Authors. */
async function identityAuthors(): Promise<{ id: string; author: Author }[]> {
  const { identities } = await listIdentities();
  return identities.map((i) => ({
    id: `${i.name} <${i.email}>`,
    author: new Author(genKey(i.name, i.email), i.name, i.email),
  }));
}

/** Resolve an email or identity ID to an Author. */
async function resolveCoAuthor(arg: string): Promise<Author> {
  const all = await identityAuthors();
  const lower = arg.toLowerCase();
  const found = all.find(({ id, author }) => author.email.toLowerCase() === lower || id === arg);
  if (!found) throw Errors.authorNotFound(arg);
  return found.author;
}

// --- global co-authors (machine-level, applies to every repo) ---

const globalCoAuthorsPath = (): string => join(dataDir(), 'global-coauthors.json');

async function readGlobal(): Promise<Author[]> {
  try {
    const txt = await readFile(globalCoAuthorsPath(), 'utf8');
    const arr = JSON.parse(txt) as { name: string; email: string }[];
    return arr.map((a) => new Author(genKey(a.name, a.email), a.name, a.email));
  } catch {
    return [];
  }
}

async function writeGlobal(authors: Author[]): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(globalCoAuthorsPath(), JSON.stringify(authors.map((a) => ({ name: a.name, email: a.email })), null, 2) + '\n', 'utf8');
}

// --- one-shot (next commit only) ---

async function setOneshot(authors: Author[], cwd?: string): Promise<void> {
  // store in local config — the extension and CLI both check this
  await unsetConfig('colabor.oneshot', 'local', cwd);
  for (const a of authors) {
    await setConfig('colabor.oneshot', a.toString(), 'local', cwd);
  }
}

async function getOneshot(cwd?: string): Promise<Author[]> {
  const raw = await getAllConfig('colabor.oneshot', 'local', cwd);
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*)\s<(.+)>$/);
      return m ? new Author(genKey(m[1], m[2]), m[1], m[2]) : null;
    })
    .filter((a): a is Author => !!a);
}


// --- public commands ---

/**
 * `git colabor coauthor add <email|id> [--always] [--global]`
 *
 * Modes:
 *   default  — one-shot: trailer applies to the NEXT commit only
 *              (stored in `colabor.oneshot` local config, auto-cleared)
 *   --always — permanent for THIS repo (`colabor.selected` + commit template)
 *   --global — for ALL repos (machine-level `global-coauthors.json`)
 */
export async function add(
  args: string[],
  opts: { always?: boolean; global?: boolean },
  cwd?: string,
): Promise<JsonResult> {
  const emailOrId = args[0];
  if (!emailOrId) throw Errors.usage('git colabor coauthor add <email|id> [--always] [--global]');
  const author = await resolveCoAuthor(emailOrId);

  if (opts.global) {
    const globals = await readGlobal();
    if (!globals.some((a) => a.email.toLowerCase() === author.email.toLowerCase())) {
      globals.push(author);
      await writeGlobal(globals);
    }
    return ok({ added: { name: author.name, email: author.email }, mode: 'global' });
  }

  await requireRepo(cwd);

  if (opts.always) {
    const current = await getSelected(cwd);
    if (!current.some((a) => a.email.toLowerCase() === author.email.toLowerCase())) {
      current.push(author);
      await setSelected(current, cwd);
    }
    return ok({ added: { name: author.name, email: author.email }, mode: 'always' });
  }

  // default: one-shot
  const oneshot = await getOneshot(cwd);
  if (!oneshot.some((a) => a.email.toLowerCase() === author.email.toLowerCase())) {
    oneshot.push(author);
    await setOneshot(oneshot, cwd);
  }
  return ok({ added: { name: author.name, email: author.email }, mode: 'oneshot' });
}

/**
 * `git colabor coauthor rm <email|id>` — remove from ALL scopes
 * (oneshot, always/selected, and global).
 */
export async function rm(args: string[], cwd?: string): Promise<JsonResult> {
  const emailOrId = args[0];
  if (!emailOrId) throw Errors.usage('git colabor coauthor rm <email|id>');
  const target = await resolveCoAuthor(emailOrId);
  const lower = target.email.toLowerCase();
  const removedFrom: string[] = [];

  // remove from global
  const globals = await readGlobal();
  const newGlobals = globals.filter((a) => a.email.toLowerCase() !== lower);
  if (newGlobals.length !== globals.length) {
    await writeGlobal(newGlobals);
    removedFrom.push('global');
  }

  // remove from repo-scoped (always)
  try {
    await requireRepo(cwd);
    const selected = await getSelected(cwd);
    const newSelected = selected.filter((a) => a.email.toLowerCase() !== lower);
    if (newSelected.length !== selected.length) {
      await setSelected(newSelected, cwd);
      removedFrom.push('repo');
    }
    // remove from one-shot
    const oneshot = await getOneshot(cwd);
    const newOneshot = oneshot.filter((a) => a.email.toLowerCase() !== lower);
    if (newOneshot.length !== oneshot.length) {
      await setOneshot(newOneshot, cwd);
      removedFrom.push('oneshot');
    }
  } catch {
    // not in a repo — global removal is enough
  }

  return ok({ removed: { name: target.name, email: target.email }, from: removedFrom });
}

/**
 * `git colabor coauthor ls [filter]` — list BOTH available (from identities)
 * and currently active co-authors, grouped by scope.
 */
export async function ls(args: string[], cwd?: string): Promise<JsonResult> {
  const filter = args[0]?.toLowerCase();
  const all = await identityAuthors();
  const available = (filter
    ? all.filter(({ author }) =>
        author.name.toLowerCase().includes(filter) || author.email.toLowerCase().includes(filter))
    : all
  ).map(({ author }) => ({ name: author.name, email: author.email }));

  const selected: { name: string; email: string; mode: string }[] = [];
  // global
  for (const a of await readGlobal()) {
    selected.push({ name: a.name, email: a.email, mode: 'global' });
  }
  // repo-scoped
  try {
    for (const a of await getSelected(cwd)) {
      if (!selected.some((s) => s.email === a.email)) {
        selected.push({ name: a.name, email: a.email, mode: 'repo' });
      }
    }
    for (const a of await getOneshot(cwd)) {
      if (!selected.some((s) => s.email === a.email)) {
        selected.push({ name: a.name, email: a.email, mode: 'oneshot' });
      }
    }
  } catch {
    // not in a repo
  }

  return ok({ available, selected });
}

/** `git colabor coauthor print` — output the trailer blob for all active co-authors. */
export async function print(_opts: { initials: boolean }, cwd?: string): Promise<JsonResult> {
  const active: Author[] = [
    ...await readGlobal(),
    ...await getSelected(cwd).catch(() => [] as Author[]),
    ...await getOneshot(cwd).catch(() => [] as Author[]),
  ];
  // dedupe by email
  const seen = new Set<string>();
  const deduped = active.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return ok({ text: printTrailers(deduped) });
}

/** `git colabor coauthor suggest [filter]` (JSON: return candidates from repo history). */
export async function suggest(args: string[], cwd?: string): Promise<JsonResult> {
  await requireRepo(cwd);
  const candidates = await repoAuthors(args[0], cwd);
  if (candidates.length === 0) {
    return ok({ candidates: [], added: [] }, [{ code: 'none', message: 'no contributors found' }]);
  }
  return ok({ candidates: candidates.map((a) => ({ key: a.key, name: a.name, email: a.email })), added: [] });
}
