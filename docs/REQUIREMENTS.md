# Requirements

The "why" behind Git Colabor: the problem, the users, the functional and non-functional requirements, and how they map to milestones. For how the requirements are satisfied, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Background & problem

Git ships with exactly one global identity per clone: `user.name`, `user.email`, and (if you push over SSH) one `core.sshCommand` / `ssh-agent`. That model breaks down in four common situations:

1. **Shared machines** — a lab workstation, a pair-programming box, a classroom server. Two people alternating commits must re-run `git config user.*` by hand; the first forgotten switch attributes someone else's commits to you.
2. **Multiple accounts** — one developer with work / personal / student accounts needs different committer identities *and* different SSH keys per repository, and the "wrong key" failure only surfaces at push time.
3. **Remote development** — under VS Code Remote-SSH, Codespaces, or dev containers, the repository and `ssh-agent` live on the *remote* side. Any identity tool that runs locally (or assumes the local keychain) is useless there.
4. **Pair programming** — crediting a pairing session requires `Co-authored-by:` trailers in the commit message; git offers no workflow for selecting, persisting, or templating them.

Existing tools cover slices of this (git-mob handles co-authors; nothing handles multi-identity + per-repo SSH keys + co-authors together), and none offer an audit trail of identity changes on a shared machine.

**Git Colabor** = one CLI (`git colabor`, this repo's `git-colabor` submodule) + one VS Code extension (this repo) that treats identity as explicit, per-repo, reversible, and auditable state — and co-author selection as a one-liner.

## 2. Personas & use cases

| ID | Persona | Use case |
| --- | --- | --- |
| UC-1 | **Alex — shared workstation** | Sits down, opens the repo, picks their identity in the SCM view (or `git colabor identity use …`), commits, pushes, reverts the repo when leaving. Nothing of Alex's config remains. |
| UC-2 | **Sam — multiple accounts** | Keeps work + personal identities, each with its own SSH key; switches per repo; `core.sshCommand` is rewritten automatically so pushes always use the right key. |
| UC-3 | **Riley — remote dev** | Works over Remote-SSH / Codespace. All identity and SSH logic executes workspace-side (spawned through the VS Code Server's Node), so the extension behaves identically to local. |
| UC-4 | **Jordan & Casey — pairing** | Select each other as co-authors (`coauthor use jc` or one click in the tree view); every subsequent commit message carries both `Co-authored-by:` trailers until they `solo`. |
| UC-5 | **Priya — admin/auditor** | Wants to know who applied which identity, when, from where: `git colabor identity audit` / the Show Audit Log command. |
| UC-6 | **Script author** | Drives the CLI from a hook or script using `--json` and exit codes. |

## 3. Scope & non-goals

**In scope:** per-repo committer identity, per-repo SSH key selection, ssh-agent loading, co-author management, commit-template seeding, revert to pre-tool state, advisory multi-session coordination, local audit trail, VS Code UI, full workspace-side (remote) operation.

**Non-goals (0.1.0):**

- GPG / SSH commit signing management.
- Re-encrypting keys on import (planned post-0.1.0; unencrypted imports are stored `0600` with a warning).
- Replacing git-mob — the two coexist (Git Colabor never reads or writes `git-mob.co-author`).
- Hosting or syncing identities across machines (the identity map is a local file; you may sync it yourself).

## 4. Functional requirements

### Identity management (CLI)

| ID | Requirement | Status |
| --- | --- | --- |
| FR-1 | Create identities (name, email, optional SSH private key import, optional passphrase command, host, default flag); remove identities | ✅ |
| FR-2 | List identities with key fingerprints; mark the default | ✅ |
| FR-3 | `identity use` applies per repo: writes local `user.name`, `user.email`, `core.sshCommand` (`ssh -i <key> -o IdentitiesOnly=yes`), and bookkeeping markers `colabor.managed`, `colabor.managed-by` | ✅ |
| FR-4 | First-touch backup of the repo's prior identity config; `identity revert` restores it exactly (including "was unset") | ✅ |
| FR-5 | `identity logout`: remove the key from `ssh-agent` and shred the imported key file, without touching repo config | ✅ |
| FR-6 | Load the identity's key into `ssh-agent`, resolving passphrases without ever placing them on `argv` | ✅ |

### Co-authors (CLI)

| ID | Requirement | Status |
| --- | --- | --- |
| FR-7 | `.git-coauthors` catalogue in git-mob-compatible JSON, resolved env → repo → home | ✅ |
| FR-8 | Select / clear / list / add / suggest co-authors (`use`, `solo`, `ls`, `add`, `suggest` from `git shortlog`) | ✅ |
| FR-9 | Commit-template seeding: strip existing `Co-authored-by:` trailers, re-append the current selection; template resolution mirrors git-mob | ✅ |
| FR-10 | Per-repo selection persisted as multi-valued local `colabor.selected` | ✅ |

### Status, coordination & audit (CLI)

| ID | Requirement | Status |
| --- | --- | --- |
| FR-11 | `identity status`: one JSON snapshot per repo (active identity, markers, heldBy, selected/available co-authors) | ✅ |
| FR-12 | Advisory session coordination: `heldBy` in per-repo state; conflicts detected across sessions (CLI vs extension windows); 5-minute staleness; `--no-override` refuses takeover (exit 6) | ✅ |
| FR-13 | Local JSONL audit log (mode `0600`) of every identity mutation, with repo/host/user/source metadata; filterable (`--repo`, `--since`, `--tail`) | ✅ |
| FR-14 | `identity doctor` self-check (binaries, map, key dir, agent, askpass bundle, repo markers) | ✅ |

### VS Code extension

| ID | Requirement | Status |
| --- | --- | --- |
| FR-15 | SCM tree view: active identity, identities, selected + available co-authors; click to switch / add / remove; inline actions | ✅ |
| FR-16 | Status bar item showing active identity (+ co-author count), click to switch | ✅ |
| FR-17 | Command palette: use / add / remove / logout / revert / audit log / doctor / open `.git-coauthors` / reload / settings | ✅ |
| FR-18 | Settings-wins reconcile: `gitColabor.user.*` overrides always re-applied (`--as-name`/`--as-email`); `gitColabor.defaultIdentity` auto-activates; re-run on repo open/close/selection and on settings change | ✅ |
| FR-19 | SCM input-box co-author sync: idempotently reseed `Co-authored-by:` trailers; never clobber user typing (skip when unchanged) | ✅ |
| FR-20 | Terminal-drift watchers: `fs.watch` on `.git/colabor/state.json` (300 ms debounce) and save-hook on `.git-coauthors` refresh the UI after out-of-band CLI runs | ✅ |
| FR-21 | Passphrase storage in VS Code SecretStorage; askpass UNIX-socket server so the CLI's `ssh-add` can fetch passphrases from the extension | ✅ |
| FR-22 | Fully workspace-side execution: the extension spawns the bundled CLI with the VS Code Server's own Node (`process.execPath`), never relying on remote `$PATH` — Remote-SSH / Codespaces / dev containers behave like local | ✅ |
| FR-23 | Co-author suggestions surfaced in the UI (`suggestCoAuthors` command) | ⏳ stub (CLI `suggest` works) |

### Cross-cutting

| ID | Requirement | Status |
| --- | --- | --- |
| FR-24 | Machine interface: every CLI command supports `--json` with a stable `{ok, data\|error, warnings}` envelope and documented exit codes 0–6 | ✅ |
| FR-25 | git-mob compatibility: same `.git-coauthors` format, same trailer semantics, same key generation; does not touch `git-mob.co-author` | ✅ |

## 5. Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-1 Security | Passphrases never on `argv`/`ps`/logs; imported keys stored `0600` (`icacls` on Windows); askpass socket `0600` in a `0700` dir, token compared constant-time; audit records fingerprints only. Details: [SECURITY.md](SECURITY.md). |
| NFR-2 Footprint | CLI bundles to single-file CJS with **zero runtime dependencies**; extension ships a vsix with no runtime `node_modules` (CLI pre-bundled in `resources/`). |
| NFR-3 Responsiveness | Git-event reconcile debounced 400 ms; state-file watch debounced 300 ms; SCM sync skipped when selection unchanged. |
| NFR-4 Portability | POSIX + Windows (config dir, key permissions, path handling); works on VS Code Remote-SSH / Codespaces / dev containers. |
| NFR-5 Platform | Node.js >= 24 (`tsup` target `node24`), VS Code >= 1.83, pnpm 10. |
| NFR-6 Observability | Extension output channel ("Git Colabor"); CLI debug log with 2 MiB rotation; local audit trail. |
| NFR-7 Testability | CLI: 40 unit + 15 e2e tests (real `git` + `ssh-keygen` in isolated temp dirs, including a "secrets never in audit" assertion). Extension: 6 unit tests (askpass protocol, CLI client). Integration suite (test-electron) is M6. |
| NFR-8 Reversibility | Every repo mutation is backed up on first touch and restorable via `revert`; the tool cleans up its own markers. |

## 6. Known gaps (declared but not yet enforced in 0.1.0)

For honesty, these settings exist in `package.json` but the extension does not yet read them:

- `gitColabor.postCommitSolo` — no `COMMIT_EDITMSG` watcher exists yet.
- `gitColabor.githubFetch` — GitHub `noreply` email fetch not implemented.
- `gitColabor.logLevel` — the output channel level is not wired to it.
- `gitColabor.autoApplyOnRepoOpen`, `gitColabor.conflictWarningStaleMinutes` — helpers exist but are not consulted (auto-apply always on; staleness is the CLI's 5-minute default).

They are tracked for M6+; see [../plan.md](../plan.md).

## 7. Milestone traceability

| Milestone | Delivers | FRs | Status |
| --- | --- | --- | --- |
| M1 — CLI co-author core | `.git-coauthors` store, selection, template seeding | FR-7–FR-10 | ✅ done |
| M2 — CLI identity | identity CRUD, apply/revert/logout, keys, agent, askpass, audit, doctor | FR-1–FR-6, FR-11–FR-14 | ✅ done |
| M3 — Extension bridge | bundled-CLI client, askpass server, secrets, git API, commands, logging | FR-21–FR-22, FR-24 | ✅ done |
| M4 — Extension UI | SCM tree, status bar, SCM sync, drift watchers | FR-15–FR-20 | ✅ done |
| M5 — Hardening | setting-wins reconcile, conflict warnings, Windows perms, redaction tests | FR-18, NFR-1, NFR-7 | ✅ done |
| M6 — Docs & release | this doc set, integration suite, publishing | FR-23, NFR-7 | 🚧 in progress |
