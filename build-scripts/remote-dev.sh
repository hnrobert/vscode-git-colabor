#!/usr/bin/env bash
# One-command remote dev loop for the Git Colabor extension.
#
# Why this exists: `--extensionDevelopmentPath` does NOT carry into a
# Remote-SSH window (the dev extension is never installed server-side), so
# F5 cannot test remote behavior. Instead: build + package the vsix, push it
# to the host, install it into the vscode-server with the server's own CLI,
# ask already-open windows to do a FULL reload (they watch a marker file and
# run "Developer: Reload Window" — package.json menu contributions only
# refresh on a window reload), and open/focus the remote window.
#
# Usage:
#   build-scripts/remote-dev.sh dev <host> [remote-dir]
#       One-shot demo: provision a demo repo (multi-committer history +
#       .git-coauthors, idempotent — default $HOME/git-colabor-demo on the
#       host) and run the full install below, then open it.
#   build-scripts/remote-dev.sh install <host> <remote-dir>
#       Full loop: build → package → upload → server-side install →
#       reload marker → open window. No defaults: pass both args.
#   build-scripts/remote-dev.sh logs <host>
#       Tail the newest remote extension-host log (the "dev console").
#   build-scripts/remote-dev.sh status <host>
#       Show whether the extension is installed on the server.
#
# The host alias must exist in ~/.ssh/config (used by ssh) and must be the
# same name Remote-SSH shows (used as ssh-remote+<host>).

set -euo pipefail

usage() {
  echo "usage: $0 dev <host> [remote-dir]" >&2
  echo "       $0 install <host> <remote-dir>" >&2
  echo "       $0 logs <host>" >&2
  echo "       $0 status <host>" >&2
  exit 2
}

COMMAND="${1:-}"
HOST="${2:-}"
case "$COMMAND" in
  dev) [ -n "$HOST" ] || usage ;;
  install) REMOTE_DIR="${3:-}"; [ -n "$HOST" ] && [ -n "$REMOTE_DIR" ] || usage ;;
  logs|status) [ -n "$HOST" ] || usage ;;
  *) usage ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Locate the vscode-server install on the host. Prefer the server matching
