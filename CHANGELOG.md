# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — security model

- **Keys are referenced in place, never copied**: `identity add --key` records the source path + fingerprint; the file is never modified or deleted by the tool. A broken reference (moved/rotated source) degrades to a **key-less apply** (no `core.sshCommand`, `key-missing` warning) and recovers when the file returns. `identity logout` removes the key from `ssh-agent` only.
- Identity memory (`gitColabor.coAuthorIdentities`) now lives in two settings layers only — user and workspace; the machine level is the identity store itself.

### Added

- `git colabor identity import` — add every distinct repo-history committer as a key-less identity (idempotent; hidden-email list keeps removed imports from resurrecting; a manual re-add un-hides). Runs automatically when the extension opens a repo.
- `git colabor identity set` — edit an identity in place (name / email / key / passphrase-command).
- **Opt-in SSH commit signing** — `git colabor identity sign <id> [--off]` and a right-click toggle on identity rows; writes `commit.gpgsign` + `gpg.format=ssh` + `user.signingKey`, re-binding to the applied identity while enabled. Never on by default.
- One **merged Co-authors list** with `+`/`-` rows that follow the SCM commit-message input box; candidates merge the `.git-coauthors` catalogue, all identities (minus the active one), settings memory, and repo commit history.
- Identity right-click menus: modify section (change name/email/key), per-scope memory, and hide (user/machine/workspace) for history-imported identities.
- **Session-wide identity application** — one window applies identities, reconcile, and signing across every open repository (incl. multi-root and submodules).
- `build-scripts/remote-dev.sh` — one-command remote deploy (vsix into the host's vscode-server) with marker-driven full window reload; `~/.ssh` private-key picker on identity add; themed tree icons (green = key, verified badge = signing).

### Fixed

- `vscode.git` API acquisition raced activation under Remote-SSH — now awaited with backoff and clear failure logging.
- Context-menu commands act on the right-clicked identity directly instead of re-opening a picker.

## [0.1.0] - 2026-07-05

Initial public cut: multi-identity + co-author management for git, as a CLI (`git-colabor`, bundled here as a submodule) and a VS Code extension that drives it over a typed `--json` bridge.

### Added — CLI (`git-colabor`)

- `git colabor coauthor …` — select / add / suggest / solo co-authors, backed by a git-mob-compatible `.git-coauthors` file and `Co-authored-by:` trailers seeded into the commit template and the SCM input box.
- `git colabor identity …` — add / use / remove / logout identities; `use` writes `user.name`, `user.email`, and `core.sshCommand` per repo, loads the identity's SSH key into `ssh-agent`, and records managed-repo bookkeeping (`colabor.managed*`) so `revert` / `logout` can restore prior state.
- `identity status` — machine-readable per-repo status (active identity, selected co-authors, heldBy coordination) for the extension's UI.
- Askpass bridge — `SSH_ASKPASS` helper talking to the extension over a per-session UNIX socket, so passphrases are never on `argv`, in `ps`, or in logs.
- Audit log with automatic secret redaction; `doctor` self-check command.
- JSON output mode for every command (the extension bridge).

### Added — VS Code extension

- SCM view **Git Colabor: Identity & Co-authors** — active identity, identities, selected and available co-authors, with click-to-switch and inline actions.
- Status bar indicator; commands for identity use / add / remove / logout / revert / audit / doctor.
- Passphrase storage in VS Code SecretStorage; SSH keys stored `0600` (`icacls` on Windows) under the git-colabor config dir.
- Reconcile controller — settings-win enforcement (`gitColabor.user.*`, `defaultIdentity`), debounced re-apply on external git config / state changes, multi-session `heldBy` conflict warnings.
- SCM input-box co-author trailer sync (idempotent reseed) and optional clear-co-authors-after-commit watcher.
- Works fully workspace-side under Remote-SSH / Codespaces / dev containers.

### Security

- Private keys are copied (never re-encrypted at import in 0.1.0) to a `0600` directory; unencrypted imports raise a warning.
- Passphrase-command support (`--passphrase-command`) executed without shell interpolation; secrets redacted from all log and audit output (covered by unit + e2e tests).

[Unreleased]: https://github.com/hnrobert/vscode-git-colabor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hnrobert/vscode-git-colabor/releases/tag/v0.1.0
