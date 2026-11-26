# Architecture

How Git Colabor is put together — module map, data flow, and the protocols between the extension and the CLI.

## 1. System overview

Two packages, one product:

```mermaid
flowchart LR
    subgraph ext ["VS Code extension (this repo)"]
        UI ["SCM tree view<br/>commands"]
        REC ["ReconcileController"]
        SYNC ["ScmSync (input box)"]
        APS ["AskpassServer<br/>(UNIX socket · Windows named pipe)"]
        CC ["CliClient"]
        SESS ["SessionIdentityController<br/>env injection (host + terminals)"]
    end
    subgraph cli ["git-colabor CLI (packages/git-colabor, bundled)"]
        CLIC ["cli.cjs<br/>coauthor / identity"]
        CORE ["core: identity, coauthors,<br/>repo state, audit, git"]
        APH ["askpass.cjs<br/>(SSH_ASKPASS helper)"]
    end
    GIT["git / ssh-add / ssh-agent<br/>(workspace side)"]

    UI -->|"identity status --json"| CC
    REC -->|"identity status --json (bootstrap pick)"| CC
    REC -->|"session.apply (env injection)"| SESS
    CC -->|"spawn process.execPath"| CLIC
    CLIC --> CORE
    CORE -->|"exec (arg arrays)"| GIT
    CORE -.->|"SSH_ASKPASS=askpass.cjs"| APH
    APH -->|"token + fingerprint"| APS
    APS --> SEC
```

Key decisions:

- **The CLI owns all git/SSH logic.** The extension is a UI and bridge; it never shells out to git itself. Everything runs **workspace-side** (where the repo and `ssh-agent` live), so Remote-SSH / Codespaces behave like local.
- **The extension consumes built output, not source.** `packages/git-colabor/` is a workspace package (also published to npm standalone); `build-scripts/copy-cli.mjs` copies its `dist/{cli,askpass}.cjs` into the extension's `resources/` at build time. The vsix therefore ships with **zero runtime `node_modules`**.
- **One process boundary, one protocol.** Extension ↔ CLI speaks a stable `--json` envelope (§3). Passphrases cross a *second*, separate channel — the askpass socket (§4) — never argv.

## 2. Extension module map (`src/`)

