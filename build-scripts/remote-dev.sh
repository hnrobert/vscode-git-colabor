#!/usr/bin/env bash
# One-command remote dev loop for the Git Colabor extension.
#
# Why this exists: `--extensionDevelopmentPath` does NOT carry into a
# Remote-SSH window (the dev extension is never installed server-side), so
# F5 cannot test remote behavior. Instead: build + package the vsix, push it
# to the host, install it into the vscode-server with the server's own CLI,
# restart any running extension hosts there (so already-open windows pick up
# the fresh code), and open/focus the remote window.
#
# Usage:
#   build-scripts/remote-dev.sh install <host> <remote-dir>
#       Full loop: build → package → upload → server-side install →
#       restart extension hosts → open window. No defaults: pass both args.
#   build-scripts/remote-dev.sh logs <host>
#       Tail the newest remote extension-host log (the "dev console").
#   build-scripts/remote-dev.sh status <host>
#       Show whether the extension is installed on the server.
#
# The host alias must exist in ~/.ssh/config (used by ssh) and must be the
# same name Remote-SSH shows (used as ssh-remote+<host>).

set -euo pipefail

usage() {
  echo "usage: $0 install <host> <remote-dir>" >&2
  echo "       $0 logs <host>" >&2
  echo "       $0 status <host>" >&2
  exit 2
}

COMMAND="${1:-}"
HOST="${2:-}"
case "$COMMAND" in
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
  ssh "$HOST" "
    s=\$(ls -d ~/.vscode-server/cli/servers/Stable-$want_commit/server 2>/dev/null | head -1)
    [ -n \"\$s\" ] || s=\$(ls -d ~/.vscode-server/cli/servers/Stable-*/server 2>/dev/null | sort -V | tail -1)
    [ -n \"\$s\" ] || { echo 'no vscode-server found on host' >&2; exit 1; }
    echo \"\$s\"
  "
}

# Restart the remote extension hosts so already-open windows load the newly
# installed build. VS Code detects the terminated host and restarts it
# automatically (a full 'Developer: Reload Window' in the window is the
# thorough alternative). No running hosts → nothing to do (the window opened
# below will start fresh code anyway).
restart_remote_exthosts() {
  local pids
  pids="$(ssh "$HOST" "pgrep -f -- '--type=extensionHost' | tr '\n' ' '" || true)"
  if [ -z "${pids// /}" ]; then
    echo "    no open windows on $HOST — nothing to reload"
    return
  fi
  echo "    restarting extension hosts on $HOST (pids:$pids)"
  ssh "$HOST" "pkill -f -- '--type=extensionHost'" || true
}

case "$COMMAND" in
  install)
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
    ssh "$HOST" "cat > $REMOTE_VSIX" < "$VSIX"

    echo "==> install into vscode-server on $HOST"
    SERVER="$(remote_server_dir)"
    ssh "$HOST" "\"$SERVER/node\" \"$SERVER/out/server-main.js\" --install-extension \"$REMOTE_VSIX\" --force"
    ssh "$HOST" "rm -f $REMOTE_VSIX"

    echo "==> verify"
    if ssh "$HOST" "\"$SERVER/node\" \"$SERVER/out/server-main.js\" --list-extensions --show-versions" | grep -F "hnrobert.vscode-git-colabor@"; then
      echo "    installed server-side ✓"
    else
      echo "    ERROR: extension not found in server list" >&2
      exit 1
    fi

    echo "==> reload open windows (if any)"
    restart_remote_exthosts

    echo "==> open remote window"
    code --remote "ssh-remote+$HOST" "$REMOTE_DIR"
    echo "
Done. Windows on $HOST reload their extensions automatically; if a window
still shows the toast 'extension host terminated', click Restart — or run
'Developer: Reload Window' there for a full reload. Live logs: $0 logs $HOST"
    ;;

  logs)
    ssh "$HOST" 'LOGS=$(ls -td ~/.vscode-server/data/logs/*/ 2>/dev/null | head -1); find "$LOGS" -path "*exthost*" -name "*.log" 2>/dev/null | head -3 | xargs -r tail -f'
    ;;

  status)
    SERVER="$(remote_server_dir)"
    echo "server: $HOST:$SERVER"
    ssh "$HOST" "\"$SERVER/node\" \"$SERVER/out/server-main.js\" --list-extensions --show-versions" | grep -i "vscode-git-colabor" || echo "(git-colabor not installed on $HOST)"
    ;;
esac
