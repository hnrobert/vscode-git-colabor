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
};

export type ParsedQuery = { kind: 'login'; login: string } | { kind: 'email'; email: string };

/** Detect the input shape: profile URL, @handle, login, or email. */
export function parseGitHubQuery(raw: string): ParsedQuery | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  // a noreply address resolves straight back to the login
  const noreply = s.match(/^(\d+)\+([^@+]+)@users\.noreply\.github\.com$/i);
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

/** Email search only matches PUBLIC profile emails — the noreply address is
 * still derived for every hit so a "private" identity email is always offered. */
async function byEmail(email: string): Promise<IdentityCandidate[]> {
  const search = await ghFetch<{ items: { login: string }[] }>(
    `/search/users?q=${encodeURIComponent(`${email} in:email`)}&per_page=5`,
  );
  if (!search || search.items.length === 0) return [];
  const users = await Promise.all(search.items.map((i) => getUser(i.login)));
  return users
    .filter((u): u is GitHubUser => !!u)
    .map(asCandidate)
    .map((c) =>
      // the searched email is public information — surface it as the public one
      c.user.publicEmail?.toLowerCase() === email.toLowerCase() ? c : { ...c, publicEmail: email },
    );
}

export async function searchCandidates(query: ParsedQuery): Promise<IdentityCandidate[]> {
  return query.kind === 'login' ? byLogin(query.login) : byEmail(query.email);
}
