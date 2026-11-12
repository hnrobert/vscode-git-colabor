import { writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Atomically write JSON to `path` (tmp + rename). Optional file mode (e.g. 0o600). */
export async function atomicWriteJson(path: string, data: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  if (mode !== undefined) {
    await chmod(tmp, mode).catch(() => {});
  }
  await rename(tmp, path);
}
