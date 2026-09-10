# Security Model

What Git Colabor protects, how, and — just as important — what it does **not** protect against. Design context: [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Assets & adversaries

**Assets (in order of sensitivity):**

1. SSH private keys (referenced in place — never copied)
2. Key passphrases (VS Code SecretStorage ↔ `ssh-add`)
3. Repo identity state and backups (integrity, not confidentiality)
4. The audit trail (integrity)

**Adversaries the design targets:**

| Adversary | Mitigation |
| --- | --- |
| Another *user* on a shared machine (different OS account) reading key material | no tool-owned key copies exist; `0600` state / audit / identities.json; `0700` data dir; `0600` askpass socket & session file |
| Any local observer seeing passphrases in the process list (`ps`) | Passphrases never touch `argv`: they travel over the askpass socket or a passphrase command, never as CLI arguments |
| Secrets leaking into logs / the audit trail | Logger keeps a process-global redaction set; the audit log records **fingerprints only** — key bodies and passphrases are never written (asserted by an e2e test) |
| Injection through repo paths / author names | Every `git` / `ssh-add` / `ssh-keygen` call uses argument arrays, never a shell string |

**Out of scope (see §6):** malware already running as *your* user, other users of your VS Code profile, and network adversaries — this is a local-machine trust model.

## 2. Private key storage (reference mode)

- Keys are **referenced, never copied**: `identity add --key <path>` records the absolute source path plus its fingerprint; the file is never modified, moved, or deleted by the tool, and no second copy exists anywhere.
- Usability is checked at `use` time (`ssh-keygen -lf` must parse it). A broken reference — moved, renamed, rotated, or deleted source — **degrades to a key-less apply**: name/email still switch, `core.sshCommand` is not written, the agent load is skipped, and a `key-missing` warning surfaces. The identity keeps its key reference for when the file returns.
- Encryption status is probed at import with `ssh-keygen -y -P "" -f <key>`:
  - encrypted key without a `--passphrase-command` → `encrypted-key` warning;
  - unencrypted key → `unencrypted-key` warning.
- `identity logout` removes the key from `ssh-agent` only — the file itself belongs to the user and is never touched; deleting it is the user's call.

## 3. Passphrase handling

The invariant: **a passphrase is never a command-line argument, never an environment variable value that outlives the helper process, and never a logged string.**

Resolution order when loading a key (each step falls through on failure):

1. plain `ssh-add <key>` (agent or unencrypted key)
2. macOS Keychain (`ssh-add --apple-use-keychain`, when supported)
3. **askpass bridge** (extension context — §4) or **`passphrase-command`** (standalone CLI context)
4. interactive tty prompt (`stty -echo` on POSIX)

`passphrase-command` caveats you should understand before using it:

- The command string is stored **in plaintext** inside the `0600` `identities.json` — anyone who can read that file reads the command. Store a *command that retrieves* the secret (e.g. `op read "op://Private/ssh/pass"`), never the secret itself.
- It is executed with `shell: true` (one string, your shell's syntax). Write it as if it were public: quote it, and don't interpolate user-controlled repo data into it.

## 4. The askpass bridge protocol

How `ssh-add` obtains an extension-stored passphrase ([ARCHITECTURE.md §4](ARCHITECTURE.md#4-the-askpass-bridge-passphrase-channel) for the sequence diagram):

- **Endpoint:** a UNIX-domain socket at `<dataDir>/askpass-<sessionId>.sock`. The data dir is `0700`, the socket `0600` — only your OS user can connect.
- **Authentication:** every request carries a token generated per extension session (`randomBytes(32).toString('hex')`), compared with `node:crypto.timingSafeEqual` after a length check. A wrong token gets no error message — the connection simply closes without a response.
- **Request shape:** exactly one JSON line `{"token":"…","fingerprint":"…"}`. Only the first request per connection is handled. The response is the raw passphrase bytes; unknown fingerprint → silent close (the helper falls through to the next strategy instead of hanging).
- **Discovery:** the socket endpoint is exported via `<dataDir>/session-<pid>.json` (`0600`) so a `git colabor` you run in the integrated terminal can use the bridge. Treat that file like a capability: its reader can *ask the extension for passphrases it already knows*, nothing more.
- **Lifecycle:** the socket is unlinked on extension deactivate; stale sockets from crashed sessions are unlinked before listen.

What the token+socket protects against: *other OS users* connecting to the socket. What it cannot protect against: code running as your user (it can read the session file and query the bridge like any helper) — see §6.

## 5. Audit & logging

- Audit entries record: timestamp, action, identity id/name, **key fingerprint** (never the key body), repo, host, OS user, session source (`cli`/`ext`), result. The log is JSONL, mode `0600`, appended atomically; append failures never fail the user's command.
- The CLI logger maintains a `redactable` set (passphrase strings etc.); every logged message passes through `redact()` replacing occurrences with `[redacted]`.
- The extension logs to the "Git Colabor" output channel; passphrases never enter extension logs because they only ever exist inside SecretStorage reads and socket writes.
- **Regression tests pin these properties:** a unit suite covers logger redaction, and an e2e test (`git-colabor/tests/e2e`) asserts the audit log never contains the passphrase-command secret or the key body after a full add → use → logout cycle.

## 6. Explicit non-guarantees

Honest boundaries of the 0.1.0 model:

1. **Same-user malware.** Anything running as your OS user can read `0600` files (keys, identities.json, session file) and query the askpass socket. No local tool can defend against this; don't treat the data dir as a vault.
2. **Plaintext `passphrase-command`** in identities.json (§3) — the file is `0600`, but the command is not secret against your own user.
3. **No encrypt-at-rest for imported keys** yet (§2).
4. **Audit log integrity** is mode-bit protection only — no signing or tamper-evidence. An attacker with your UID can edit history.
5. **SecretStorage residency:** the extension cannot purge CLI-visible copies of data you typed into a terminal, and the CLI cannot purge VS Code SecretStorage. With reference-mode keys there is no tool-owned key file to purge at all — passphrases in SecretStorage outlive the identity until removed there.
6. **`--json` output goes to stdout** like any CLI; if you pipe it into shared logs, that's your channel to secure. The envelope never contains key material or passphrases.

## 7. Reporting

Found a security issue? Please open a private security advisory on [github.com/hnrobert/vscode-git-colabor](https://github.com/hnrobert/vscode-git-colabor/security/advisories) rather than a public issue.