| Module | Responsibility |
| --- | --- |
| `extension.ts` | Activation: session id (`ext_<hex>`), AskpassServer + session file, GitApi, CliClient, tree view, ScmSync, commands, watchers, reconcile wiring; dispose logic |
| `cli/CliClient.ts` | Spawns `resources/cli.cjs` with `process.execPath` (the VS Code Server's Node — no `$PATH` dependency), injects `GIT_COLABOR_SOURCE=ext` + askpass env + `GIT_COLABOR_GIT` (the git vscode.git runs), parses the JSON envelope, maps spawn/parse failures to `SPAWN_FAILED` / `BAD_JSON`, logs each failure's `code: message` once per distinct cause |
| `askpass/AskpassServer.ts` | `node:net` UNIX socket `<dataDir>/askpass-<sessionId>.sock` (dir `0700`, socket `0600`), or a named pipe `\\.\pipe\git-colabor-askpass-<sessionId>` on Windows (Node has no filesystem sockets there — a `.sock` path fails to bind with `EACCES`); one request per connection: `{"token","fingerprint"}` → passphrase bytes; silent close on any failure so callers fall through |
| `git-ext/GitApi.ts` | Minimal typed wrapper over `vscode.git` API v1: repositories, open/close/`ui.onDidChange` subscription, selected-repo resolution **and `repoRoots` (all open repos — identity actions apply session-wide)**; exposes `gitPath`, the git executable vscode.git actually runs (often not the `git` on this host's `PATH`) |
| `tree/IdentityTreeProvider.ts`, `tree/items.ts` | SCM view `gitColabor.identitiesView`: guidance rows only at the top (no repo / no active identity — the active identity is NOT duplicated at root; the Identities group marks it ✓), Identities group, and **one merged Co-authors list** (all identities minus the active one ∪ `gitColabor.coAuthorIdentities` memory in user/machine/workspace layers ∪ repo commit history, email-deduped; empty state explains how to add) whose rows show `+`/`-` by whether the author's trailer is in the SCM input box (polled — the git API has no inputBox change event; no context menu on these rows — clicking toggles the trailer); identity rows instead carry the memory bits in their contextValue (`-k` key, `-a` key-in-agent, `-ss`/`-sg` signing with this identity's SSH/GPG key, `-ru`/`-rm` remembered), driving the right-click modify / agent load-remove / signing / remember-forget menus; a **Signing** row shows the effective commit signing and its layer (§5.1) |
| `session/SessionIdentity.ts`, `session/signing.ts` | Window-scoped identity + signing via git env injection (`GIT_CONFIG_COUNT/KEY_n/VALUE_n`); pure helpers resolving an identity's signing key, overlaying the window layer on the CLI's effective signing, and detecting a key that is not the committer's |
| `scm/Sync.ts` | Idempotent reseed of `Co-authored-by:` trailers into the SCM input box (skip when the sorted-email key is unchanged) |
| `reconcile/ReconcileController.ts` | Setting-wins enforcement (§6) |
| `commands/` | All palette commands + internal tree-click commands, split by area (`identity.ts`, `coauthor.ts`, `signing.ts`, `misc.ts`, `shared.ts`, `index.ts`) |
| `config.ts`, `log.ts`, `types.ts` | Settings access (incl. `gitColabor.coAuthorIdentities` user/workspace memory), output channel, local mirror of the CLI JSON types (`StatusJson` incl. `signing`) |

## 3. The `--json` bridge

Every CLI command accepts `--json` and prints one compact line:

```json
{"ok":true,"data":{…},"warnings":[{"code":"conflict","message":"…"}]}
{"ok":false,"error":{"code":"NOT_FOUND","message":"…","hints":[…],"exitCode":5},"data":null}
```

- `CliClient.run(args)` defaults to JSON mode and returns the parsed envelope; the process exit code travels inside `error.exitCode` (0 ok · 1 runtime · 2 usage · 3 not-a-repo · 4 secret-unavailable · 5 not-found · 6 conflict-blocked).
- `types.ts` keeps a **hand-maintained mirror** of the CLI's JSON shapes (`StatusJson`, `IdentityJson`, `HeldByJson`, …) — there is no runtime dependency between the packages, so the mirror must be updated together with `git-colabor/src/core/types.ts`.
- `identity status --json` is the UI's heartbeat: the tree provider and ScmSync re-render from it. When the call fails the view shows the CLI's `code: message` as a single row (nothing to act on) — it must never re-fetch from inside its own reload event, or a failing CLI turns the refresh into a loop.

## 4. The askpass bridge (passphrase channel)

Goal: `ssh-add` needs the passphrase; the extension holds it in a **session-scoped in-memory map** (never on disk — closing the window, reloading, or a Remote-SSH reconnect drops it and re-prompts); it must never appear on `argv` (visible in `ps`), in the CLI's logs, or in the audit log.

```mermaid
sequenceDiagram
    participant E as Extension (AskpassServer)
    participant C as CLI (loadKey)
    participant A as askpass.cjs (SSH_ASKPASS)
    participant S as ssh-add

    C->>S: setsid ssh-add <key> (env: SSH_ASKPASS=askpass.cjs, SSH_ASKPASS_REQUIRE=force, GIT_COLABOR_ASKPASS_SOCK/TOKEN)
    S->>A: prompts for passphrase
    A->>E: {"token","fingerprint"}\n over the askpass endpoint (socket / named pipe)
    E->>E: timingSafeEqual(token); lookup in sessionPassphrases (memory)
    E-->>A: passphrase bytes (or silent close)
    A-->>S: passphrase on stdout
    S-->>C: key loaded (or fail → next strategy)
```

- **No auto-load:** `identity use` never touches ssh-agent — it applies the config and reports agent presence (`agent.inAgent`). Putting a key INTO the agent is the explicit `identity agent <id>` command (tree right-click "Load Key into ssh-agent"); `--remove` takes it out. Passphrase correctness is checked without any agent write via `identity agent <id> --verify` (`ssh-keygen -y` under the askpass env).
- **Load strategy chain** (manual load only; never throws; reports `via`): plain `ssh-add` → macOS keychain (`--apple-use-keychain`, when supported) → askpass bridge → interactive tty.
- **Push-time delivery:** when a bridge session exists (env socket or a live `session-*.json`), the SSH_ASKPASS prefix is baked into `core.sshCommand` so push/fetch fetches the passphrase from the session store. Without a bridge the bare `ssh -i <key>` is written instead — ssh then uses ssh-agent if the key is loaded, else prompts on the tty each operation (pure-CLI behavior; `identity use` prints an `agent-reminder` pointing at `ssh-add <key>`).
- **Discovery for terminal use:** the extension writes `<dataDir>/session-<pid>.json` (`0600`: sessionId, socketPath, token), so a user-invoked `git colabor` in the integrated terminal can find the bridge even though it wasn't spawned by the extension.
- **Failure is silent by design:** on any protocol error the server closes without writing, and the caller falls through to the next strategy rather than blocking a commit.

## 5. Identity apply (config write)

`identity use <id>` (CLI core `identity/apply.ts`):

1. Detect conflict — if per-repo `state.heldBy` names a *different, fresh* (< 5 min) session, warn (or refuse with exit 6 under `--no-override`).
2. Write local config: `user.name`, `user.email`, `core.sshCommand` (only if the identity has a key); while the repo's opt-in signing is on (`identity sign`), re-bind it to this identity's key — its bound GPG key (`gpg.format=openpgp`), else its SSH key (`gpg.format=ssh`) — or turn it off when the identity has none (§5.1). No `colabor.*` markers, no state backups — the repo reads as if a human configured it.
3. Update state (`activeIdentity`, `heldBy=<this session>`), append audit `identity.use`.

Removal is **content-matched** (`identity logout`, core `identity/configClear.ts`): only keys whose values match the identity being removed are unset — another person's config survives. Keys are **referenced, never copied** — a broken reference (moved/deleted source) makes `identity use` degrade to a key-less apply (no `core.sshCommand`, no agent load, `key-missing` warning).

### 5.1 Commit signing layers

Whether `git commit` signs is the result of layered git config — this window's env injection (git's `command` scope) > repo `local` > `global` > `system` — so signing follows the layer its identity lives in:

