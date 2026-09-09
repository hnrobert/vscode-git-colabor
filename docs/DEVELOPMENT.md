# Development Guide

How to build, test, package, and release Git Colabor. For the problem statement see [REQUIREMENTS.md](REQUIREMENTS.md); for how the pieces fit together see [ARCHITECTURE.md](ARCHITECTURE.md).

## Table of contents

- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Build pipeline](#build-pipeline)
- [Tests](#tests)
- [Debugging in VS Code](#debugging-in-vs-code)
- [Packaging the extension](#packaging-the-extension)
- [Publishing](#publishing)
- [Submodule workflow](#submodule-workflow)

## Repository layout

```text
vscode-git-colabor/          # ← this repo IS the extension package (flattened)
├── src/                     # extension TypeScript sources
│   ├── cli/CliClient.ts     # spawns the bundled CLI, parses --json
│   ├── askpass/AskpassServer.ts
│   ├── secrets/Secrets.ts
│   ├── git-ext/GitApi.ts
│   ├── tree/, statusbar/, scm/, reconcile/
│   ├── commands.ts, config.ts, log.ts, types.ts, extension.ts
├── git-colabor/             # git SUBMODULE — the CLI (standalone npm package)
│   └── src/{cli,core,askpass}/
├── build-scripts/copy-cli.mjs   # copies built CLI into resources/
├── resources/               # bundled CLI at build time (gitignored artifacts)
│   ├── cli.cjs
│   └── askpass.cjs
├── dist/extension.cjs       # bundled extension (build artifact)
├── tests/unit/              # extension unit tests (vitest)
└── docs/                    # this documentation set
```

The two packages are **independent pnpm projects** — there is no workspace relationship; the extension consumes the CLI's *built output*, not its package.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 24** | Both `tsup` configs target `node24` |
| pnpm | 10.x | `packageManager: pnpm@10.13.1`; use `corepack enable` |
| Git | any recent | submodule support required |
| VS Code | >= 1.83 | matches `engines.vscode` |

## Setup

```bash
git clone --recurse-submodules git@github.com:hnrobert/vscode-git-colabor.git
cd vscode-git-colabor

pnpm install                  # extension dependencies (root)
pnpm -C git-colabor install   # CLI dependencies (submodule, standalone)

pnpm build                    # one-shot build (see below)
```

## Build pipeline

```bash
pnpm build
```

runs three stages in order:

1. **`build:cli`** — `pnpm -C git-colabor build` → `tsup` bundles the CLI submodule to `git-colabor/dist/{cli,index,askpass}.cjs` (CJS, zero runtime dependencies, everything inlined via `noExternal`).
2. **`tsup`** (root) — bundles `src/extension.ts` to `dist/extension.cjs` (CJS, `vscode` marked external, tree-shaken).
3. **`copy-cli`** — `node build-scripts/copy-cli.mjs` copies `git-colabor/dist/cli.cjs` and `askpass.cjs` into `resources/`, which is what the extension actually spawns at runtime.

`resources/*.cjs` and `dist/` are gitignored build artifacts — always run `pnpm build` after pulling or changing CLI code.

## Tests

| Suite | Where | Command | What it covers |
| --- | --- | --- | --- |
| CLI unit | `git-colabor/tests/unit` | `pnpm -C git-colabor test` | co-author store, identity apply/revert, paths, redaction |
| CLI e2e | `git-colabor/tests/e2e` | `pnpm -C git-colabor test:e2e` | real `git` repos in temp dirs; audit-never-contains-secrets assertion |
| Extension unit | `tests/unit` | `pnpm test` | AskpassServer protocol, CliClient spawn/parse |
| Extension integration | *(M6, planned)* | `@vscode/test-electron` | activation, identity round-trip |

Quality gates before every commit / PR:

```bash
pnpm typecheck && pnpm lint && pnpm test          # root
pnpm -C git-colabor typecheck && pnpm -C git-colabor lint \
  && pnpm -C git-colabor test && pnpm -C git-colabor test:e2e
```

## Debugging in VS Code

`.vscode/launch.json` ships an **Run Extension** configuration: press `F5` to launch an Extension Development Host with the locally built `dist/extension.cjs`. Re-run `pnpm build` before reloading to pick up CLI changes; reload the host window after rebuilds.

Useful inspect surfaces in the host window:

- **Output → Git Colabor** channel — extension log (level via `gitColabor.logLevel`), secrets pre-redacted.
- `git colabor doctor` in the integrated terminal — CLI self-check.
- `.git/colabor/state.json` — per-repo bookkeeping the extension watches.

### Remote (Remote-SSH) testing

The F5 dev host is local-only: `--extensionDevelopmentPath` does **not** carry into a remote window (verified against server logs — the dev extension is silently not installed server-side), so don't rely on `code --remote … --extensionDevelopmentPath …`. Test remote behavior with the real artifact instead — one command does the whole loop:

```bash
build-scripts/remote-dev.sh install [host] [remote-dir]
# build → package → push vsix → install into the host's vscode-server → open the window
# defaults: host=hnrobert-nas-space  remote-dir=/home/HNRobert/git-colabor-test
build-scripts/remote-dev.sh logs [host]     # tail the remote extension-host log
build-scripts/remote-dev.sh status [host]   # is it installed on the server?
```

Re-run `install` to redeploy a fresh build, then *Developer: Reload Window* in the remote window. The manual equivalent: `pnpm package`, then in a Remote-SSH window Extensions → `⋯` → **Install from VSIX…** → choose **Install in SSH: \<host\>** → reload.

The extension then runs entirely workspace-side — verify from the host: `~/.config/git-colabor/` (identity map, askpass socket, audit log) and the repo's local git config are created **on the remote**, and `ps` shows `resources/cli.cjs` spawned by the server's Node.

## Packaging the extension

```bash
pnpm package        # vsce package --no-dependencies → git-colabor-0.x.y.vsix
```

`.vscodeignore` keeps the vsix lean (sources, submodule, tooling excluded); only `dist/extension.cjs`, `resources/*.cjs`, `package.json`, `README`, `LICENSE`, and the changelog ship. Expect a single-digit-MB vsix.

## Continuous integration

Two workflows run the full gate on every push to `main` and on PRs (path-filtered — docs-only changes never build):

- **This repo** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — checks the extension **and** the `git-colabor` submodule in one run (the extension build compiles the submodule): install both, typecheck, lint, unit + e2e, build.
- **`git-colabor` repo** `.github/workflows/ci.yml` — the same checks for the CLI, standalone in its own repository.

## Publishing

Releases are automated via GitHub Actions — manual dispatch from the Actions tab, no local publishing steps.

**Extension** (this repo → Marketplace + OpenVSX + GitHub Release):

1. One-time: add the repo secrets `VSCE_PAT` (Marketplace personal access token with the *Manage* scope) and `OVSX_PAT` (token from open-vsx.org).
2. Actions → **Release** → *Run workflow* → enter a version (e.g. `0.2.0`) and optionally check `beta` for a pre-release.

The run gates on typecheck/lint/test (root + submodule), bumps `package.json`, commits and tags `v<version>`, attaches the `.vsix` to a GitHub Release, then publishes to both marketplaces (`--pre-release` when beta).

**CLI** (`git-colabor` repo → npm, via OIDC trusted publishing — no token secret):

1. One-time Phase 1: publish the first version locally (`cd git-colabor && pnpm build && npm publish --access public`), then on npmjs.com → package → Settings → **Trusted publishers**, bind repository `hnrobert/git-colabor` with workflow `publish.yml`.
2. Actions → **Publish** → *Run workflow* → enter a version. Prerelease versions (e.g. `0.2.0-beta.1`) publish under the `beta` dist-tag.

The run gates on typecheck/lint/unit/e2e, bumps and tags in the submodule repository, then runs `npm publish --provenance` authenticated by GitHub's OIDC token.

Update [../CHANGELOG.md](../CHANGELOG.md) before releasing. The two repositories version **independently** — each tags `v<version>` in its own repo; the extension bundles whatever submodule commit is checked out at release time.

## Submodule workflow

`git-colabor/` is a standalone repository. When you change CLI code:

1. Commit **inside** `git-colabor` first (`feat(cli): …`), push to `hnrobert/git-colabor`.
2. `pnpm build` at the root to regenerate `resources/`.
3. Commit the updated submodule **pointer** in this repo (`chore(cli): bump git-colabor@<sha>`).

Never leave the parent repo pointing at an unpushed submodule commit — clones will fail to fetch it. See [../CONTRIBUTING.md](../CONTRIBUTING.md) for the full rules.
