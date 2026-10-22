#!/usr/bin/env bash
# log-hub dev sandbox container start (runs as root; PID 1 is tini from `docker run --init`).
#
# Order follows DD-14 of docs/tasks/todo/2026-10-15-claude-dev-container/impl-plan.md (Phase 2):
#   1 markers and ownership · 2 socat · 3 node_modules · 4 profile settings · 5 plugins ·
#   6 drop the PoC plugin override · 7 postgres MCP · 8 provisioning + dev stack · 9 done.
#
# Required env (set by scripts/claude-docker.mjs via `docker run -e`):
#   SANDBOX_NAME, SANDBOX_WORKTREE (container path of the worktree), CLAUDE_CONFIG_DIR.
# Phase 2 env (DATABASE_URL, TEST_DATABASE_URL, SANDBOX_HOST_EMAIL, …) is passed through to the
# services and the provisioning script.
set -euo pipefail

log()  { printf '[entrypoint] %s\n' "$*"; }
warn() { printf '[entrypoint] WARN %s\n' "$*" >&2; }
die()  { printf '[entrypoint] ERROR %s\n' "$*" >&2; exit 1; }

# Run a command as `dev`, keeping the container env (GIT_CONFIG_*, CLAUDE_CONFIG_DIR, …);
# runuser only resets HOME/SHELL/USER/LOGNAME.
as_dev() { runuser -u dev -- "$@"; }

# Write stdin to a file as `dev`, atomically (tmp file + rename). The tmp name is unique per
# sandbox and process: the profile dir is shared, and sandboxes starting at the same time would
# otherwise rename each other's tmp file away.
write_as_dev() {
  local target="$1"
  local tmp="${target}.tmp.${SANDBOX_NAME}.$$"
  as_dev tee "$tmp" >/dev/null
  as_dev mv -f "$tmp" "$target"
}

: "${SANDBOX_NAME:?SANDBOX_NAME is not set}"
: "${SANDBOX_WORKTREE:?SANDBOX_WORKTREE is not set}"
: "${CLAUDE_CONFIG_DIR:?CLAUDE_CONFIG_DIR is not set}"
[ -d "$SANDBOX_WORKTREE" ] || die "worktree $SANDBOX_WORKTREE is not mounted"

RUN_DIR=/run/dev
LOG_DIR=/var/log/dev
SETTINGS_TEMPLATE=/opt/log-hub-dev/settings.template.json
PROVISION=/opt/log-hub-dev/provision.mjs
MARKETPLACE_DIR="$SANDBOX_WORKTREE/.artisyn/marketplace"
PROJECT_SETTINGS="$SANDBOX_WORKTREE/.claude/settings.json"
LOCAL_SETTINGS="$SANDBOX_WORKTREE/.claude/settings.local.json"
OFFICIAL_MARKETPLACE=anthropics/claude-plugins-official
TS_LSP_PLUGIN=typescript-lsp@claude-plugins-official
# The two keys the PoC (Phase 1) wrote into the worktree's settings.local.json to disable the
# plugins it could not run; Phase 2 deletes exactly these keys (and nothing else).
POC_DISABLED_PLUGINS=("log-hub-hooks@artisyn-e798dd87" "$TS_LSP_PLUGIN")
# node_modules volumes (FR-B2): dir relative to the worktree -> lockfile -> install command.
# The root bun.lock is ignored: the root installs with npm.
NM_DIRS=(. server hook artisyn-hooks-installer client)
# Per-sandbox DB name: `-` -> `_` (DD-3).
DB_NAME="log_hub_${SANDBOX_NAME//-/_}"

log "starting sandbox ${SANDBOX_NAME} (worktree ${SANDBOX_WORKTREE})"

