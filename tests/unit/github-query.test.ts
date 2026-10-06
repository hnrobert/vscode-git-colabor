import { describe, expect, it } from 'vitest';
import { aggregateCommitHits, parseGitHubQuery } from '../../src/github/users.js';

describe('parseGitHubQuery', () => {
  it('parses profile URLs (scheme, www, trailing slash)', () => {
    expect(parseGitHubQuery('https://github.com/hnrobert')).toEqual({ kind: 'login', login: 'hnrobert' });
    expect(parseGitHubQuery('github.com/hnrobert/')).toEqual({ kind: 'login', login: 'hnrobert' });
    expect(parseGitHubQuery('www.github.com/hnrobert')).toEqual({ kind: 'login', login: 'hnrobert' });
  });

  it('parses @handle and bare login', () => {
    expect(parseGitHubQuery('@hnrobert')).toEqual({ kind: 'login', login: 'hnrobert' });
    expect(parseGitHubQuery('octo-cat')).toEqual({ kind: 'login', login: 'octo-cat' });
  });

  it('parses a noreply address back to the login', () => {
    expect(parseGitHubQuery('583231+hnrobert@users.noreply.github.com')).toEqual({
      kind: 'login',
      login: 'hnrobert',
    });
    // old login-only noreply format
    expect(parseGitHubQuery('alice@users.noreply.github.com')).toEqual({ kind: 'login', login: 'alice' });
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

describe('aggregateCommitHits', () => {
  const hit = (login: string | null, repo: string, date: string) => ({
    author: login ? { login } : null,
    commit: { author: { date } },
    repository: { full_name: repo },
  });

  it('counts commits, distinct repos, and last-seen per login; skips unlinked commits', () => {
    const agg = aggregateCommitHits([
      hit('alice', 'a/repo', '2026-09-01T00:00:00Z'),
      hit('alice', 'a/repo', '2026-08-01T00:00:00Z'),
      hit('alice', 'other/repo', '2025-01-01T00:00:00Z'),
      hit('alice-dev', 'a/repo', '2023-04-05T00:00:00Z'),
      hit(null, 'a/repo', '2026-09-20T00:00:00Z'), // not linked to an account
    ]);
    expect(agg.size).toBe(2);
    expect(agg.get('alice')).toMatchObject({ commits: 3, repos: new Set(['a/repo', 'other/repo']), lastSeen: '2026-09-01T00:00:00Z' });
    expect(agg.get('alice-dev')).toMatchObject({ commits: 1, repos: new Set(['a/repo']), lastSeen: '2023-04-05T00:00:00Z' });
  });
});
