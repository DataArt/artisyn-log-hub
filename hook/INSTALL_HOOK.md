# Install Telemetry Hook

Records Claude Code sessions and uploads them to artisyn-log-hub. Ships as a **Claude Code plugin** served from a
project-local marketplace under `.artisyn/marketplace/` — no manual file copying, no manual `.claude/settings.json`
editing.

**Requirements:** Node.js ≥ 18.19, Git, Claude Code with plugin support.

---

## 1. Install

Run from the project root:

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz install
```

Where `<server-origin>` is the base URL of your artisyn-log-hub instance (e.g. `http://localhost:3000`). The API
Keys page (Install tab) shows this command pre-filled with the correct origin — copy it from there.

### Optional CLI flags (`install` only)

| Flag | Description |
|---|---|
| `--server-url <url>` | Writes `serverUrl` into `.artisyn/config/log-hub.json` at install time. Trailing slash is stripped automatically. Repointing an install that already has a different `serverUrl` prints a destination-change warning and asks `continue? [Y/n]` (see below). |
| `--api-key <key>` | Writes `apiKey` into `.artisyn/config/log-hub.local.json` at install time (never into the tracked `log-hub.json`). Prints a warning that the key will be visible in shell history. |
| `--otel-port <n>` | Pins the loopback port this project's OTEL receiver binds (integer `1`–`65535`; anything else exits 1). Overrides the previously allocated port and is persisted to `.artisyn/config/otel-port.json`. Use it to move a project off a port another project already took — see OTEL settings below. |
| `--help` | Prints usage and exits. |

**Reinstall behavior**: if either flag is omitted on a subsequent install, the previously configured value is
preserved. If a flag is provided, it always wins over the preserved value.

**What the hook starts on Windows** (since hook `2.6.0`, relevant if your organization runs endpoint-security
tooling): the hook's background processes — the prompt-triggered uploader and the OTEL receiver — are started as
plain detached `node.exe` children of `node.exe`, from the plugin directory. No script host, no shell, no
temp-directory script, and no self-deleting file. Up to and including `2.5.1` the Windows launch wrote a temporary
VBScript to `%LOCALAPPDATA%\Temp` and ran it through `wscript.exe //B //Nologo` to suppress a console-window flash;
that pattern can trip endpoint-security heuristics, so it was removed (the flash it addressed is fixed at its real
source — subprocesses now pass `windowsHide`). If your security tooling reports
`wscript.exe … artisyn-hidden-launch-*.vbs`, it comes from a hook at `2.5.1` or earlier; upgrading stops it.

**How uploads reach the server** (since hook `2.8.0`, relevant if your organization runs an inspecting proxy or a
WAF): log bodies are gzip-compressed and sent with `Content-Encoding: gzip`. There is no configuration knob — it is
always on except against a loopback `serverUrl` (`localhost`, `*.localhost`, `127.x.x.x`, `::1`), where the CPU cost
buys nothing. Large transcripts are split into several requests, each sized so the **compressed** body stays under
~900 KB. A server or proxy that cannot take a compressed body is handled without failing the upload: a `415`, or a
`400` that is not one of the server's own validation errors, makes the hook resend the same data uncompressed and
stay uncompressed for the rest of that process (the `hook.log` result line is then marked `[gzip fallback]`); a
`413` makes it re-split at half the request size and retry. A proxy that strips `Content-Encoding` but forwards the
compressed bytes is also fine — the server detects the gzip signature and inflates anyway. Servers older than this
change only understand plain bodies, so if you point a `2.8.0` hook at one, expect one fallback per process.

**Telemetry-destination guard** (since hook `2.5.1`): `serverUrl` alone decides where session logs and the API key
header are sent — nothing in the hook hardcodes a host. So when `--server-url` would repoint an install that already
has a *different* `serverUrl`, `install` prints

```
Warning: this changes the telemetry destination: <old> -> <new>
  All session logs from this project will be uploaded to the new server.
continue? [Y/n]
```

and aborts on `n`. The prompt only appears on a TTY — a non-interactive/CI run still prints the warning but is never
blocked. An unchanged destination (trailing slashes aside) is not a change and prints nothing. Both `install` and
`upgrade` also report `Telemetry destination: <serverUrl>` on success, including when the value was inherited from an
existing config or carried over by the legacy `.env` → JSON migration rather than passed on the command line.

**Full Auto Install** — the API Keys page → Install tab also has a "Full Auto Install" card that generates a
ready-to-run one-liner with both flags pre-filled (server URL from `window.location.origin`, API key generated on
demand):

