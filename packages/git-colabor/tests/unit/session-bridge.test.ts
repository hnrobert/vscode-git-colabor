import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { askpassEndpointKind } from '../../src/core/secrets/session-bridge.js';

describe('askpassEndpointKind', () => {
  const dir = '/data/git-colabor';
  // assembled piece by piece so the test cannot repeat an escaping slip in the source
  const pipe = '\\\\' + ['.', 'pipe', 'git-colabor-askpass-ext_ab12'].join('\\');

  it('accepts our socket file in the data dir on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(askpassEndpointKind(dir, join(dir, 'askpass-ext_ab12.sock'), platform)).toBe('socket');
    }
  });

  it('accepts our named pipe on Windows only (Node has no filesystem sockets there)', () => {
    expect(askpassEndpointKind(dir, pipe, 'win32')).toBe('pipe');
    expect(askpassEndpointKind(dir, pipe, 'linux')).toBeUndefined();
    expect(askpassEndpointKind(dir, pipe, 'darwin')).toBeUndefined();
  });

  it('refuses everything else — never removed, never connected to', () => {
    // outside our dir
    expect(askpassEndpointKind(dir, join(dir, '..', 'askpass-x.sock'), 'win32')).toBeUndefined();
    // inside our dir but not our naming pattern
    expect(askpassEndpointKind(dir, join(dir, 'not-ours.sock'), 'win32')).toBeUndefined();
    // another program's pipe
    expect(askpassEndpointKind(dir, '\\\\' + ['.', 'pipe', 'other-app-askpass-ext_ab12'].join('\\'), 'win32')).toBeUndefined();
    // no endpoint at all
    expect(askpassEndpointKind(dir, undefined, 'win32')).toBeUndefined();
    expect(askpassEndpointKind(dir, 42, 'win32')).toBeUndefined();
  });
});
