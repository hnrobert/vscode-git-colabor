// Copies the built git-colabor CLI bundle (cli.cjs + askpass.cjs) from the git-colabor
// submodule into this extension's resources/ dir, so the extension can spawn it via
// process.execPath without relying on the remote host's $PATH.
import { access, cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, '..');
const cliDist = resolve(extRoot, 'git-colabor/dist');
const dest = resolve(extRoot, 'resources');
const files = ['cli.cjs', 'askpass.cjs'];

await mkdir(dest, { recursive: true });
const missing = [];
for (const f of files) {
  const from = join(cliDist, f);
  try {
    await access(from);
  } catch {
    missing.push(f);
    continue;
  }
  await cp(from, join(dest, f));
  console.log(`[copy-cli] resources/${f}  ←  ${from}`);
}
if (missing.length > 0) {
  console.error(`[copy-cli] CLI bundle missing — run \`pnpm -C git-colabor build\` first: ${missing.join(', ')}`);
  process.exit(1);
}
