# Git Colabor

A VS Code extension + CLI that switches the Git **committer + pusher identity** and **SSH key** per repository, and manages git-mob-style **co-authors** — built for shared machines, multiple accounts, Remote-SSH, Codespaces, and dev containers.

## Why

Git gives you exactly one global identity per clone — `user.name`, `user.email`, one `ssh-agent`. That breaks the moment you:

- **share a machine** (workstation, lab box, pairing rig) and commits start landing under the wrong person;
- **have several accounts** (work / personal / student), each with its own SSH key, and the wrong one only fails at push time;
- **develop remotely**, where the repo and agent live workspace-side and local tools can't help;
- **pair**, and want `Co-authored-by:` trailers without hand-editing every commit message.

Git Colabor treats identity as explicit, per-repo, **reversible and auditable** state: pick an identity in the SCM view, commit, push, and `revert` the repo to its exact prior config when you leave. Select a co-author once and every commit message carries the trailer until you go solo.

Full requirements: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Features

- **Identities** — name / email / SSH key profiles; applying one writes `user.name`, `user.email`, `core.sshCommand`, loads the key into `ssh-agent`, and snapshots prior config for one-command revert.
- **Co-authors** — git-mob-compatible `.git-coauthors` catalogue; trailers seeded into the commit template **and** kept in sync with the SCM commit input box.
- **Safe key handling** — keys stored `0600`; passphrases live in VS Code SecretStorage and reach `ssh-add` over a UNIX-socket askpass bridge — never on `argv`, never in `ps`, never in logs. `logout` shreds the key.
- **Multi-session coordination** — advisory `heldBy` locking warns before one window/terminal overrides another's identity.
- **Audit trail** — every identity change logged locally (fingerprint only) with repo / host / user / source.
- **Truly remote-friendly** — the extension spawns the bundled CLI with the VS Code Server's own Node; nothing depends on remote `$PATH`.
- **The CLI is the engine** — everything the UI does is scriptable via `git colabor …` ([CLI reference](git-colabor/README.md)), including `--json` output and stable exit codes.

## Install

> Marketplace / OpenVSX publishing is in progress (M6). Until then:

```bash
git clone --recurse-submodules git@github.com:hnrobert/vscode-git-colabor.git
cd vscode-git-colabor
pnpm install && pnpm -C git-colabor install && pnpm build
pnpm package          # → git-colabor-0.1.0.vsix
```

Then in VS Code: *Extensions → ⋯ → Install from VSIX…*

**Requirements:** VS Code ≥ 1.83. For terminal use of the standalone CLI: Node.js ≥ 24 (the extension itself bundles everything).

## Quick start

1. **Add identities** — Command Palette → `Git Colabor: Add Identity…` (name, email, optional private-key path, optional passphrase command such as `op read "op://Private/ssh/pass"`).
2. **Use one** — SCM view → *Colabor: Identity & Co-authors* → click an identity (or the status-bar item). The repo's `user.*` / `core.sshCommand` switch, the key loads.
3. **Pair** — the *Co-authors* list shows `+` next to everyone not yet in the commit message; click to append their `Co-authored-by:` trailer (the `+` flips to `-`; click again to remove). The markers follow what you type in the message box.
4. **Leave clean** — `Git Colabor: Revert Repo Identity` restores the pre-tool config; `Logout Identity` also shreds the key.

## Commands

| Command | Effect |
| --- | --- |
| `Use Identity…` | Pick an identity to apply to the current repo |
| `Add Identity…` / `Remove Identity…` / `Logout Identity` | Manage identities (remove = confirm + shred key) |
| `Select Co-authors…` / `Add Co-author…` / `Solo (clear co-authors)` | Co-author selection (the tree's +/- rows toggle the commit message directly) |
| `Open .git-coauthors` | Edit the catalogue (`~/.git-coauthors`) |
| `Revert Repo Identity` | Restore pre-tool git config from backup |
| `Show Audit Log` | Last 100 audit entries as JSONL |
| `Doctor` | Self-check (binaries, map, agent, repo markers) |
| `Reload` | Refresh the view (also automatic on terminal-CLI changes) |

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `gitColabor.user.name` / `gitColabor.user.email` | `""` | **Always win** over any identity's name/email in repos you open (re-applied by the reconcile loop) |
| `gitColabor.defaultIdentity` | `""` | Identity id auto-activated when a repo has none active |
| `gitColabor.cliPath` | `""` | Override the bundled CLI path (`resources/cli.cjs`) |
| `gitColabor.coAuthors` | `[]` | Remembered co-authors (`"Name <email>"` entries) — right-click an identity in the Identities group to save/remove it per user / machine / workspace layer; all layers (plus the `.git-coauthors` catalogue, all identities except the active one, and the repo's commit history) feed the Co-authors list |

Declared but **not yet enforced** in 0.1.0 (tracked in [plan.md](plan.md)): `autoApplyOnRepoOpen` (always on for now), `conflictWarningStaleMinutes` (CLI default 5 min), `githubFetch`, `postCommitSolo`, `logLevel`.

## Security

- Private keys are copied to a `0600` directory (`icacls` on Windows); the originals are untouched. Encrypt-on-import is on the roadmap.
- Passphrases are stored in VS Code SecretStorage and delivered to `ssh-add` through a per-session `0600` UNIX socket with a constant-time-compared token.
- The audit log records fingerprints only — never key bodies or passphrases (pinned by unit + e2e tests).

Threat model, protocol details, and explicit non-guarantees: [docs/SECURITY.md](docs/SECURITY.md).

## FAQ

**Does it work with git-mob?** Yes — same `.git-coauthors` format and trailer semantics; Git Colabor never touches `git-mob.co-author`.

**Remote-SSH / Codespaces / dev containers?** Yes — all git/SSH logic runs in the CLI workspace-side; the extension just drives it.

**What if I stop using it?** `Revert Repo Identity` (or `git colabor identity revert`) restores the exact prior config and removes every `colabor.*` marker. Nothing global is left behind except an optional `commit.template` it set only if you had none.

**Windows?** Supported (config under `%APPDATA%\git-colabor`, `icacls` key permissions). The askpass socket requires the UNIX-socket support in your Node/Windows build.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Problem, use cases, FR/NFR list, milestone traceability |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, data flow, JSON bridge & askpass protocol |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, key/passphrase handling, non-guarantees |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Build, test, packaging, publishing |
| [git-colabor/README.md](git-colabor/README.md) | Standalone CLI (`git colabor …`) command reference |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [plan.md](plan.md) | Workflow · history · roadmap |

## Development

```bash
pnpm install && pnpm -C git-colabor install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

F5 launches an Extension Development Host. Full guide: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE)