| Identity | Sign | Stop |
| --- | --- | --- |
| Window identity (default click), or none | env-inject `commit.gpgsign=true`, `gpg.format`, `user.signingKey` (+ `gpg.ssh.program` sign wrapper for SSH) | env-inject `commit.gpgsign=false` |
| Config-written identity (*Use & write git repo config*) | `identity sign <id>` writes the same keys locally | `identity sign --off` drops them and pins local `commit.gpgsign=false` when global/system would still sign |

- **Off means off.** Unsetting alone falls back to lower scopes — e.g. a personal GPG key in `~/.gitconfig` would keep signing every identity's commits — so Stop always writes an explicit `false` at its layer. Logout, disable and switching to a key-less identity turn repo signing off the same way.
- **Key choice:** an identity signs with its bound GPG key (`identity set --gpg-key`, picked from `identity gpg-keys`), else its SSH key (`.pub` half when agent-held). OpenPGP keeps the user's own `gpg.program` and gpg-agent pinentry — no askpass involved. While signing is on, an identity switch re-binds to the new identity's key, or turns signing off when it has none.
- **Effective state:** `identity status` reports `signing` as git resolves it (`enabled`, `format`, `key`, `scope` + `origin` file of `commit.gpgsign`, and the GPG key's `keyEmails`); the CLI runs with `GIT_CONFIG_COUNT=0`, so the extension overlays the window layer itself (`session/signing.ts`). The **Signing** row shows the result and its layer, and warns when the key is not the active identity's (another identity's key, or a GPG key without their email); applying a window identity into that state prompts once.
- The window layer covers the Source Control view (extension-host env) **and integrated terminals**: new terminals via the `environmentVariableCollection` mirror, already-open ones by sourcing the written `session-env-<window>.sh` (`GIT_SSH_COMMAND` + `GIT_AUTHOR_/GIT_COMMITTER_*` plain vars work on any git version; `GIT_CONFIG_*` pairs need git ≥ 2.31). Signing stays on `GIT_CONFIG_*` only.

## 6. The reconcile bootstrap (auto-apply, session-scoped)

`ReconcileController` bootstraps the window's session identity. It **never writes repo config** — the chosen identity is applied via env injection (§5), so repo files stay untouched:

1. Resolve **every open repository** of the window (`vscode.git`); none known yet → not consumed, retried when a repo appears.
2. Wait for store enrollment (remembered identities are registered on first activation of a fresh host — resolving `defaultIdentity` against an empty store would wrongly conclude "nothing to apply").
3. Pick by priority: a **repo-config identity** comes first — the file already carries it, so NOTHING is applied (row shows "found in repo config", signing reads its real layer from the config — no "session only" label, no window signing overlay). Otherwise **`gitColabor.defaultIdentity`** (alias > unique email > picker on a shared email) is **session-applied** — unless the config already carries the SAME identity (then the config is followed, no env layer). The default still outranks a DIFFERENT identity merely inherited from a (possibly stale) `~/.gitconfig`. A **global-config** identity follows its file like the repo tier.
4. `session.apply(row)` only for the default tier — env injection for the whole window.

It runs only while **no session identity is active** — an explicit Use (or an active session from a repo already bootstrapped) makes it stand down; after that the session identity changes only by explicit Use.

**Triggers:** activation (after store enrollment); every `vscode.git` repo event and focused-repo change (400 ms / 1 s debounce) while no session identity is active. `gitColabor.autoApplyOnRepoOpen: false` disables the bootstrap entirely (explicit Use only). The state-file watcher below deliberately triggers only a *refresh* — reconciling on it would fight the terminal CLI that just wrote the state.

## 7. UI refresh & drift watchers

| Watcher | Event | Action |
| --- | --- | --- |
| `fs.watch(<each repo>/.git/colabor/state.json)` (one watcher per open repo) | terminal `git colabor` ran out-of-band in any repo | 300 ms debounce → tree refresh only |
| `onDidSaveTextDocument` | (reserved — no-op today) | refresh |
| `vscode.git` subscription | repo open/close, selection change | 400 ms debounce → reconcile + refresh |
| `provider.onDidReload` | every reload | ScmSync reseed + the active-key passphrase check (it only ever reads the status the event delivers) |

ScmSync strips all existing `Co-authored-by:` lines from the SCM input box value and re-appends the current selection — but computes a key from the sorted selected emails and skips the write when unchanged, so a user typing in the box is never clobbered mid-keystroke. In the other direction, the co-author tree rows read the box (`scm/trailers.ts` parses/appends/removes single trailers) and a 1.5 s poll refreshes the `+`/`-` markers as the user types; toggling a row edits the box directly and syncs exactly the toggled author with `coauthor add`/`rm` so the commit template follows (manually typed trailers are never touched).

## 8. Data model (what lives where)

| Store | Path | Written by | Mode |
| --- | --- | --- | --- |
| Identity map | `~/.config/git-colabor/identities.json` (Win: `%APPDATA%\git-colabor\…`) | CLI | `0600`, atomic tmp+rename |
| Referenced keys | wherever the user put them (absolute path in `identities.json`) | user | user-managed |
| Audit log | `…/git-colabor/audit.log` (JSONL) | CLI | `0600` per append |
| Askpass socket + session file | `…/git-colabor/askpass-<session>.sock`, `session-<pid>.json` | extension | `0600` (dir `0700`) |
| Per-repo state | `<git-dir>/colabor/state.json` | CLI | `0600`, atomic |
| Commit template | `~/.gitmessage` or `commit.template` | CLI | — |
| Passphrases | session-scoped in-memory map (extension host process) | extension | never on disk |
| Git config (local) | `user.name`, `user.email`, `core.sshCommand`, `colabor.selected` (multi); opt-in `commit.gpgsign`, `gpg.format`, `user.signingKey`, `gpg.ssh.program` (§5.1) | CLI | — |

Atomicity rule: every JSON store is written via write-tmp-then-rename, so a crash mid-write never corrupts state.

## 9. Error handling

- CLI: typed `AppError` codes → stable exit codes (§3) + `hints[]` in the envelope; the extension surfaces them as `Git Colabor: <message>` + hints.
- All `git` / `ssh-add` / `ssh-keygen` invocations use **argument arrays** (never shell strings), so file paths with spaces or metacharacters are safe and nothing is injection-reachable through repo paths.
- The CLI never throws for *expected* failures (key load, permission tightening, audit append are best-effort with `warnings`); it exits non-zero only for conditions the caller must handle.

## 10. Build & packaging flow

```mermaid
flowchart LR
    A["git-colabor/src<br/>(TS)"] -->|"pnpm -C packages/git-colabor build<br/>tsup, node24, noExternal:*"| B["git-colabor/dist/<br/>cli.cjs · index.cjs · askpass.cjs"]
    C["src/ (extension TS)"] -->|"tsup → dist/extension.cjs<br/>(external: vscode)"| D["dist/extension.cjs"]
    B -->|"build-scripts/copy-cli.mjs"| E["resources/cli.cjs<br/>resources/askpass.cjs"]
    D & E -->|"vsce package --no-dependencies"| F["vsix<br/>(no runtime node_modules)"]
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for commands and release procedure.