```sh
# Full one-liner — no manual config needed after this
npx "<server-origin>/static/artisyn-hooks-installer.tgz" install --server-url "<server-origin>" --api-key "<your-api-key>"
```

> **Security note:** passing `--api-key` embeds the key in your shell history and process list. For shared machines
> add it to `.artisyn/config/log-hub.local.json` by hand instead (see Configuration below).

**What `install` does:**
1. Validates that `.git/` exists in cwd — exits 1 if not.
2. Validates that `.claude/` exists in cwd — if missing, prompts `Create it now? [Y/n]` and creates it unless
   declined (declining exits 1).
3. Resolves this project's OTEL receiver port — `--otel-port` if given, else the port already recorded in
   `.artisyn/config/otel-port.json`, else a freshly allocated random port — then persists it to `otel-port.json`
   and git-ignores that file.
4. Stops any OTEL receiver already listening on that port (`POST /artisyn/shutdown`, wait, force-kill if needed) —
   see "Stopping the previous receiver before install/upgrade" below. Never blocks or fails the install; runs
   before the plugin tree is extracted so a stale-version process is never left holding the port, or the old
   code, across the update.
5. Extracts the marketplace/plugin tree bundled inside the installer tarball into `.artisyn/marketplace/` (no
   network request to the server at this step) and renames the marketplace to this repo's own name,
   `artisyn-<8 hex>` — the first 8 hex digits of the SHA-256 of the normalised `origin` URL
   (`git@host:org/repo.git` and `https://host/org/repo` both become `host/org/repo`, so every clone gets the same
   name), or of the checkout path when there is no `origin`. A name already in `marketplace.json` is reused.
   Claude Code registers marketplaces by name at the **user** level, so a single shared name made every repo of a
   user re-point one registration at itself and share one plugin cache; the per-repo name keeps them apart.
6. Writes/merges `.artisyn/config/log-hub.json` (and `.artisyn/config/log-hub.local.json` if a secret needs
   persisting), applying `--server-url`/`--api-key` if given. `otelReceiverPort` is always overwritten from the
   port resolved in step 3, so the two files can never disagree.
7. Ensures `.artisyn/config/log-hub.local.json` is git-ignored (via `.artisyn/config/.gitignore`); hard-aborts with
   a remediation message if that file is already tracked by git.
8. Merges `enabledPlugins["log-hub-hooks@artisyn-<hash>"] = true`,
   `extraKnownMarketplaces["artisyn-<hash>"].source.path = "./.artisyn/marketplace"` and the nine-key OTEL `env`
   block into `.claude/settings.json` (all other keys, including any hooks you wired yourself, are left untouched);
   writes `.claude/settings.json.bak` first. An install made before the per-repo name (legacy shared `artisyn`) is
   migrated here: `extraKnownMarketplaces.artisyn` pointing at `./.artisyn/marketplace` is dropped and the
   `<plugin>@artisyn` keys of `log-hub-hooks` and of every other plugin listed in this marketplace move to
   `<plugin>@artisyn-<hash>`, keeping their value. The old user-level `artisyn` registration is left alone —
   repos not yet upgraded still use it.
9. Runs `claude plugin marketplace add ./.artisyn/marketplace` then
   `claude plugin install log-hub-hooks@artisyn-<hash> --scope project` so the plugin is actually registered and cached —
   declaring the settings keys alone does **not** activate it. Either command failing (e.g. `claude` not on `PATH`)
   is non-fatal: a warning prints both exact commands to run manually, in order.
10. Smoke-tests the OTEL receiver: spawns the real `otel-receiver.js` from the just-installed plugin tree into a
    throwaway temp directory and POSTs a synthetic `/artisyn/register`, expecting `200`. Non-fatal like step 9 — on
    failure it prints the exact foreground command to reproduce the problem, and never re-allocates the port.
11. If a pre-plugin install (`.claude/telemetry_tool/`) is detected, migrates it automatically — see Migration below.
12. Prints a success message describing what was registered and what to do next.

If you skip both flags, add your credentials afterwards to `.artisyn/config/log-hub.local.json` /
`log-hub.json` as described in Configuration.

---

