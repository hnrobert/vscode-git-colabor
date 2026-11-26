import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskpassServer, askpassEndpoint, askpassEndpointKind, colaborDir } from '../../src/askpass/AskpassServer.js';

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

describe('askpass endpoint (per platform)', () => {
  // assembled piece by piece so the test cannot repeat an escaping slip in the source
  const winPipe = '\\\\' + ['.', 'pipe', 'git-colabor-askpass-ext_ab12'].join('\\');

  it('is a named pipe on Windows — Node has no filesystem sockets there', () => {
    expect(askpassEndpoint('ext_ab12', 'win32')).toBe(winPipe);
    expect(winPipe.startsWith('\\\\.\\pipe\\')).toBe(true);
  });

  it('is a socket file inside the data dir everywhere else', () => {
    expect(askpassEndpoint('ext_ab12', 'darwin')).toBe(join(colaborDir('darwin'), 'askpass-ext_ab12.sock'));
    expect(askpassEndpoint('ext_ab12', 'linux')).toBe(join(colaborDir('linux'), 'askpass-ext_ab12.sock'));
  });

  it('classifies our socket file and our pipe as ours — nothing else', () => {
    const dir = colaborDir('darwin');
    expect(askpassEndpointKind(dir, join(dir, 'askpass-ext_ab12.sock'))).toBe('socket');
    expect(askpassEndpointKind(dir, askpassEndpoint('ext_ab12', 'win32'), 'win32')).toBe('pipe');
    // a pipe descriptor has no business on a socket platform
    expect(askpassEndpointKind(dir, askpassEndpoint('ext_ab12', 'win32'), 'darwin')).toBeUndefined();
    // outside our dir / not our naming pattern / absent
    expect(askpassEndpointKind(dir, join(dir, '..', 'askpass-x.sock'))).toBeUndefined();
    expect(askpassEndpointKind(dir, join(dir, 'not-ours.sock'))).toBeUndefined();
    expect(askpassEndpointKind(dir, undefined)).toBeUndefined();
  });

  it('the server listens on the platform endpoint', async () => {
    server = new AskpassServer({ sessionId: 'ext_ab12', secretLookup: async () => undefined, log: fakeLog });
    const info = await server.start();
    expect(info.socketPath).toBe(askpassEndpoint('ext_ab12'));
    expect(askpassEndpointKind(colaborDir(), info.socketPath)).toBe('socket');
  });
});
