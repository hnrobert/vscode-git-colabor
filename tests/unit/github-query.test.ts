import { describe, expect, it } from 'vitest';
import { parseGitHubQuery } from '../../src/github/users.js';

describe('parseGitHubQuery', () => {
  it('parses profile URLs (scheme, www, trailing slash)', () => {
    expect(parseGitHubQuery('https://github.com/hnrobert')).toEqual({ kind: 'login', login: 'hnrobert' });
    expect(parseGitHubQuery('github.com/hnrobert/')).toEqual({ kind: 'login', login: 'hnrobert' });
    expect(parseGitHubQuery('www.github.com/octocat')).toEqual({ kind: 'login', login: 'octocat' });
  });

  it('parses @handle and bare login', () => {
    expect(parseGitHubQuery('@octocat')).toEqual({ kind: 'login', login: 'octocat' });
    expect(parseGitHubQuery('octo-cat')).toEqual({ kind: 'login', login: 'octo-cat' });
  });

  it('parses a noreply address back to the login', () => {
    expect(parseGitHubQuery('583231+octocat@users.noreply.github.com')).toEqual({
      kind: 'login',
      login: 'octocat',
    });
  });

  it('parses plain and noreply-looking emails as email queries', () => {
    expect(parseGitHubQuery('me@example.com')).toEqual({ kind: 'email', email: 'me@example.com' });
    expect(parseGitHubQuery('someone@users.noreply.github.comX')).toEqual({
      kind: 'email',
      email: 'someone@users.noreply.github.comX',
    });
  });

  it('rejects empty and garbage input', () => {
    expect(parseGitHubQuery('')).toBeUndefined();
    expect(parseGitHubQuery('   ')).toBeUndefined();
    expect(parseGitHubQuery('https://gitlab.com/foo')).toBeUndefined();
    expect(parseGitHubQuery('not a query!!')).toBeUndefined();
  });
});
