import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The minimum of the `vscode` module the tree provider touches on a reload —
// enough to run the REAL provider through "CLI fails, fails, recovers".
vi.mock('vscode', () => {
  class TreeItem {
    label: string;
    contextValue?: string;
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    command?: unknown;
    constructor(label: string) {
      this.label = label;
    }
  }
  class EventEmitter<T> {
    listeners: Array<(v: T) => void> = [];
    event = (l: (v: T) => void): { dispose(): void } => {
      this.listeners.push(l);
      return { dispose() {} };
    };
    fire(v: T): void {
      this.listeners.forEach((l) => l(v));
    }
  }
  // constructed with (id, color?) / (id) — the real ones store what the tree renders
  return {
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {},
    ThemeColor: class {},
    EventEmitter,
  };
});

import { IdentityTreeProvider } from '../../src/tree/IdentityTreeProvider.js';
import type { CliClient } from '../../src/cli/CliClient.js';
import type { GitApi } from '../../src/git-ext/GitApi.js';

const FAILED = {
  ok: false as const,
  error: { code: 'GIT_NOT_FOUND', message: 'spawn git ENOENT', exitCode: 1 },
  data: null,
};
const OK_STATUS = {
  ok: true as const,
  data: {
    repo: '/r',
    inRepo: true,
    signing: { enabled: false, key: null, format: 'openpgp', scope: null, origin: null },
    activeIdentity: null,
    identities: [],
    configIdentities: { repo: null, global: null },
    selected: [],
    available: [],
  },
};

/** a provider whose `identity status` fails for the first N calls, then answers */
function harness(failures: number) {
  let statusCalls = 0;
  const cli = {
    run: async (args: string[]) => {
      if (args[0] === 'identity' && args[1] === 'status') {
        statusCalls++;
        return statusCalls <= failures ? FAILED : OK_STATUS;
      }
      return { ok: true, data: { candidates: [], added: [] } }; // coauthor suggest / identity import
    },
  };
  const git = { selectedRepoRoot: () => '/r', hasRepositories: true, api: {}, repoRoots: ['/r'] };
  const provider = new IdentityTreeProvider(cli as unknown as CliClient, git as unknown as GitApi);
  return { provider, calls: () => statusCalls };
}

describe('IdentityTreeProvider — reload retry while the CLI fails', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the cause, retries every 5 s, and stops at the first success', async () => {
    const { provider, calls } = harness(2);

    await provider.reload();
    expect(calls()).toBe(1);
    expect(provider.current).toBeUndefined();
    // the view says WHY it is empty instead of rendering nothing
    const rows = await provider.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Cannot read repository status — retrying');
    expect(rows[0].description).toBe('GIT_NOT_FOUND: spawn git ENOENT');

    // not before 5 s …
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls()).toBe(1);
    // … then exactly one attempt per interval
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2);
    expect(provider.current).toBeUndefined(); // still failing → still the error row
    expect(await provider.getChildren()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toBe(3); // this one succeeds
    expect(provider.current?.repo).toBe('/r');

    // healthy → nothing left to retry, however long we wait
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls()).toBe(3);
  });

  it('a failing CLI never exceeds one attempt per interval', async () => {
    const { provider, calls } = harness(Number.MAX_SAFE_INTEGER);
    await provider.reload();
    // UI refreshes keep arriving and keep failing inside the same interval
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await provider.reload();
    }
    expect(calls()).toBe(7); // the UI-driven ones only — no extra retries yet
    await vi.advanceTimersByTimeAsync(1_000); // t = 4 s: still nothing
    expect(calls()).toBe(7);
    await vi.advanceTimersByTimeAsync(1_000); // t = 5 s: the ONE scheduled retry
    expect(calls()).toBe(8);
  });

  it('dispose() drops a pending retry', async () => {
    const { provider, calls } = harness(Number.MAX_SAFE_INTEGER);
    await provider.reload();
    provider.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(1);
  });
});
