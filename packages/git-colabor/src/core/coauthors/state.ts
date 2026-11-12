import { addConfigValue, getAllConfig, unsetAllConfig } from '../git/config.js';
import { Author } from '../authors/types.js';
import { writeCoAuthorsToTemplate, clearTemplate, ensureCommitTemplate } from '../message/template.js';

/** Per-repo selected co-authors, stored as a local multi-value git config key. */
const KEY = 'colabor.selected';
const LINE_RE = /^(.*)\s<([^>]+)>$/;

export async function getSelected(cwd?: string): Promise<Author[]> {
  const raw = (await getAllConfig(KEY, 'local', cwd))
    .split(/\r?\n/)
    .filter(Boolean);
  if (raw.length === 0) return [];
  const out: Author[] = [];
  for (const line of raw) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    out.push(new Author(m[2].split('@')[0] || 'co', m[1].trim(), m[2].trim()));
  }
  return out;
}

/** Replace the per-repo selection and refresh the commit template (dual local/global). */
export async function setSelected(authors: Author[], cwd?: string): Promise<void> {
  await unsetAllConfig(KEY, 'local', cwd);
  for (const a of authors) await addConfigValue(KEY, a.toString(), 'local', cwd);
  await ensureCommitTemplate(cwd);
  await writeCoAuthorsToTemplate(authors, cwd);
}

export async function clearSelected(cwd?: string): Promise<void> {
  await unsetAllConfig(KEY, 'local', cwd);
  await ensureCommitTemplate(cwd);
  await clearTemplate(cwd);
}
