# Git Colabor (VS Code extension)

Switch the Git **committer + pusher identity** and **SSH key** per repository, with git-mob-style **co-authors** — for shared machines, VS Code Remote-SSH, Codespaces, and dev containers.

This is the VS Code extension. It bundles the [`git-colabor`](../git-colabor) CLI and drives it through a typed `--json` bridge. All git/SSH/identity logic runs **workspace-side** (where the repo and `ssh-agent` live), so it works under Remote-SSH/Codespaces.

## Commands

- **Git Colabor: Use Identity…** — pick an identity to apply to the current repo (writes `user.name`/`user.email`/`core.sshCommand`).
- **Git Colabor: Add Identity…** — name/email + optional SSH key (`--passphrase-command` supported).
- **Git Colabor: Remove Identity / Logout Identity / Revert Repo Identity / Show Audit Log / Doctor**
- Co-author commands: **Select / Add / Suggest / Solo / Open .git-coauthors** (full TreeView UI in M4).

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitColabor.user.name` | `""` | Overrides repo `user.name` in the extension — **always wins** over git config. |
| `gitColabor.user.email` | `""` | Overrides repo `user.email`. |
| `gitColabor.defaultIdentity` | `""` | Identity id to auto-activate on repo open. |
| `gitColabor.cliPath` | `""` | Override the bundled CLI path. |
| `gitColabor.conflictWarningStaleMinutes` | `5` | Advisory multi-session heldBy staleness. |

## Security

- Private keys live as `0600` files under `~/.config/git-colabor/keys/`; only the **passphrase** is stored in VS Code SecretStorage.
- The CLI loads keys via an `SSH_ASKPASS` helper that talks back to the extension over a per-session UNIX socket — the passphrase never appears on `argv`, in `ps`, or in logs.

See the project plan for the full design.
