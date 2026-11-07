import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sweepSessionFiles } from '../../src/askpass/AskpassServer.js';

let dir: string;
let prevXdg: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ca-sweep-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
});

afterAll(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(dir, { recursive: true, force: true });
});

/** a pid that is definitely dead: a child that already exited */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  return r.pid ?? 999999;
}

describe('sweepSessionFiles', () => {
  it('removes dead-session descriptors + their sockets + orphan socks, keeps live ones', async () => {
    const dead = deadPid();
    const deadSock = join(dir, 'askpass-ext_dead1234.sock');
    const liveSock = join(dir, `askpass-ext_${process.pid}.sock`);
    const orphanSock = join(dir, 'askpass-ext_orphan99.sock');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `session-${dead}.json`), JSON.stringify({ sessionId: 'x', socketPath: deadSock, token: 't', pid: dead }));
    await writeFile(join(dir, `session-${process.pid}.json`), JSON.stringify({ sessionId: 'me', socketPath: liveSock, token: 't', pid: process.pid }));
    await writeFile(deadSock, '');
    await writeFile(liveSock, '');
    await writeFile(orphanSock, '');
    // a session file with no pid (pre-pid leftovers) cannot be proven live — swept
    await writeFile(join(dir, 'session-unknown.json'), JSON.stringify({ sessionId: 'u', token: 't' }));

    const removed = await sweepSessionFiles(dir);

    const left = new Set(await readdir(dir));
    expect(removed.sessions).toBe(2); // the dead one + the no-pid one
    expect(left.has(`session-${process.pid}.json`)).toBe(true); // live session survives
    expect(left.has(`session-${dead}.json`)).toBe(false); // dead session removed
    expect(left.has(basename(liveSock))).toBe(true); // its socket survives
    expect(left.has(basename(deadSock))).toBe(false); // dead session's socket removed
    expect(left.has(basename(orphanSock))).toBe(false); // crash leftover removed
  });

  it('never unlinks a socket path outside its own naming/dir (corrupted descriptor)', async () => {
    const outside = join(dir, '..', 'precious.sock');
    const dead = deadPid();
    await writeFile(join(dir, `session-${dead}.json`), JSON.stringify({ socketPath: outside, token: 't', pid: dead }));
    const removed = await sweepSessionFiles(dir);
    expect(removed.sessions).toBe(1);
    expect(removed.sockets).toBe(0); // the outside path was NOT touched
  });
});

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}
