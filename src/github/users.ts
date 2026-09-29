/**
 * GitHub user lookup for the Add Identity flow — pure fetch + parse, no
 * vscode imports. Unauthenticated GitHub REST (60 req/h per IP), which is
 * fine for a manual add flow. All input shapes are auto-detected:
 * profile URL / `@handle` / bare login / email (incl. a noreply address).
 */

export type GitHubUser = {
  login: string;
  id: number;
  /** display name (login fallback applied by callers) */
  name?: string;
  /** public profile email, null when hidden */
  publicEmail?: string;
};

export type IdentityCandidate = {
  user: GitHubUser;
  /** derived private address: `${id}+${login}@users.noreply.github.com` */
  noreplyEmail: string;
  publicEmail?: string;
  /** public-activity evidence from GitHub commit attribution (email search) */
  stats?: { commits: number; repos: number; lastSeen?: string };
  /**
   * The searched email when ONLY commit attribution bound it (the user's
   * bound-but-not-public address) — rendered as "private email". When the
   * address is also the public profile email, `publicEmail` carries it
   * instead and this stays undefined.
   */
  attributedEmail?: string;
};

export type ParsedQuery = { kind: 'login'; login: string } | { kind: 'email'; email: string };

/** Detect the input shape: profile URL, @handle, login, or email. */
export function parseGitHubQuery(raw: string): ParsedQuery | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  // a noreply address resolves straight back to the login (new id+login and old login-only formats)
  const noreply = s.match(/^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/i);
  if (noreply) return { kind: 'login', login: noreply[2] };
  // @handle must be checked before the generic email branch (it contains @)
  const handle = s.match(/^@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/);
  if (handle) return { kind: 'login', login: handle[1] };
  if (s.includes('@')) return { kind: 'email', email: s };
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/?$/i);
  if (url) return { kind: 'login', login: url[1] };
  const bare = s.match(/^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/);
  if (bare) return { kind: 'login', login: bare[1] };
  return undefined;
}

const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vscode-git-colabor',
};

async function ghFetch<T>(path: string): Promise<T | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const res = await fetch(`https://api.github.com${path}`, { headers: GH_HEADERS, signal: abort.signal });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type GhUserResponse = { id: number; login: string; name: string | null; email: string | null };

async function getUser(login: string): Promise<GitHubUser | undefined> {
  const u = await ghFetch<GhUserResponse>(`/users/${encodeURIComponent(login)}`);
  if (!u) return undefined;
  return { login: u.login, id: u.id, name: u.name ?? undefined, publicEmail: u.email ?? undefined };
}

const asCandidate = (user: GitHubUser): IdentityCandidate => ({
  user,
  noreplyEmail: `${user.id}+${user.login}@users.noreply.github.com`,
  publicEmail: user.publicEmail,
});

/** Exact user, else login-prefix search results (details enriched for the top 5). */
async function byLogin(login: string): Promise<IdentityCandidate[]> {
  const exact = await getUser(login);
  if (exact) return [asCandidate(exact)];
  const search = await ghFetch<{ items: { login: string }[] }>(
    `/search/users?q=${encodeURIComponent(login)}&per_page=5`,
  );
  if (!search || search.items.length === 0) return [];
  const users = await Promise.all(search.items.map((i) => getUser(i.login)));
  return users.filter((u): u is GitHubUser => !!u).map(asCandidate);
}

/** Aggregate commit-search items into per-login stats (pure — unit-tested). */
export type RawCommitHit = {
  author: { login: string } | null;
  commit: { author: { date?: string } };
  repository: { full_name: string };
};

export function aggregateCommitHits(items: RawCommitHit[]): Map<string, { commits: number; repos: Set<string>; lastSeen?: string }> {
  const byLogin = new Map<string, { commits: number; repos: Set<string>; lastSeen?: string }>();
  for (const it of items) {
    const login = it.author?.login;
    if (!login) continue; // commit not linked to a GitHub account
    const agg = byLogin.get(login) ?? { commits: 0, repos: new Set<string>(), lastSeen: undefined };
    agg.commits += 1;
    agg.repos.add(it.repository.full_name);
    if (it.commit.author.date && (!agg.lastSeen || it.commit.author.date > agg.lastSeen)) {
      agg.lastSeen = it.commit.author.date;
    }
    byLogin.set(login, agg);
  }
  return byLogin;
}

/**
 * Email resolution runs TWO independent resolvers:
 *  1. user search `in:email` — only matches PUBLIC profile emails;
 *  2. commit search `author-email:` — finds accounts whose PUBLIC COMMITS in
 *     any repo used this email (works even when the profile email is private,
 *     via GitHub's commit attribution). Each leg degrades independently.
 * Commit-attribution hits carry stats; the searched email itself is offered
 * for them (publicly evidenced by those commits).
 */
async function byEmail(email: string): Promise<IdentityCandidate[]> {
  const [profileHits, commitSearch] = await Promise.allSettled([
    ghFetch<{ items: { login: string }[] }>(
      `/search/users?q=${encodeURIComponent(`${email} in:email`)}&per_page=5`,
    ),
    ghFetch<{ items: RawCommitHit[] }>(
      `/search/commits?q=${encodeURIComponent(`author-email:${email}`)}&sort=author-date&order=desc&per_page=100`,
    ),
  ]);

  const candidates = new Map<string, IdentityCandidate>();

  if (profileHits.status === 'fulfilled' && profileHits.value?.items.length) {
    const users = await Promise.all(profileHits.value.items.slice(0, 5).map((i) => getUser(i.login)));
    for (const u of users) {
      if (u) candidates.set(u.login, { ...asCandidate(u), publicEmail: email });
    }
  }

  if (commitSearch.status === 'fulfilled' && commitSearch.value?.items.length) {
    const stats = aggregateCommitHits(commitSearch.value.items);
    const ranked = [...stats.entries()].sort((a, b) => b[1].commits - a[1].commits).slice(0, 5);
    for (const [login, agg] of ranked) {
      if (candidates.has(login)) {
        // already a profile hit — attach the stats as extra evidence
        candidates.get(login)!.stats = { commits: agg.commits, repos: agg.repos.size, lastSeen: agg.lastSeen };
        continue;
      }
      const u = await getUser(login);
      if (u) {
        const isPublicProfileEmail = u.publicEmail?.toLowerCase() === email.toLowerCase();
        candidates.set(u.login, {
          ...asCandidate(u),
          // the searched email is commit-attributed; only "public" if it is
          // also the visible profile email, otherwise a private bound address
          ...(isPublicProfileEmail ? {} : { attributedEmail: email }),
          stats: { commits: agg.commits, repos: agg.repos.size, lastSeen: agg.lastSeen },
        });
      }
    }
  }

  return [...candidates.values()];
}

export async function searchCandidates(query: ParsedQuery): Promise<IdentityCandidate[]> {
  return query.kind === 'login' ? byLogin(query.login) : byEmail(query.email);
}