## 2. Upgrade

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz upgrade
```

The API Keys page (Install tab) has an "Upgrade Hooks" copy-and-paste box with this command pre-filled. `upgrade`
takes no `--server-url`/`--api-key`/`--otel-port` flags — those are install-only; the already-configured values are
read from `.artisyn/config/log-hub*.json` and `.artisyn/config/otel-port.json`.

`upgrade` re-extracts the plugin tree, re-runs the same `claude plugin marketplace add` /
`claude plugin install --scope project` sequence (both are no-ops if already up to date), and prints
`Previous version:` / `New version:` lines. If it detects a pre-plugin install, it runs the same migration `install`
would — `upgrade` no longer hard-exits when `.claude/telemetry_tool/version.json` is missing. Running `upgrade`
(or `install`) a second time with nothing to do changes nothing.

`upgrade` shares `install`'s stop-before-extract step: whatever receiver is currently listening on the project's
resolved OTEL port is asked to shut down before the new plugin files are extracted over it — see "Stopping the
previous receiver before install/upgrade" below.

`upgrade` also resolves the OTEL port and writes the `env` block exactly as `install` does — this is the only route
by which an already-installed project starts receiving OTEL. An existing `.artisyn/config/otel-port.json` is
reused, so upgrading never moves a project's port.

---

## 3. Uninstall

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz uninstall
```

Removes `.artisyn/marketplace/` and `.artisyn/config/` (both JSON config files plus `otel-port.json`), and
surgically removes `enabledPlugins["log-hub-hooks@artisyn-<hash>"]` / `extraKnownMarketplaces["artisyn-<hash>"]`
(and the same keys under the legacy shared `artisyn` name) from `.claude/settings.json`, leaving every other
setting untouched.

The nine OTEL `env` keys are removed too — but only while `env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` still points at a
loopback receiver (`http(s)://127.0.0.1|localhost:<port>/v1/logs`), i.e. it is still ours. If you have repointed it
at your own collector, the whole `env` block is left untouched and a `Note:` line says so. An `env` block left
empty by the removal is dropped entirely.

If a leftover file can't be deleted (locked by an open editor or a running hook),
the settings-key removal still succeeds and is reported; a warning names the leftover path and the next
install/upgrade/uninstall run retries the delete.

---

## Migrating from the pre-plugin install

If your project still has `.claude/telemetry_tool/` (the old copy-paste install) or installer-authored entries in
`.claude/settings.json`'s `hooks` block, running `install` or `upgrade` migrates automatically, in order:

1. Converts `.claude/telemetry_tool/.env` / `.env.local` into `.artisyn/config/log-hub.json` /
   `log-hub.local.json` (only filling keys absent from an already-existing `log-hub.json`; `--server-url`/
   `--api-key` still win over both files), then re-reads the written files to confirm they parse.
2. Removes only the installer-authored `hooks` entries from `.claude/settings.json` (matched by command path —
   any hook entry you added yourself is left byte-identical) and writes the `enabledPlugins`/
   `extraKnownMarketplaces` keys, as one read-modify-write with a single `.claude/settings.json.bak`.
3. Runs `claude plugin marketplace add` / `claude plugin install` (same as a fresh install, non-fatal on failure).
4. Deletes `.claude/telemetry_tool/`. If deletion fails (e.g. Windows file lock), migration is still reported
   successful with a warning naming the leftover directory — retried on the next run.

If telemetry hook entries are also found in `.claude/settings.local.json` or the user-level
`~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json` when `CLAUDE_CONFIG_DIR` is set), a warning is printed naming the file — those are never modified, only reported, since
leaving them would record every event twice.

---

## Plugin package structure

The installer extracts this tree, generated at build time from `hook/.claude/telemetry_tool/`:

```
.artisyn/marketplace/
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    └── log-hub-hooks/
        ├── .claude-plugin/
        │   └── plugin.json
        ├── hooks/
        │   └── hooks.json
        ├── scripts/
        │   ├── telemetry-hook.js
        │   ├── lifecycle-hook.js
        │   ├── send-logs-hook.js
        │   ├── upload-logs.js
        │   ├── prompt-upload-hook.js
        │   ├── session-files.js
        │   ├── otel-receiver.js
        │   ├── otel-register.js
        │   ├── otel-endpoint-check.js
        │   ├── otel-restart.js
        │   ├── spawn-hidden.js
        │   ├── env-context.js
        │   ├── git-context.js
        │   ├── write-telemetry.js
        │   ├── hook-log.js
        │   ├── recommendations.js
        │   ├── throttle-state.js
        │   ├── claude-invoke-async.js
        │   ├── skill-catalog.js
        │   ├── harness-snapshot.js
        │   ├── post-turn-analysis-hook.js
        │   ├── post-turn-analysis-worker.js
        │   ├── session-attribution-state.js
        │   ├── process-marker.js
        │   ├── harness-state.js
        │   ├── ndjson-sanitize.js
        │   ├── code-inventory.js
        │   ├── edit-result-counts.js
        │   ├── claude-config-dir.js
        │   └── version.json
        └── config-template/
            └── log-hub.json
```

