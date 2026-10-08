# Git Colabor (the Extension)

<p align="center">
  <img src="git-colabor/assets/images/git-co-author-enhanced.png" width="140" alt="Git Colabor logo" />
</p>

A VS Code extension + CLI that switches the Git **committer + pusher identity** and **SSH key** per repository, and manages **co-authors** with a better experience — built for shared machines, multiple accounts, Remote-SSH, Codespaces, and dev containers.

## Why

Git gives you exactly one global identity per clone — `user.name`, `user.email`, one `ssh-agent`. That breaks the moment you:

- **share a machine** (workstation, lab box, pairing rig) and commits start landing under the wrong person;
- **have several accounts** (work / personal / student), each with its own SSH key, and the wrong one only fails at push time;
- **develop remotely**, where the repo and agent live workspace-side and local tools can't help;
- **pair**, and want `Co-authored-by:` trailers without hand-editing every commit message.

Git Colabor treats identity as explicit, per-repo, **reversible and auditable** state: pick an identity in the SCM view, commit, push, and `revert` the repo to its exact prior config when you leave. Select a co-author once and every commit message carries the trailer until you go solo.

## Features

- **Identities** — name / email / SSH key profiles; applying one writes `user.name`, `user.email`, `core.sshCommand` and snapshots prior config for one-command revert. Applies to **every repo open in the window**; keys enter `ssh-agent` only through the explicit right-click action.
- **Opt-in commit signing** — right-click any keyed identity → *Sign Commits with This Key* (green icon = has a key, verified badge = signing active); never on by default.
- **History import** — every committer in the repo's history becomes an identity automatically; hide the ones you don't want on this machine.
- **Co-authors** — every identity is a potential co-author; trailers seeded into the commit template **and** kept in sync with the SCM commit input box.
- **Safe key handling** — keys are referenced in place (never copied or modified); passphrases live in session memory only (never on disk) and reach `ssh-add` over a UNIX-socket askpass bridge — never on `argv`, never in `ps`, never in logs. Loading a key into ssh-agent is an explicit right-click action. A broken key reference degrades to a key-less apply.
- **Multi-session coordination** — advisory `heldBy` locking warns before one window/terminal overrides another's identity.
- **Audit trail** — every identity change logged locally (fingerprint only) with repo / host / user / source.
- **Truly remote-friendly** — the extension spawns the bundled CLI with the VS Code Server's own Node; nothing depends on remote `$PATH`.
- **The CLI is the engine** — everything the UI does is scriptable via `git colabor …` ([CLI reference](git-colabor/README.md)), including `--json` output and stable exit codes.

## Install

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=HNRobert.vscode-git-colabor) or [OpenVSX](https://open-vsx.org/extension/HNRobert/vscode-git-colabor):

```bash
code --install-extension HNRobert.vscode-git-colabor
```

Or build the latest from source:

```bash
git clone --recurse-submodules git@github.com:hnrobert/vscode-git-colabor.git
cd vscode-git-colabor
pnpm install && pnpm -C git-colabor install && pnpm build
pnpm package          # → git-colabor-<version>.vsix
```

Then in VS Code: *Extensions → ⋯ → Install from VSIX…*

**Requirements:** VS Code ≥ 1.83. For terminal use of the standalone CLI: Node.js ≥ 24 (the extension itself bundles everything).

## Quick start

1. **Add identities** — Command Palette → `Git Colabor: Add Identity…` (name, email, optional private key — picked from a scan of `~/.ssh` or typed).
2. **Use one** — SCM view → *Git Colabor: Identity & Co-authors* → click an identity (or the status-bar item). The repo's `user.*` / `core.sshCommand` switch; an encrypted key prompts for its passphrase once per session (verify-only, no agent write). To cache the key in ssh-agent, right-click the identity → **Load Key into ssh-agent**.
3. **Pair** — the *Co-authors* list shows `+` next to everyone not yet in the commit message; click to append their `Co-authored-by:` trailer (the `+` flips to `-`; click again to remove). The markers follow what you type in the message box.
4. **Leave clean** — `Git Colabor: Revert Repo Identity` restores the pre-tool config; `Logout Identity` unloads the key from `ssh-agent` (your key files are never touched).

## Commands

| Command | Effect |
| --- | --- |
| `Use Identity…` | Pick an identity to apply to the current repo |
| `Add Identity…` / `Remove Identity…` / `Logout Identity` | Manage identities (key files are referenced, never deleted); right-click rows to change name/email/key, load or remove the key in ssh-agent, toggle signing, save to memory, or hide imported ones |
| `Select Co-authors…` / `Add Co-author…` / `Solo (clear co-authors)` | Co-author selection (the tree's +/- rows toggle the commit message directly) |
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
| `gitColabor.coAuthorIdentities` | `[]` | Remembered co-authors (`"Name <email>"` entries in your VS Code user settings; right-click an identity → *Remember on VS Code User Settings*); these entries (plus all identities except the active one, and the repo's commit history) feed the Co-authors list |
| `gitColabor.autoApplyOnRepoOpen` | `true` | Auto-apply the default/active identity and `gitColabor.user.*` when a repo opens; off = only explicit *Use Identity* writes config |
| `gitColabor.conflictWarningStaleMinutes` | *unset* | Advisory `heldBy` staleness threshold (minutes); **unset = a session lock never goes stale** |
| `gitColabor.githubFetch` | `true` | Offer the GitHub user search (*Add Identity → From GitHub…*); hits `api.github.com` unauthenticated (60 req/h) |
| `gitColabor.postCommitSolo` | `false` | Clear the selected co-authors after each commit (dual watch on `COMMIT_EDITMSG` + the reflog — aborted editor saves and checkouts never trigger it) |
| `gitColabor.logLevel` | `info` | Output channel log level: `trace` / `debug` / `info` / `warning` / `error` / `off` |

## Security

- Private keys are referenced in place — never copied, modified, or deleted by the tool; a missing key file degrades the identity to key-less with a warning.
- Passphrases are session-scoped (extension memory, never on disk) and delivered to `ssh-add`/`ssh` through a per-session `0600` UNIX socket with a constant-time-compared token.
- The audit log records fingerprints only — never key bodies or passphrases (pinned by unit + e2e tests).

Threat model, protocol details, and explicit non-guarantees: [docs/SECURITY.md](docs/SECURITY.md).

## FAQ

**Remote-SSH / Codespaces / dev containers?** Yes — all git/SSH logic runs in the CLI workspace-side; the extension just drives it.

**What if I stop using it?** `Revert Repo Identity` (or `git colabor identity revert`) restores the exact prior config and removes every `colabor.*` marker. Nothing global is left behind except an optional `commit.template` it set only if you had none.

**Windows?** Supported (config under `%APPDATA%\git-colabor`, `icacls` key permissions). The askpass socket requires the UNIX-socket support in your Node/Windows build.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, data flow, JSON bridge & askpass protocol |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, key/passphrase handling, non-guarantees |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Build, test, packaging, publishing |
| [git-colabor/README.md](git-colabor/README.md) | Standalone CLI (`git colabor …`) command reference |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow |

## Development

```bash
pnpm install && pnpm -C git-colabor install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

F5 launches an Extension Development Host. Full guide: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[Apache-2.0](LICENSE)
