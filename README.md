# git-colabor

<p align="center">
  <img src="assets/images/git-co-author-enhanced.png" width="140" alt="Git Colabor logo" />
</p>

**`git colabor`** — switch the Git **committer + pusher identity** and **SSH key** per repository, and manage **co-authors** with a better experience, from one CLI.

This is the CLI half of Git Colabor. A VS Code extension ([`vscode-git-colabor`](https://github.com/hnrobert/vscode-git-colabor)) bundles this binary and drives it over its `--json` interface — but the CLI is fully standalone and scriptable.

---

## Why (requirements in one paragraph)

You share a machine — a lab workstation, a pair-programming box, a Remote-SSH server, a Codespace. Multiple people (or one person with work / personal / student accounts) commit and push from it. Git's `user.name` / `user.email` / `core.sshCommand` are global-or-manual, so identity bleed is one forgotten `git config` away: commits attributed to the wrong person, pushes with the wrong key, and no trace of *who set what, when*. Meanwhile, pairing sessions need `Co-authored-by:` trailers, which git has no workflow for at all. `git-colabor` treats identity as explicit, per-repo, auditable state — and makes co-author selection a one-liner.

## Features

- **Identities** — named `{ name, email, SSH key }` profiles; `identity use` writes `user.name`, `user.email`, and `core.sshCommand` for the current repo and snapshots prior config so `revert` can restore it. Keys are never auto-loaded into ssh-agent — that's the explicit `identity agent <email>`.
- **Co-authors** — pick people from your identities; trailers are seeded into the commit template and stay in sync.
- **Safe key handling** — private keys are referenced in place (never copied or modified), passphrases never appear on `argv` / `ps` (SSH_ASKPASS bridge), a broken key reference degrades to a key-less apply.
- **Coordination** — advisory `heldBy` session locking warns when a second session (another terminal, another VS Code window) is about to override the repo identity; nothing is ever silently clobbered.
- **Audit trail** — every identity action is appended to a local JSONL audit log (fingerprint only — never key bodies or passphrases).
- **Machine-friendly** — every command supports `--json` with a stable envelope and documented exit codes.

## Install

Requires **Node.js >= 24**.

```bash
npm install -g git-colabor
# or from source:
git clone git@github.com:hnrobert/git-colabor.git && cd git-colabor
pnpm install && pnpm build && npm link
```

Git finds `git-colabor` on your `PATH`, so the command becomes **`git colabor …`**.

## Quick start

```bash
# 1. Create identities (work + personal, one with an SSH key)
git colabor identity add --name "Robert He" --email robert@work.io --default
git colabor identity add --name "Robert" --email me@personal.io \
    --key ~/.ssh/id_ed25519_personal

# 2. Use one in the current repo
git colabor identity use "Robert He <robert@work.io>"   # or the bare email when unique

# 3. Pairing: add a co-author (must exist as an identity)
git colabor coauthor add jamie@example.com           # next commit only
git colabor coauthor add jamie@example.com --always  # every commit in this repo

git commit                                # Co-authored-by: trailer included

# 4. Done pairing / leaving the repo
git colabor coauthor rm jamie@example.com
git colabor identity revert               # restore pre-tool git config
```

## Command reference

### `git colabor coauthor …`

| Command | Effect |
| --- | --- |
| `coauthor add <email\|id> [--always] [--global]` | Add a co-author: one-shot (next commit), `--always` (every commit in this repo), `--global` (every repo). The person must exist as an identity. |
| `coauthor rm <email\|id>` | Remove a co-author from every scope it is active in. |
| `coauthor ls [filter]` | Active co-authors + available candidates (identities minus the active one); optional substring filter. |
| `coauthor print` | Print the `Co-authored-by:` trailer blob for the current selection. |
| `coauthor suggest [filter]` | Suggest co-authors from `git shortlog` history; interactive pick without `--json`. |

Selecting co-authors rewrites the commit template (`commit.template` / `~/.gitmessage`): all existing `Co-authored-by:` trailers are stripped and the current selection re-appended — the same behavior as git-mob's message formatter.

### `git colabor identity …`

| Command | Effect |
| --- | --- |
| `identity ls` | List identities; `*` marks the default; shows key fingerprint. |
| `identity use <name-email>` | Apply identity to the current repo (config + state; reports whether the key is in ssh-agent, never loads it). Flags: `--source cli\|ext`, `--as-name`, `--as-email` (override committer fields), `--config-scope local\|global` (which git-config file to write — default `local`; `global` writes `~/.gitconfig` and leaves the repo untouched). With an encrypted key neither in the agent nor served by the extension bridge, prints an `agent-reminder` pointing at `ssh-add <key>`. |
| `identity agent <name-email>` | The only path that loads a key into ssh-agent. `--remove` unloads (`ssh-add -d`); `--verify` proves the extension-session passphrase is correct without any agent write (`ssh-keygen -y` under askpass). |
| `identity add` | `--name`, `--email` (required); `--key <path>` (import), `--host`, `--default`. |
| `identity rm <name-email>` | Remove from the identity map (logs out first, best-effort; imported identities are also hidden from future auto-imports). |
| `identity import` | Add every distinct **committer** from the repo history as a key-less identity (idempotent, skips hidden emails; driven automatically by the extension on repo open). |
| `identity set <name-email>` | Edit in place: `--name <n>`, `--email <e>`, `--key <path>` (re-reference the push/auth key), `--no-key` (clear), `--scope user\|machine\|project`, `--sign-key <path>` (bind a DEDICATED SSH signing key — separate from the push key), `--gpg-key <key>` (bind a secret GPG signing key — fingerprint, key id or email; stored as the fingerprint), `--no-sign-key` / `--no-gpg-key` (unbind the sign key; signing falls back to the push key), `--sign-commits` / `--no-sign-commits` (the per-identity signing preference: every later `use` of the identity re-enables / keeps off commit signing). |
| `identity sign <email>` / `identity sign [id] --off` | Opt-in commit signing with the identity's key — its bound GPG key (`gpg.format=openpgp`), else its SSH key (`gpg.format=ssh`) — writes `commit.gpgsign=true`, `gpg.format`, `user.signingKey`. The choice is remembered per identity: `identity sign` stores it, and every later `identity use` of that identity re-enables signing with its key (switching to a key-less identity turns it off for that repo); `--off` drops the preference too. `--off` drops colabor's keys and, when global/system config would still sign, pins `commit.gpgsign=false` locally — off means this repo does not sign. |
| `identity gpg-keys` | Secret GPG keys usable for signing (via `gpg.program`, default `gpg`): fingerprint + user ids. |
| `identity unset-config <name-email>` | Strip an identity's name/email/keys from ONE git-config file (`--scope local\|global`, default local; content-matched — another person's config survives). Local scope also arms the standing-down guard: auto-apply (extension reconcile) will not re-materialize the identity into that repo until an explicit local `identity use`. |
| `identity logout [id]` | Remove key from `ssh-agent` (`--no-agent` keeps it loaded) and clear the identity's git-config layer: `user.name`/`user.email` on match, plus any `core.sshCommand` / signing keys its previous `use` left in the repo — even after the config moved on to someone else. Another person's committer config always survives. |
| `identity status` | Per-repo snapshot: active identity, per-scope config identities (`configIdentities.repo` / `.global` — which person each git-config file names), selected + available co-authors, and the **effective** commit signing (`signing`: `enabled`, `format`, `key`, the `scope`/`origin` file `commit.gpgsign` comes from, `managed` when colabor turned it on, and the GPG key's `keyEmails`). |
| `identity audit` | `--repo <path>`, `--since <date>`, `--tail <n>` filters over the audit log. |
| `identity doctor` | Self-check: binaries, identity map, key dir, agent, askpass bundle, repo markers. |

### Global flags & exit codes

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output (see below). |
| `-C <path>` | Run as if in `<path>`. |
| `--log-level <level>` | CLI debug log level (also env `GIT_COLABOR_LOG_LEVEL`). |
| `--no-color` | Accepted; output is color-free by default. |
| `-h` / `-v` | Help / version. |

| Exit code | Meaning |
| --- | --- |
| 0 | success |
| 1 | runtime / internal error |
| 2 | usage error, invalid email |
| 3 | not inside a git repository |
| 4 | secret unavailable (no passphrase could be obtained) |
| 5 | not found (author / identity), duplicate key |
| 6 | conflict blocked (`--no-override` with a live `heldBy`) |

### JSON envelope

Every command accepts `--json` and prints one compact line:

```json
{"ok":true,"data":{…},"warnings":[{"code":"…","message":"…"}]}
{"ok":false,"error":{"code":"NOT_FOUND","message":"…","hints":[],"exitCode":5},"data":null}
```

This is the contract the VS Code extension consumes.

## What it writes on disk

| Path | Purpose | Mode |
| --- | --- | --- |
| `~/.config/git-colabor/identities.json` | Identity map (referenced key paths + fingerprints; env `GIT_COLABOR_MAP`) | `0600` |
| `~/.config/git-colabor/audit.log` | JSONL audit trail | `0600` |
| `<git-dir>/colabor/state.json` | Per-repo state: active identity, `heldBy`, opt-in signing flag, config backups | `0600` |
| `~/.gitmessage` (or `commit.template`) | Commit template seeded with trailers | — |

(Windows: the data dir is `%APPDATA%\git-colabor`.)

Git config keys **written locally** per repo: `user.name`, `user.email`, `core.sshCommand` (only when the identity has a key: `ssh -i <key> -o IdentitiesOnly=yes`), and — after an explicit `identity sign` — commit signing (`commit.gpgsign=true`, `gpg.format=openpgp|ssh`, `user.signingKey=<GPG fingerprint | SSH key path>`; switching to a key-less identity or `--off` clears them and pins `commit.gpgsign=false` when global/system config would still sign), `colabor.managed=true`, `colabor.managed-by=cli|ext`, and multi-valued `colabor.selected` (`Name <email>` per co-author). `commit.template` is set **globally** only if unset in any scope.

## git-mob compatibility

- Same trailer format `Co-authored-by: NAME <EMAIL>` and the same template-rewrite semantics (strip existing trailers, re-append the current selection).
- Co-author candidates come from **identities**, not `.git-coauthors` — the catalogue file plays no role.
- Does **not** read or write git-mob's `git-mob.co-author` config — the two tools can coexist.

## Security notes

- Private keys are **referenced in place** — the tool never copies, modifies, or deletes them; your file layout and permissions are entirely yours. Importing an unencrypted key raises a warning; a key file that later disappears degrades the identity to key-less with a `key-missing` warning.
- Passphrases are resolved via, in order: the extension's askpass socket bridge → interactive tty prompt. They never appear on `argv`, in `ps`, or in any log (redaction is unit- and e2e-tested), and are never written to disk. Pure-CLI runs (no extension session) rely on ssh-agent or per-operation tty prompts.
- The audit log records fingerprints and session metadata only.

Full threat model: [docs/SECURITY.md](../docs/SECURITY.md) in the extension repo.

## Environment variables

| Variable | Overrides |
| --- | --- |
| `GIT_COLABOR_MAP` | identity map path |
| `GIT_COLABOR_AUDIT_FILE` | audit log path |
| `GIT_COLABOR_MESSAGE_PATH` | commit template path |
| `GIT_COLABOR_LOG_FILE` / `GIT_COLABOR_LOG_LEVEL` | CLI debug log |
| `GIT_COLABOR_ASKPASS_SOCK` / `GIT_COLABOR_ASKPASS_TOKEN` | askpass bridge endpoint (set by the extension) |

## Library

`dist/index.cjs` exports the full core (26 modules): author store, co-author state, identity map/keys/agent/apply/revert/logout, repo state & coordination, git exec/config, message formatter, audit, paths, errors — everything except the CLI layer.

```js
const { loadIdentityMap, applyIdentity, setSelected } = require('git-colabor');
```

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint
pnpm test            # 40 unit tests
pnpm test:e2e        # 15 e2e tests against real git + ssh-keygen in tmp dirs
pnpm build           # tsup → dist/{cli,index,askpass}.cjs (node24, zero deps)
```

Contributions follow the AIM standards — see [CONTRIBUTING.md](../CONTRIBUTING.md) in the extension repo.

## License

Apache-2.0 — see [LICENSE](LICENSE).
