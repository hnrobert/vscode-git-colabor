# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- SCM view **Colabor: Identity & Co-authors** — active identity, identities, selected and available co-authors, with click-to-switch and inline actions.
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
