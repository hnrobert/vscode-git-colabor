# Project Plan / Roadmap

> This file tracks milestone status. Requirements live in > [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md); architecture in > [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Product

Git Colabor = **one CLI (`git-colabor`, npm package + submodule)** + **one VS Code extension (this repo)**. Switch the git committer/pusher identity and SSH key per repository, and manage git-mob-style co-authors — designed for shared machines, VS Code Remote-SSH, Codespaces, and dev containers. All git/SSH logic runs workspace-side in the CLI; the extension is a UI/bridge over its `--json` interface.

## Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| **M1** — CLI core | `git colabor coauthor …` commands, `.git-coauthors` store, commit-template seeding, unit + e2e tests | ✅ done |
| **M2** — CLI identity | `git colabor identity …` (add/use/remove/logout/revert), per-repo state, key storage + `ssh-agent` loading, askpass bridge, audit log, doctor | ✅ done |
| **M3** — Extension bridge | Extension package at repo root, bundled-CLI `CliClient`, `AskpassServer` socket bridge, `Secrets`, `GitApi`, commands, logging | ✅ done |
| **M4** — Extension UI | SCM tree view (identities + co-authors), status bar, SCM input-box co-author sync, terminal-drift watchers, `repoStatus`/`identity status` | ✅ done |
| **M5** — Hardening | Setting-wins reconcile, `heldBy` multi-session conflict warnings, Windows key perms (`icacls`), log/audit redaction tests | ✅ done |
| **M6** — Docs & release | This documentation set, `@vscode/test-electron` integration suite, publish `.vsix` to Marketplace + OpenVSX, publish CLI to npm | 🚧 in progress |

## M6 checklist

- [x] Requirements / architecture / security / development docs (`docs/`)
- [x] Root README rewrite; `CONTRIBUTING.md`; `CHANGELOG.md`
- [x] Standalone `git-colabor/README.md` for the npm package
- [ ] `@vscode/test-electron` integration suite (extension activation, identity apply/revert round-trip in a sandbox repo)
- [x] CI workflow: typecheck + lint + unit + e2e (root and submodule) — `.github/workflows/ci.yml` in both repos, path-filtered
- [ ] Publish extension `.vsix` → Marketplace + OpenVSX — `release.yml` ready; needs `VSCE_PAT` + `OVSX_PAT` secrets, then first dispatch
- [ ] Publish `git-colabor` CLI to npm — `publish.yml` (OIDC trusted publishing) ready; needs Phase 1 (first local publish + npmjs trusted-publisher binding)
- [ ] Tag `v0.1.0` in both repositories

## Deferred (post-0.1.0 candidates)

- Encrypt-on-import for private keys (currently stored `0600`, warned)
- GitHub co-author suggestions beyond `noreply` fetch
- Worktrees / multi-root workspace refinements