# --- Step 1: markers and ownership -----------------------------------------------------------
mkdir -p "$RUN_DIR" "$LOG_DIR"
rm -f "$RUN_DIR"/*
chown dev:dev "$RUN_DIR" "$LOG_DIR"
mkdir -p "$CLAUDE_CONFIG_DIR/plugins"
# The profile is a host bind mount (chown may be a no-op there); the plugins dir, the
# node_modules volumes and the shared caches are named volumes that Docker creates root-owned.
chown dev:dev "$CLAUDE_CONFIG_DIR" 2>/dev/null || warn "cannot chown $CLAUDE_CONFIG_DIR (host bind mount)"
chown dev:dev "$CLAUDE_CONFIG_DIR/plugins"
for d in "${NM_DIRS[@]}"; do
  nm="$SANDBOX_WORKTREE/$d/node_modules"
  # Only a mounted volume is chowned here; without one, npm/bun create the dir as dev.
  if mountpoint -q "$nm" 2>/dev/null; then chown dev:dev "$nm"; fi
done
# <worktree>/tmp is a per-sandbox named volume too: test stands, reports, eslint caches and upload
# queues stay off the slow host file-sharing bridge.
if mountpoint -q "$SANDBOX_WORKTREE/tmp" 2>/dev/null; then chown dev:dev "$SANDBOX_WORKTREE/tmp"; fi
for d in /home/dev/.npm /home/dev/.bun /home/dev/.cache/ms-playwright; do
  if [ -d "$d" ]; then chown dev:dev "$d"; fi
done

# --- Step 2: socat forward 127.0.0.1:5432 -> log-hub-postgres:5432 (FR-B4) -------------------
# nodelay on both legs: without it Nagle + delayed ACK add ~40 ms per DB round trip.
setsid socat TCP-LISTEN:5432,bind=127.0.0.1,fork,reuseaddr,nodelay TCP:log-hub-postgres:5432,nodelay \
  </dev/null >>"$LOG_DIR/socat.log" 2>&1 &
log "socat forward 127.0.0.1:5432 -> log-hub-postgres:5432 started (pid $!)"

# --- Step 3: refresh node_modules volumes (FR-B2) --------------------------------------------
# Each volume keeps the sha256 of its lockfile in node_modules/.lockhash; the install runs when it
# is missing or differs. The hash is written only after a successful install.
INSTALL_LOG="$LOG_DIR/install.log"
touch "$INSTALL_LOG" && chown dev:dev "$INSTALL_LOG"
for d in "${NM_DIRS[@]}"; do
  dir="$SANDBOX_WORKTREE/$d"
  if [ "$d" = client ]; then
    lock="$dir/bun.lock"; install=(bun install --frozen-lockfile)
  else
    lock="$dir/package-lock.json"; install=(npm ci)
  fi
  if [ ! -f "$lock" ]; then
    warn "$lock not found; $d/node_modules not installed"
    continue
  fi
  want="$(sha256sum "$lock" | cut -d' ' -f1)"
  hashfile="$dir/node_modules/.lockhash"
  have="$(cat "$hashfile" 2>/dev/null || true)"
  if [ "$have" = "$want" ]; then
    log "$d/node_modules up to date"
    continue
  fi
  log "installing $d/node_modules (${install[*]}, log $INSTALL_LOG)"
  printf '\n===== %s %s: %s =====\n' "$(date -Is)" "$d" "${install[*]}" >>"$INSTALL_LOG"
  if (cd "$dir" && as_dev "${install[@]}") >>"$INSTALL_LOG" 2>&1; then
    printf '%s\n' "$want" | write_as_dev "$hashfile"
    log "$d/node_modules installed"
  else
    warn "${install[*]} failed in $d; see $INSTALL_LOG (retried on the next start)"
  fi
done

# --- Step 4: merge the settings template into the profile (user keys win) --------------------
USER_SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"
if [ -s "$USER_SETTINGS" ]; then
  if merged="$(jq -s '.[0] * .[1]' "$SETTINGS_TEMPLATE" "$USER_SETTINGS")"; then
    printf '%s\n' "$merged" | write_as_dev "$USER_SETTINGS"
  else
    warn "$USER_SETTINGS is not valid JSON; left unchanged"
  fi
else
  jq . "$SETTINGS_TEMPLATE" | write_as_dev "$USER_SETTINGS"
fi
log "profile settings merged"

# --- Step 5: plugins (per-sandbox plugin state, idempotent) ----------------------------------
cd "$SANDBOX_WORKTREE"
MARKETPLACE_JSON="$MARKETPLACE_DIR/.claude-plugin/marketplace.json"
if [ -f "$MARKETPLACE_JSON" ]; then
  MARKETPLACE_NAME="$(jq -r '.name' "$MARKETPLACE_JSON")"
  # --scope local: the declaration goes to the worktree's git-ignored settings.local.json, not to
  # the profile settings.json that every sandbox shares (each sandbox has its own worktree path).
  if as_dev claude plugin marketplace add "$MARKETPLACE_DIR" --scope local; then
    log "marketplace ${MARKETPLACE_NAME} registered from the worktree"
  elif as_dev claude plugin marketplace update "$MARKETPLACE_NAME"; then
    log "marketplace ${MARKETPLACE_NAME} already registered; refreshed"
  else
    warn "could not register marketplace ${MARKETPLACE_NAME} from $MARKETPLACE_DIR"
  fi

  if [ -f "$PROJECT_SETTINGS" ]; then
    mapfile -t PLUGIN_IDS < <(jq -r '.enabledPlugins // {} | to_entries[] | select(.value == true) | .key' "$PROJECT_SETTINGS")
    for id in "${PLUGIN_IDS[@]}"; do
      if [ "${id##*@}" != "$MARKETPLACE_NAME" ]; then
        log "skipping $id (not from the project marketplace)"
        continue
      fi
      if as_dev claude plugin install "$id" --scope project; then
        log "plugin $id installed"
      else
        warn "plugin $id could not be installed"
      fi
    done
  else
    warn "$PROJECT_SETTINGS not found; no project plugins installed"
  fi
else
  warn "$MARKETPLACE_JSON not found; project plugins skipped"
fi

# The official marketplace and typescript-lsp go into the same per-sandbox plugin state. Both need
# the network; a failure only costs the language server, so it never blocks the session.
if as_dev claude plugin marketplace add "$OFFICIAL_MARKETPLACE" \
  || as_dev claude plugin marketplace update claude-plugins-official; then
  if as_dev claude plugin install "$TS_LSP_PLUGIN" --scope project; then
    log "plugin $TS_LSP_PLUGIN installed"
  else
    warn "plugin $TS_LSP_PLUGIN could not be installed; continuing without it"
  fi
else
  warn "could not register marketplace $OFFICIAL_MARKETPLACE; $TS_LSP_PLUGIN skipped"
fi

if ! as_dev git -C "$SANDBOX_WORKTREE" diff --quiet -- .claude/settings.json; then
  warn "plugin install changed the tracked .claude/settings.json of the worktree; review before committing"
fi

# --- Step 6 (Phase 2): delete the PoC plugin-disable keys, nothing else ----------------------
if [ -s "$LOCAL_SETTINGS" ]; then
  keys_json="$(printf '%s\n' "${POC_DISABLED_PLUGINS[@]}" | jq -R . | jq -s .)"
  if merged="$(jq --argjson keys "$keys_json" \
      'if (.enabledPlugins | type) == "object" then
         .enabledPlugins |= with_entries(select(.key as $k | $keys | index($k) | not))
         | if .enabledPlugins == {} then del(.enabledPlugins) else . end
       else . end' "$LOCAL_SETTINGS")"; then
    printf '%s\n' "$merged" | write_as_dev "$LOCAL_SETTINGS"
    log "PoC plugin-disable keys removed from .claude/settings.local.json"
  else
    warn "$LOCAL_SETTINGS is not valid JSON; PoC plugin-disable keys not removed"
  fi
fi

# --- Step 7: local-scope postgres MCP server on the sandbox DB -------------------------------
# Same server and args as the tracked .mcp.json (which stays unchanged for the host), with
# npx.cmd -> npx and the DB path -> /log_hub_<name_>. Local scope is keyed by the worktree path.
MCP_JSON="$SANDBOX_WORKTREE/.mcp.json"
if [ -f "$MCP_JSON" ] && jq -e '.mcpServers.postgres' "$MCP_JSON" >/dev/null 2>&1; then
  mcp_cmd="$(jq -r '.mcpServers.postgres.command | if . == "npx.cmd" then "npx" else . end' "$MCP_JSON")"
  mapfile -t mcp_args < <(jq -r --arg db "$DB_NAME" \
    '.mcpServers.postgres.args[] | if startswith("postgres") then sub("/[^/]*$"; "/" + $db) else . end' "$MCP_JSON")
  as_dev claude mcp remove --scope local postgres >/dev/null 2>&1 || true
  if as_dev claude mcp add --scope local postgres -- "$mcp_cmd" "${mcp_args[@]}"; then
    log "postgres MCP server registered for $DB_NAME"
  else
    warn "could not register the postgres MCP server"
  fi
else
  warn "$MCP_JSON has no postgres server; MCP registration skipped"
fi

# Playwright MCP, local scope over the tracked .mcp.json server of the same name: the same args
# plus --no-sandbox. Chrome's own sandbox needs new user/PID namespaces, which an unprivileged
# container may not create ("Failed to move to new namespace … Operation not permitted", then the
# browser dies); the container is the isolation boundary. npx.cmd -> npx as above.
if [ -f "$MCP_JSON" ] && jq -e '.mcpServers.playwright' "$MCP_JSON" >/dev/null 2>&1; then
  pw_cmd="$(jq -r '.mcpServers.playwright.command | if . == "npx.cmd" then "npx" else . end' "$MCP_JSON")"
  mapfile -t pw_args < <(jq -r '.mcpServers.playwright.args[]' "$MCP_JSON")
  case " ${pw_args[*]} " in *" --no-sandbox "*) ;; *) pw_args+=("--no-sandbox") ;; esac
  as_dev claude mcp remove --scope local playwright >/dev/null 2>&1 || true
  if as_dev claude mcp add --scope local playwright -- "$pw_cmd" "${pw_args[@]}"; then
    log "playwright MCP server registered (--no-sandbox)"
  else
    warn "could not register the playwright MCP server"
  fi
fi

# --- Step 8: provisioning (static part) and the dev stack ------------------------------------
if as_dev node "$PROVISION" --static; then
  log "static provisioning done"
else
  warn "static provisioning failed; the hook may not export OTEL data"
fi
devctl start all || warn "devctl start all reported a failure; see devctl status / $LOG_DIR"

# --- Step 9: done ----------------------------------------------------------------------------
touch "$RUN_DIR/entrypoint-done"
log "ready"
exec sleep infinity