# the local VS Code commit (extensions are shared across commits, but the
# running server is the one that matters), else the newest.
remote_server_dir() {
  local want_commit
  want_commit="$(code --version | sed -n 2p)"
  ssh -o IdentitiesOnly=yes "$HOST" "
    s=\$(ls -d ~/.vscode-server/cli/servers/Stable-$want_commit/server 2>/dev/null | head -1)
    [ -n \"\$s\" ] || s=\$(ls -d ~/.vscode-server/cli/servers/Stable-*/server 2>/dev/null | sort -V | tail -1)
    [ -n \"\$s\" ] || { echo 'no vscode-server found on host' >&2; exit 1; }
    echo \"\$s\"
  "
}

# Ask already-running windows on the host to pick up the new build: the
# extension polls <dataDir>/dev-reload. The marker carries the sha256 of the
# NEW package.json — when the running extension compares it against its own
# package.json and they match (code-only deploy: commands/menus unchanged),
# it restarts just the extension host; a mismatch (new commands/menus) needs
# a full window reload. (Windows running a build from before this mechanism
# need one last manual "Developer: Reload Window".)
touch_reload_marker() {
  HASH="$(shasum -a 256 "$ROOT/package.json" | cut -d' ' -f1)"
  ssh -o IdentitiesOnly=yes "$HOST" "mkdir -p \"\$HOME/.config/git-colabor\" && printf '%s' '$HASH' > \"\$HOME/.config/git-colabor/dev-reload\""
}

# Provision the demo repo on the host (idempotent): a short history with
# several committers (so identity auto-import has candidates the moment the
# window opens) plus a .git-coauthors catalogue.
setup_demo_repo() {
  ssh -o IdentitiesOnly=yes "$HOST" '
    set -e
    dir="'"$REMOTE_DIR"'"
    if [ -d "$dir/.git" ]; then
      echo "demo already provisioned: $dir"
      exit 0
    fi
    mkdir -p "$dir" && cd "$dir"
    git init -q
    c() { git -c user.name="$1" -c user.email="$2" commit -q --allow-empty -m "$3"; }
    c "Alice Example" alice@example.com "initial commit"
    c "Bob Pair" bob@example.com "feature: co-author flow"
    c "Alice Example" alice@example.com "fix: trailer sync"
    c "Carol Import" carol@example.com "docs: demo history"
    cat > .git-coauthors <<"EOF"
{
  "coauthors": {
    "jd": { "name": "Jamie Doe", "email": "jamie@example.com" },
    "rk": { "name": "Richard Kotze", "email": "rkotze@example.com" }
  }
}
EOF
    git add .git-coauthors
    git -c user.name="Alice Example" -c user.email=alice@example.com commit -q -m "add co-author catalogue"
    echo "demo created: $dir (5 commits / 3 committers / .git-coauthors)"
  '
}

do_install() {
  echo "==> build + package"
  (cd "$ROOT" && pnpm build >/dev/null && pnpm package >/dev/null)
  VSIX="$(ls -t "$ROOT"/vscode-git-colabor-*.vsix | head -1)"
  VSIX_NAME="$(basename "$VSIX")"
  echo "    packaged: $VSIX_NAME"

  echo "==> upload to $HOST"
  # scp's SFTP subsystem may be unavailable on the host (NAS etc.), so push
  # the file through plain ssh stdin instead.
  # \$HOME so the path expands on the host, not locally (remote $HOME may
  # differ, and a literal ~ would not expand inside the quoted command).
  REMOTE_VSIX="\$HOME/git-colabor-dev.vsix"
  ssh -o IdentitiesOnly=yes "$HOST" "cat > $REMOTE_VSIX" < "$VSIX"

  echo "==> install into vscode-server on $HOST"
  SERVER="$(remote_server_dir)"
  ssh -o IdentitiesOnly=yes "$HOST" "\"$SERVER/node\" \"$SERVER/out/server-main.js\" --install-extension \"$REMOTE_VSIX\" --force"
  ssh -o IdentitiesOnly=yes "$HOST" "rm -f $REMOTE_VSIX"

  echo "==> verify"
  if ssh -o IdentitiesOnly=yes "$HOST" "\"$SERVER/node\" \"$SERVER/out/server-main.js\" --list-extensions --show-versions" | grep -F "hnrobert.vscode-git-colabor@"; then
    echo "    installed server-side ✓"
  else
    echo "    ERROR: extension not found in server list" >&2
    exit 1
  fi

  echo "==> ask open windows for a full reload"
  touch_reload_marker

  echo "==> open remote window"
  if host_has_window; then
    echo "    a window is already connected — the reload marker above updated it; not opening another"
  else
    code --remote "ssh-remote+$HOST" "$REMOTE_DIR"
  fi
  echo "
Done. Windows on $HOST watch the dev-reload marker and reload themselves
within ~2s (windows still running a pre-marker build need one last manual
'Developer: Reload Window'). Live logs: $0 logs $HOST"
}

# Is a VS Code window with our extension already connected to this host?
# A live askpass socket proves it (each window's extension host starts one;
# dead hosts/windows leave stale files but the connect fails). Unknown
# (no python3) counts as "no window" — the conservative default opens one.
host_has_window() {
  ssh -o IdentitiesOnly=yes "$HOST" 'python3 - <<"PY" 2>/dev/null
import glob, json, os, socket, sys
files = sorted(glob.glob(os.path.expanduser("~/.config/git-colabor/session-*.json")), key=os.path.getmtime, reverse=True)
for f in files[:5]:
    try:
        d = json.load(open(f))
    except Exception:
        continue
    try:
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(1)
        s.connect(d["socketPath"])
        s.close()
        sys.exit(0)
    except Exception:
        continue
sys.exit(1)
PY'
}

case "$COMMAND" in
  dev)
    if [ -z "${3:-}" ]; then
      REMOTE_DIR="$(ssh -o IdentitiesOnly=yes "$HOST" 'echo "$HOME/git-colabor-demo"')"
    else
      REMOTE_DIR="$3"
    fi
    echo "==> provision demo repo"
    setup_demo_repo
    do_install
    ;;

  install)
    do_install
    ;;

  logs)
    ssh -o IdentitiesOnly=yes "$HOST" 'LOGS=$(ls -td ~/.vscode-server/data/logs/*/ 2>/dev/null | head -1); find "$LOGS" -path "*exthost*" -name "*.log" 2>/dev/null | head -3 | xargs -r tail -f'
    ;;

  status)
    SERVER="$(remote_server_dir)"
    echo "server: $HOST:$SERVER"
    ssh -o IdentitiesOnly=yes "$HOST" "\"$SERVER/node\" \"$SERVER/out/server-main.js\" --list-extensions --show-versions" | grep -i "vscode-git-colabor" || echo "(git-colabor not installed on $HOST)"
    ;;
esac
