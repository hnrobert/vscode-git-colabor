import { describe, it, expect } from 'vitest';
import { parseCommandArgs, parseGlobals } from '../../src/cli/parse-args.js';

describe('parseGlobals', () => {
  it('extracts globals and leaves the rest in order', () => {
    const { flags, rest } = parseGlobals(['--json', 'coauthor', 'use', 'jd']);
    expect(flags.json).toBe(true);
    expect(rest).toEqual(['coauthor', 'use', 'jd']);
  });

  it('-C takes the next token', () => {
    const { flags, rest } = parseGlobals(['-C', '/tmp', 'coauthor', 'ls']);
    expect(flags.cwd).toBe('/tmp');
    expect(rest).toEqual(['coauthor', 'ls']);
  });

  it('-C attached form', () => {
    expect(parseGlobals(['-C/tmp', 'coauthor', 'ls']).flags.cwd).toBe('/tmp');
  });

  it('--log-level=value', () => {
    const { flags, rest } = parseGlobals(['--log-level=debug', 'coauthor', 'ls']);
    expect(flags.logLevel).toBe('debug');
    expect(rest).toEqual(['coauthor', 'ls']);
  });

  it('-- terminator keeps the rest as positional', () => {
    const { rest } = parseGlobals(['coauthor', 'add', '--', '-n', 'Name', 'e@x.com']);
    expect(rest).toEqual(['coauthor', 'add', '-n', 'Name', 'e@x.com']);
  });
});

describe('parseCommandArgs', () => {
  it('positionals only', () => {
    expect(parseCommandArgs(['jd', 'ea']).positionals).toEqual(['jd', 'ea']);
  });

  it('value flags (space and = forms)', () => {
    const p = parseCommandArgs(['--name', 'Alice', '--email=b@x.com'], {
      valueFlags: ['--name', '--email'],
    });
    expect(p.values['--name']).toBe('Alice');
    expect(p.values['--email']).toBe('b@x.com');
    expect(p.positionals).toEqual([]);
  });

  it('bool flags', () => {
    const p = parseCommandArgs(['-i'], { boolFlags: ['-i'] });
    expect(p.bools.has('-i')).toBe(true);
  });

  it('unknown dash tokens are treated as bool', () => {
    const p = parseCommandArgs(['--unknown']);
    expect(p.bools.has('--unknown')).toBe(true);
  });
});
