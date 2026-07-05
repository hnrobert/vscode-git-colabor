import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskpassServer } from '../../src/askpass/AskpassServer.js';

const fakeLog = { info(_m: string) {}, warn(_m: string) {}, error(_m: string) {} };
let server: AskpassServer | undefined;

let tmpConfig: string;
let prevXdg: string | undefined;

beforeAll(async () => {
  // isolate the socket dir away from the real ~/.config/git-colabor
  tmpConfig = await mkdtemp(join(tmpdir(), 'ca-askpass-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpConfig;
});

afterAll(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(tmpConfig, { recursive: true, force: true });
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

function query(socketPath: string, payload: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath, () => sock.write(JSON.stringify(payload) + '\n'));
    let data = '';
    sock.on('data', (d) => (data += d.toString('utf8')));
    sock.on('error', reject);
    sock.on('close', () => resolve(data));
  });
}

describe('AskpassServer', () => {
  it('returns the passphrase for a valid token + fingerprint', async () => {
    server = new AskpassServer({
      sessionId: 's1',
      secretLookup: async (fp) => (fp === 'SHA256:abc' ? 's3cret-pass' : undefined),
      log: fakeLog,
    });
    const info = await server.start();
    const resp = await query(info.socketPath, { token: info.token, fingerprint: 'SHA256:abc' });
    expect(resp).toBe('s3cret-pass');
  });

  it('returns empty for a wrong token (helper falls through)', async () => {
    server = new AskpassServer({
      sessionId: 's2',
      secretLookup: async () => 'should-not-reach',
      log: fakeLog,
    });
    const info = await server.start();
    const resp = await query(info.socketPath, { token: 'wrong-token', fingerprint: 'SHA256:abc' });
    expect(resp).toBe('');
  });

  it('returns empty for an unknown fingerprint', async () => {
    server = new AskpassServer({
      sessionId: 's3',
      secretLookup: async () => undefined,
      log: fakeLog,
    });
    const info = await server.start();
    const resp = await query(info.socketPath, { token: info.token, fingerprint: 'SHA256:missing' });
    expect(resp).toBe('');
  });
});
