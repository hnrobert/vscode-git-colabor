# Contributing to Git Colabor

Thanks for contributing! This project follows the UNNC AIM team repository and code standards, adapted to a TypeScript / VS Code extension monorepo.

- [Contributing to Git Colabor](#contributing-to-git-colabor)
  - [Setting up](#setting-up)
  - [Branch naming](#branch-naming)
  - [Commit messages](#commit-messages)
  - [Pull requests](#pull-requests)
  - [Code style](#code-style)
  - [Working with the submodule](#working-with-the-submodule)
  - [Documentation](#documentation)

## Setting up

Requirements:

- Node.js **>= 24** (both packages target `node24`)
- pnpm **10.x** (`corepack enable` picks up `packageManager` automatically)
- Git

```bash
# clone with the CLI submodule
git clone --recurse-submodules git@github.com:hnrobert/vscode-git-colabor.git
cd vscode-git-colabor

pnpm install            # extension deps (repo root)
pnpm -C git-colabor install   # CLI deps (submodule, standalone)

pnpm build              # build:cli → tsup → copy bundled CLI into resources/
pnpm typecheck && pnpm lint && pnpm test
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full build / test / release pipeline.

## Branch naming

Branch names are **all lowercase**, words joined by underscores `_`.

| Branch type | Pattern | Example |
| --- | --- | --- |
| Bug fix | `fix/<bug_name>` | `fix/askpass_socket_race` |
| New feature | `feature/<feature_name>` | `feature/tree_drag_reorder` |
| Milestone release | version tag | `v0.2`, `0.2.0` |

The default branch is always `main` (never `master`). Do **not** push directly to `main` — open a Pull Request (see below).

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <subject>

<body>

<footer>
```

| Field | Required | Rule |
| --- | --- | --- |
| `<type>` | yes | see table below |
| `<scope>` | no | affected module, e.g. `cli`, `ext`, `askpass`, `tree` |
| `<subject>` | yes | **≤ 50 chars**, imperative mood (`add` not `added`), **lowercase first letter**, no trailing punctuation |
| `<body>` | no | why / how / context, wrap lines at **≤ 72 chars** |
| `<footer>` | no | `BREAKING CHANGE: …`, `Closes #123` |

Types: `feat` | `fix` | `docs` | `style` | `refactor` | `test` | `chore` | `perf` | `ci` | `build`.

Example:

```text
feat(askpass): scope socket to session id

Pass the extension session id into the askpass helper so concurrent
VS Code windows never share a socket path.

Closes #42
```

All commits, code, and code comments are written in **American English** (`color`, `behavior`, `optimize` — not *colour*, *behaviour*, *optimise*).

## Pull requests

- Branch from `main`, PR back into `main`.
- Keep one logical change per PR; describe **what and why** in the PR body.
- The PR must pass before review: `pnpm typecheck && pnpm lint && pnpm test` in the root **and** in `git-colabor/` when the submodule is touched.
- If the PR updates the `git-colabor` submodule pointer, commit the submodule change in the same PR (see below).

## Code style

- **TypeScript**, strict mode (`tsconfig.base.json`): `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`.
- Formatting and lint rules come from ESLint 9 flat config (`eslint.config.js`, `typescript-eslint` recommended) — run `pnpm lint`.
- Match the surrounding code: named exports, `node:`-prefixed built-in imports, no default exports except where bundlers require them.
- No build artifacts in the repo — `dist/` and `resources/cli.cjs` are generated at build time and gitignored.

## Working with the submodule

`git-colabor/` is a standalone git repository (the CLI, publishable to npm) mounted as a submodule. The extension consumes its **built output**, copied into `resources/` by `build-scripts/copy-cli.mjs` at build time.

When you change CLI code:

```bash
cd git-colabor
# …edit, then:
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e && pnpm build
git checkout -b feature/<name>
git add -A && git commit -m "feat(cli): …"
git push                       # to hnrobert/git-colabor

cd ..
pnpm build                     # rebuild + re-copy into resources/
git add git-colabor            # the updated submodule pointer
git commit -m "feat(ext): bump git-colabor for …"
```

A parent-repo commit that changes the CLI must carry the new submodule pointer, otherwise CI and other contributors build against stale CLI code.

## Documentation

User-facing docs live in [docs/](docs/) — when you change behavior, update the matching page in the same PR:

| Doc | Covers |
| --- | --- |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Problem, use cases, FR/NFR list |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, data flow, protocols |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, key & passphrase handling |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Build, test, packaging, release |
| [git-colabor/README.md](git-colabor/README.md) | Standalone CLI reference |

Docs commits use `docs(scope): …` like any other change.