Schema reference: <https://code.claude.com/docs/en/plugins-reference> (marketplace/plugin manifest shape and the
hooks event table). Hook commands use the **exec form**
(`{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/<script>.js"]}`) rather than a shell
string, so each argument is passed literally — no quoting needed for paths containing spaces.

### `marketplace.json`

As shipped in the tarball; the installer replaces `"name"` with this repo's `artisyn-<hash>` (step 5).

```json
{
  "name": "artisyn",
  "owner": { "name": "Artisyn" },
  "description": "Local marketplace for the artisyn-log-hub telemetry hook plugin.",
  "plugins": [
    {
      "name": "log-hub-hooks",
      "source": "./plugins/log-hub-hooks",
      "description": "Records Claude Code session telemetry and uploads it to artisyn-log-hub."
    }
  ]
}
```

### `plugin.json`

```json
{
  "name": "log-hub-hooks",
  "displayName": "Log Hub Hooks",
  "version": "2.17.0",
  "description": "Records Claude Code session telemetry and uploads it to artisyn-log-hub.",
  "author": { "name": "Artisyn" }
}
```

### `hooks/hooks.json`

All 14 events wired — the hook is monitoring/logging only and never blocks a tool call (the `PreToolUse`
guardrail was removed in `2.19.0`): `telemetry-hook.js` on `UserPromptSubmit`, `lifecycle-hook.js` on the 12
remaining lifecycle events, and `send-logs-hook.js` + `post-turn-analysis-hook.js` on `Stop`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/telemetry-hook.js"], "statusMessage": "Recording prompt..." }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording tool call..." }] }
    ],
    "PostToolUseFailure": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording tool failure..." }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording session start..." }] }
    ],
    "SessionEnd": [
      { "hooks": [
        { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording session end..." },
        { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/send-logs-hook.js"], "statusMessage": "Flushing session logs..." }
      ] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording permission request..." }] }
    ],
    "PermissionDenied": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording permission denial..." }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording subagent start..." }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording subagent stop..." }] }
    ],
    "PreCompact": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording compaction..." }] }
    ],
    "PostCompact": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording compaction..." }] }
    ],
    "PostToolBatch": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording tool batch..." }] }
    ],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle-hook.js"], "statusMessage": "Recording stop failure..." }] }
    ],
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/send-logs-hook.js"], "statusMessage": "Uploading logs..." },
        { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/post-turn-analysis-hook.js"], "statusMessage": "Analyzing turn..." }
      ] }
    ]
  }
}
```

`prompt-upload-hook.js`, `otel-receiver.js`, `otel-register.js`, `otel-endpoint-check.js`, `otel-restart.js`, `session-files.js`,
`throttle-state.js`, `claude-invoke-async.js`, `skill-catalog.js`, `harness-snapshot.js`, `post-turn-analysis-worker.js`,
`session-attribution-state.js`, `process-marker.js`, `harness-state.js`, `ndjson-sanitize.js`, `code-inventory.js`,
`edit-result-counts.js` and `claude-config-dir.js` are **not** wired to any event — they are detached child processes / shared modules
launched by the hooks above, so they never appear in `hooks.json`.

`send-logs-hook.js` is wired to two events and behaves differently on each:

| Event | Behaviour |
|---|---|
| `Stop` | The full run — scans every namespace across all sessions, honours `.claude-logs.sent`, injects context events, reports `hook-status`, prunes otel. Waits up to 2s for the shared upload lock, since it blocks the interactive turn. |
| `SessionEnd` | A short, scoped flush of just the ending session's own `artisyn` + `claude` files. Waits up to 20s for the lock — it is the session's last trigger, so giving up strands those files until some other session happens to run a full scan. Writes no `.claude-logs.sent` entry. |

`post-turn-analysis-hook.js` (hook `2.9.0`+) is the second script on `Stop`, alongside `send-logs-hook.js` —
both run on every `Stop` event, independently of each other. It does no network I/O itself: it resolves
`transcript_path`/`session_id`/`cwd` from the `Stop` payload plus this project's git remote, then spawns
`post-turn-analysis-worker.js` as a detached background process and exits immediately, so the interactive turn is
never blocked by the worker's `claude -p` calls or its HTTP round-trips. The worker fetches both the Turn-End Cost
Advisor's and the AI Session Attribution's gate info from one combined endpoint and runs both evaluations
concurrently — see `docs/knowledgebase/server-endpoint-map.md` and the config keys below.

Since `2.10.1` this trigger exits immediately when `ARTISYN_HOOK_SERVICE` is set in its environment. Every
`claude -p` the hooks spawn (the advisor/attribution evaluations) exports that variable
into the child process, and Claude Code runs hooks as child processes of the CLI, so the spawned session's own
`Stop` carries it — without the guard that `Stop` would evaluate the service session, spawning two more
`claude -p` calls that each do the same again. Do not export `ARTISYN_HOOK_SERVICE` in a normal shell: any
interactive session started with it set silently gets no advisor and no attribution evaluation.

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's cache directory (`~/.claude/plugins/cache/...`), which changes on
every update — this is why hook scripts resolve config/output paths from the git repo root
(`.artisyn/config/`, `.artisyn/ai_work_dir/`) rather than from `${CLAUDE_PLUGIN_ROOT}` itself.

---

## Configuration

Config lives in two project-local JSON files, resolved from the **git repo root** — same anchor as
`.artisyn/ai_work_dir/`:

- `.artisyn/config/log-hub.json` — tracked, non-secret settings.
- `.artisyn/config/log-hub.local.json` — gitignored secrets (`apiKey`). Only created when there's an actual secret
  to persist (an `--api-key` flag, or a migrated value); a fresh install with no flag doesn't create this file at
  all.

`log-hub.local.json` overrides `log-hub.json` per top-level key (whole-value replacement, including arrays — no
merge/concatenation). An explicit `null` in the local file means "absent", falling through to the base file's
value. A file that's missing, unparseable JSON, or has a non-object root falls back to defaults for every key it
would have contributed (one `[warn]` line to `.artisyn/ai_work_dir/hook.log` in the malformed case; silent when merely
absent).

To add your credentials manually:

`.artisyn/config/log-hub.json`:
```json
{ "serverUrl": "<server-origin>" }
```

`.artisyn/config/log-hub.local.json` (gitignored — never commit):
```json
{ "apiKey": "<your-api-key>" }
```

### Config keys and defaults

| Key | Default | Type | Description |
|---|---|---|---|
| `serverUrl` | `""` | string | Base URL of artisyn-log-hub, and the **only** thing deciding where logs are uploaded — no host is hardcoded anywhere in the hook. Empty → upload skipped. Every upload run records the origin it used as `target=<origin>` in `hook.log`. |
| `apiKey` | _(absent)_ | string | `log-hub.local.json` only. Empty/absent → upload skipped. |
| `telemetryDir` | `""` | string | Where JSONL event files are written; absolute or relative to repo root. Empty → `<repo-root>/.artisyn/ai_work_dir/telemetry`. |
| `jsonCompact` | `false` | boolean | `true` writes each record as plain `JSON.stringify` output; `false` adds a space after every `:`/`,`. Either way one record per line. |
| `context` | `[]` | array of `{key, value}` | Arbitrary metadata attached to every event, e.g. `[{"key":"project","value":"my-project"}]` → `"context": {"project": "my-project"}`. Keys are lowercased; last entry wins on duplicates; absent/empty → no `context` field emitted. |
| `sendLogsTimeoutMs` | `10000` | number | HTTP timeout for log upload requests. |
| `sendLogsOnPromptEnabled` | `true` | boolean | Gates whether each `UserPromptSubmit` also spawns a detached, prompt-triggered background upload of the current session's files (in addition to the normal `Stop`-triggered upload). |
| `sendLogsOnPromptTimeoutMs` | `60000` | number | Watchdog timeout for the prompt-triggered background upload; also drives the shared upload lock's staleness window (`2x` this value) shared with the `Stop`-triggered upload. |
| `otelEnabled` | `true` | boolean | Runtime switch for OTEL capture: gates the receiver spawn, the register handshake, and the `claude-otel` upload + prune pass. See the caveat under OTEL settings below. |
| `otelReceiverPort` | `0` | number | Loopback port this project's OTEL receiver binds. `0` means "not yet allocated"; the installer always overwrites it with the resolved port, so edit `.artisyn/config/otel-port.json` (or re-install with `--otel-port`) instead of this key. |
| `otelReceiverIdleTimeoutMs` | `600000` | number | No request of any kind for this long and the receiver exits (10 min). `0` means "use the default". |
| `otelReceiverMaxBodyKb` | `8192` | number | Request bodies larger than this are rejected (`413`) without writing anything. **KiB**, converted to bytes by the spawning hook. Measured on wire bytes, before decompression. `0` means "use the default". |
| `otelRetentionDays` | `7` | number | `<telemetryDir>/otel/<session-id>/*.jsonl` chunks older than this (by mtime) are deleted at the end of a later `Stop` run, along with abandoned `.tmp` files and emptied session directories. A chunk whose upload failed in that same run is kept (since hook `2.21.0`), so a server outage at the cutoff never discards it. `0` means "use the default". |
| `mcpProbeTimeoutMs` | `3000` | number | Per-server timeout for the `Stop`-hook's live MCP `tools/list` probe (each configured stdio-transport MCP server is probed sequentially, so total added latency is bounded by this value × the number of configured servers). |
| `turnEndCostAdvisorModel` | `"sonnet"` | string | Claude model used for the Turn-End Cost Advisor branch's `claude -p` call (hook `2.9.0`+). |
| `turnEndCostAdvisorLlmTimeoutMs` | `600000` | number | Timeout for the advisor branch's LLM call (10 min — it runs detached, off the interactive path, and may itself read several files/skills worth of context); on timeout the run is recorded as `failed` (fail-open). |
| `turnEndCostAdvisorMaxPromptSizeKb` | `60` | number | Cap on the advisor prompt's free-text "user prompts" sample; fixed fields (aggregate numbers, tool/file usage) are never truncated. |
| `sessionAttributionMaxPromptSizeKb` | `60` | number | Cap on the AI Session Attribution prompt's free-text "user prompts" sample; attribute definitions and the changed-file list are never truncated. |
| `sessionAttributionLlmModel` | `"haiku"` | string | Claude model used for the AI Session Attribution branch's `claude -p` call. |
| `sessionAttributionLlmTimeoutMs` | `600000` | number | Timeout for the attribution branch's LLM call (10 min — same rationale as the advisor branch's timeout above); on timeout the run is recorded as `failed` and counts toward the 3-consecutive-failure cap. |

**Removed guardrail keys:** `guardrailEnabled`, `guardrailBlockOutsideProject`, `guardrailProhibitedFiles`,
`guardrailLlm*`, `guardrailBlockNetwork` and `guardrailMaxScriptSizeKb` belonged to the `PreToolUse` guardrail
removed in `2.19.0`. A config that still has them is valid — they are ignored, and `install`/`upgrade` leaves
them in place (an older hook reading a config without them would fall back to guardrail-on defaults). An upgrade
deletes the obsolete `scripts/guardrail-hook.js` and `docs/GUARDRAIL_SETTINGS.md` from the installed plugin.

A key that's `null` is treated as absent (default applies). A key present with the wrong type (e.g. a string where
a number is expected, or a negative number) falls back to its default and logs one `[warn]` line naming the file
and key — the hook never throws or blocks a tool call over a config problem.

For event schemas and upload mechanics: [HOW_HOOK_WORKS.md](HOW_HOOK_WORKS.md)

---

## OTEL settings

Claude Code can export its own OpenTelemetry logs and metrics over OTLP/HTTP. The installer points that exporter at
a loopback endpoint and the plugin's `otel-receiver.js` listens there, filing records into
`<telemetryDir>/otel/<session-id>/<epoch-ms>-<seq>.jsonl` — **one chunk file per inbound OTLP request**, which the
normal `Stop` upload then ships as a fourth log namespace (`claude-otel`, alongside `artisyn`, `claude` and
`claude-subagent`).

Chunks, rather than one appended file per session, since hook `2.4.0`:

- Each chunk is written to a `.tmp` sibling and `renameSync`d into place. Rename within a directory is atomic, so a
  reader can never observe a half-written chunk — the uploader ships every `.jsonl` byte-for-byte with no
  trailing-partial-line trimming. A process killed mid-write leaves an inert `.tmp`, which the prune sweeps.
- The session id is a **directory** rather than a filename prefix, because session ids are UUIDs containing hyphens
  and could not otherwise be parsed back out of a combined name.
- The `<epoch-ms>-<seq>` basename makes lexicographic order equal write order, so the uploader ships chunks in the
  order they arrived — across sessions, not just within one.

### Port allocation

A fixed port would be wrong twice over: `4318` collides with a collector you may already run, and any fixed choice
is a guess. So each project gets its **own randomly allocated port** in `[25000, 65535]`, and its own receiver.

Resolution order at install time, first match wins:

1. `--otel-port <n>`.
2. The `port` in `.artisyn/config/otel-port.json` — this is what keeps the port stable across reinstalls/upgrades.
3. A fresh allocation, then persisted.

Every candidate must pass both a bind probe **and** a full loopback HTTP round-trip before anything is written, so
a port blocked by a local proxy or an IPv4/IPv6 mismatch is never persisted.

`.artisyn/config/otel-port.json` (`{"port": 31447, "allocatedAt": "<ISO>"}`) is the authoritative record and is
**git-ignored** on purpose: a committed port would be inherited by every teammate's checkout and every second
checkout on one machine, manufacturing exactly the collisions randomisation avoids. `log-hub.json`'s
`otelReceiverPort` is an output of this file, never an input.

If two projects do collide, the receiver detects it: the second project's register call gets a
`409 owner-mismatch` and the hook writes one warning to `.artisyn/ai_work_dir/hook.log` naming the owning repo.
Fix it by re-installing that project with `--otel-port <n>`. Detection only — nothing is moved automatically,
because the exporter's endpoint can only be changed at install time.

### The `.claude/settings.json` `env` block

Written by `install` and `upgrade`, with `<port>` substituted:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_COMPRESSION": "none",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:<port>/v1/logs",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://127.0.0.1:<port>/v1/metrics",
    "OTEL_LOG_TOOL_DETAILS": "1"
  }
}
```

Merging is **per-key fill-if-absent**: your existing `env` is preserved and only keys not already present are
written, with one `Note:` line listing what was left alone — so any `OTEL_*` value you set yourself always wins.
`OTEL_EXPORTER_OTLP_COMPRESSION` is set explicitly so the encoding never depends on an exporter default; the
receiver still accepts `gzip`/`deflate` if you override it.

That rule also covers the installer's own earlier values: if the port changes later (a lost/regenerated
`otel-port.json`, `--otel-port`, or a committed `settings.json` carrying another checkout's port), the old endpoints
stay put. **Endpoint self-check (since hook `2.18.0`):** on every `SessionStart` (when `otelEnabled`), the hook
reads the effective `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` from
`.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when set) → process env. It reads the files
because Claude Code does not forward the `OTEL_*` keys to hook processes. If an endpoint is missing, or is a loopback
endpoint on a different port than the receiver, the hook writes one `warn` line to `hook.log` **and** shows a
`systemMessage` warning in Claude Code with the exact values to set. A non-loopback endpoint (your own collector) is
never reported. It only detects the problem and never rewrites `settings.json`. Fix the endpoints (or remove both
and run `upgrade`), then restart Claude Code.

### Disabling OTEL

`otelEnabled: false` is **runtime-only** — it stops the hook spawning the receiver, registering, uploading and
pruning, but does not retract the `env` block, so Claude Code keeps exporting to a port nothing listens on. That is
harmless (the port is a random high one, not `4317`/`4318`). To disable it fully, set `otelEnabled: false` **and**
delete the eight `env` keys, or just run `uninstall`.

### Receiver diagnostics

The receiver writes `<telemetryDir>/otel/receiver.log` (plain text, truncated above 1 MiB, never uploaded). A
`start` line followed by `ingest` lines means the exporter is reaching it. An `addr-in-use` line is normal from the
second session of a project onward — one receiver serves all of them. The receiver exits on its own after
`otelReceiverIdleTimeoutMs` with no traffic.

The receiver runs from the OS temp directory (`os.tmpdir()`), not from the project, so it never holds a lock on
the project folder (since hook `2.21.0`). If the project's `otel` directory has been deleted while it runs, it
logs `dir-gone` and drops the incoming records instead of re-creating the directory tree.

**Telemetry tail upload (since hook `2.21.0`).** Claude Code keeps exporting after the session's last `Stop`, so
the final chunks used to wait on disk until the project's next session. The receiver now checks once a minute:
when no request has arrived for 60 s and some `<session-id>/*.jsonl` chunk is pending, it spawns
`send-logs-hook.js --otel-sweep --cwd <git-root>` detached; it does the same once more right before its idle exit.
That run reads the project config, exits quietly when `serverUrl`/`apiKey` is missing, takes the shared upload lock
(waiting at most 2 s — a busy lock means a real upload is already running, and the next minute retries), and
uploads and deletes only the pending OTEL chunks. It writes no `.claude-logs.sent` entry, prunes nothing and does
not re-arm the receiver; its result is one `otel-sweep done: …` line in `hook.log`. The receiver logs
`sweep-spawn`, `sweep-skip` or `sweep-error` to `receiver.log`.

**Keeping it alive (since hook `2.5.0`).** It is announced unconditionally on `SessionStart`, and re-armed —
throttled to once a minute across all call sites, sharing one state file — on `UserPromptSubmit`, on **every one of
the twelve lifecycle events** (`PostToolUse`, `PostToolBatch`, `SubagentStop`, …) and on `Stop`. Before `2.5.0` the
only re-arm was `UserPromptSubmit`, which a long autonomous turn never emits: a receiver that died early stayed dead
for the rest of the turn, and everything the exporter POSTed meanwhile was lost (OTLP pushes over HTTP and does not
spool to disk). Because the re-arm begins with a `POST /artisyn/register`, and the receiver resets its idle timer on
any request, this doubles as a keepalive — the idle timeout can no longer fire mid-session while work is happening.
A `skipped: otel receiver re-arm throttled` line in `hook.log` is the normal steady state during a busy turn.

**Auto-restart on version mismatch (since hook `2.17.0`).** Every `POST /artisyn/register` response carries the
running receiver's own `receiverVersion`. If a register or re-arm call finds that version older than the hook code
making the call — i.e. a project was upgraded while an old receiver from before the upgrade was still running — the
hook now replaces it automatically instead of only logging a warning: it calls the receiver's new
`POST /artisyn/shutdown {gitRoot, sessionId}` (owner-checked the same way `/artisyn/register` is — a `409
owner-mismatch` leaves a foreign receiver untouched), waits up to 3s for the port to go quiet, force-kills the PID
still bound to the port if it hasn't (resolved via `netstat -ano`/`lsof`, never a fixed PID passed over the wire),
confirms the port is free, then spawns a fresh receiver on the same port. This whole sequence is throttled to once a
minute per project, sharing its own state file separate from the re-arm throttle above — a second concurrent
`SessionStart` that observes the same stale receiver within that window skips its own restart attempt
(`skipped: otel receiver restart throttled` in `hook.log`) and falls through to its normal idempotent
spawn-if-absent step instead. Every outcome is fail-open: a shutdown call that gets no response, a `409`, or a port
that's still occupied after the whole sequence simply leaves the existing (possibly stale) receiver running, exactly
as before `2.17.0` — nothing about this ever blocks a hook or a tool call. An old receiver predating `2.17.0` has no
`/artisyn/shutdown` route and answers `404`, which is treated identically to "nothing to wait for".

### Stopping the previous receiver before install/upgrade

Since installer `1.0.55` / hook `2.17.0`, both `install` and `upgrade` call the same shutdown-wait-force-kill
sequence (`stopExistingReceiverIfRunning`, the installer-side TypeScript mirror of the hook's own restart helper)
against the project's resolved OTEL port, immediately before the new plugin tree is extracted — so a receiver still
running from the previous version is never left holding the port, or the old code, across the file swap. It is
required-but-non-fatal, mirroring the smoke-test step: a confirmed stop prints `Stopped existing OTEL receiver on
port <port>.`; the common case (nothing was listening — the shutdown POST gets no response) is silent; a receiver
that answered but never actually freed the port prints a `Warning: could not confirm the existing OTEL receiver on
port <port> stopped …` line and installation proceeds regardless (an occupied port simply makes the freshly
extracted receiver exit `0` on `EADDRINUSE` the next time it's spawned, same as it always has). This step never
prompts and never calls `process.exit`.

---

## Done

Logs are uploaded after each session ends. All output paths are anchored to the **git repo root** — it does not
matter which subdirectory Claude was launched from.

- Activity log: `<repo-root>/.artisyn/ai_work_dir/hook.log` — every upload run ends with a `done: … target=<origin>`
  line, and each upload failure names the same `target=<origin>`, so the destination in use is always visible.
  The origin only: the query string (which carries `sessionId`) and the `X-API-Key` header are never logged.
  Each uploaded file gets a `result` line carrying both sizes — `… uploaded 5760 KB → 576 KB gz (10.0x) in 7
  requests` when it was compressed, `… uploaded 880 KB uncompressed in 1 request` otherwise, with
  ` [gzip fallback]` appended if the peer rejected the compressed body. Every `Stop`/`SessionEnd` run of
  `send-logs-hook.js` also writes exactly one line even when it exits early (`exit: …`, naming the reason and the
  `logDir=` it wrote into), so "no lines at all" always means the hook never ran.
- Raw JSONL files: `<repo-root>/.artisyn/ai_work_dir/telemetry/` (a `<session-id>.jsonl.lock` next to one exists only
  while a hook appends to it — it serializes concurrent hook processes, since appends are not atomic on WSL
  `/mnt/<drive>` or network shares; since hook `2.17.4`)
- OTEL chunk files (`<session-id>/<epoch-ms>-<seq>.jsonl`) + receiver log: `<repo-root>/.artisyn/ai_work_dir/telemetry/otel/`
- Turn-End Cost Advisor / AI Session Attribution activity logs: `<repo-root>/.artisyn/ai_work_dir/analysis.log` and
  `<repo-root>/.artisyn/ai_work_dir/attribution.log` — same format and rotation as `hook.log`, but each branch's own,
  separate from it and from each other (see HOW_HOOK_WORKS.md's "Hook diagnostic log" section).

For configuration options, event schemas, and how it works: [HOW_HOOK_WORKS.md](HOW_HOOK_WORKS.md)
