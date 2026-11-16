#!/bin/bash
#
# Manage a macOS LaunchAgent that runs the Canvas MCP worker in the
# background (no Terminal window required).
#
#   scripts/launchagent.sh install     generate the plist and start the agent
#   scripts/launchagent.sh start       start the agent (after install)
#   scripts/launchagent.sh stop        stop the agent
#   scripts/launchagent.sh restart    stop, then start
#   scripts/launchagent.sh status     show whether the agent is running
#   scripts/launchagent.sh uninstall  stop the agent and remove the plist
#
# What it does:
#   - Writes ~/Library/LaunchAgents/dev.canvas-mcp.server.plist, pointing at
#     THIS repository checkout (paths are resolved at install time and only
#     exist on your machine - nothing machine-specific is committed).
#   - NOTE: the generated plist stores the absolute path of the Node.js
#     binary resolved at install time. If you switch or upgrade your Node
#     installation (e.g. via Homebrew or a version manager), rerun
#     'scripts/launchagent.sh install' and then 'restart'.
#   - Runs `node node_modules/wrangler/wrangler-dist/cli.js dev`, which reads
#     credentials from this repo's .dev.vars (gitignored). Credentials are
#     never copied anywhere and never logged by the worker.
#   - Starts at login (RunAtLoad) and restarts on crash (KeepAlive).
#   - Writes logs to ~/Library/Logs/canvas-mcp/{out,err}.log
#   - The server stays reachable at http://localhost:8787/mcp
#
# Requires: no root. launchd runs this as your user.

set -euo pipefail

LABEL="dev.canvas-mcp.server"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/canvas-mcp"
PORT="${CANVAS_MCP_PORT:-8787}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER_CLI="$REPO_DIR/node_modules/wrangler/wrangler-dist/cli.js"

UID_NUM="$(id -u)"
SERVICE_TARGET="gui/$UID_NUM/$LABEL"

say() { printf '%s\n' "$*"; }

require_deps() {
  if ! command -v node >/dev/null 2>&1; then
    say "error: node not found in PATH. Install Node.js (>= 22.12) first." >&2
    exit 1
  fi
  if [ ! -f "$WRANGLER_CLI" ]; then
    say "error: wrangler not installed. Run 'npm install' in $REPO_DIR first." >&2
    exit 1
  fi
  if [ ! -f "$REPO_DIR/.dev.vars" ]; then
    say "warning: $REPO_DIR/.dev.vars not found." >&2
    say "         The worker will start but Canvas tools will be unconfigured." >&2
    say "         Copy .dev.vars.example to .dev.vars and add your credentials." >&2
  fi
}

port_pid() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

is_loaded() {
  launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

generate_plist() {
  NODE_BIN="$(command -v node)"
  mkdir -p "$PLIST_DIR" "$LOG_DIR"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>--no-warnings</string>
        <string>$WRANGLER_CLI</string>
        <string>dev</string>
        <string>--port</string>
        <string>$PORT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF
  say "wrote $PLIST"
}

cmd_install() {
  require_deps
  generate_plist
  local pid
  pid="$(port_pid)"
  if [ -n "$pid" ] && ! is_loaded; then
    say "note: something (pid $pid) is already listening on port $PORT."
    say "      If that is a manually started 'npm start', stop it first so the"
    say "      LaunchAgent can bind the port, then run: $0 start"
    exit 0
  fi
  cmd_start
}

cmd_start() {
  if [ ! -f "$PLIST" ]; then
    say "error: $PLIST not found. Run '$0 install' first." >&2
    exit 1
  fi
  if is_loaded; then
    say "already running (use '$0 restart' to reload)"
    exit 0
  fi
  mkdir -p "$LOG_DIR"
  # bootstrap takes the DOMAIN target (gui/<uid>); the service id comes
  # from the Label inside the plist.
  if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>"$LOG_DIR/bootstrap.err"; then
    say "warning: launchctl bootstrap failed (see $LOG_DIR/bootstrap.err); trying legacy load" >&2
    launchctl load "$PLIST"
  fi
  say "started - MCP endpoint: http://localhost:$PORT/mcp"
}

stop_agent() {
  launchctl bootout "$SERVICE_TARGET" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  # bootout is asynchronous: wait for the service to unregister and the port
  # to be released before returning (up to ~15s).
  local i pid
  for i in $(seq 1 30); do
    if ! is_loaded; then
      pid="$(port_pid)"
      if [ -z "$pid" ]; then
        return 0
      fi
      # Process is exiting; give it more time before forcing anything.
    fi
    sleep 0.5
  done
  # Still holding the port: if it is an orphaned workerd/wrangler from this
  # repo checkout, kill it.
  pid="$(port_pid)"
  if [ -n "$pid" ] && ps -p "$pid" -o command= | grep -qF "$REPO_DIR/node_modules/"; then
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
}

cmd_stop() {
  if ! is_loaded; then
    say "not running"
  else
    stop_agent
    say "stopped"
  fi
}

cmd_restart() {
  if is_loaded; then
    stop_agent
  fi
  cmd_start
}

cmd_status() {
  if is_loaded; then
    say "running (launchd target $SERVICE_TARGET)"
    local pid
    pid="$(port_pid)"
    if [ -n "$pid" ]; then
      say "listening on port $PORT (pid $pid)"
    else
      say "warning: agent is loaded but nothing is listening on port $PORT - check logs:"
      say "  tail -n 50 $LOG_DIR/err.log"
    fi
  else
    say "not running"
    exit 1
  fi
}

cmd_uninstall() {
  cmd_stop
  rm -f "$PLIST"
  say "removed $PLIST"
  say "logs left in place: $LOG_DIR"
}

case "${1:-install}" in
  install)   cmd_install ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  uninstall) cmd_uninstall ;;
  *)
    say "usage: $0 {install|start|stop|restart|status|uninstall}" >&2
    exit 1
    ;;
esac
