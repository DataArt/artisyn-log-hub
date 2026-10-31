# Install Telemetry Hook

Records Claude Code sessions and uploads them to artisyn-log-hub. Ships as a **Claude Code plugin** served from a
project-local marketplace under `.artisyn/marketplace/` — no manual file copying, no manual `.claude/settings.json`
editing.

**Requirements:**

- **Node.js — any current LTS release** ([list of LTS lines](https://nodejs.org/en/about/previous-releases)),
  installed and on `PATH`. Claude Code runs the hook with your own `node`, so Node.js is a hard requirement
  even if you installed Claude Code with the native installer (which does not need Node itself). Any
  current LTS works; you do not need a specific version.
- Git; the project must be a git repository.
- Claude Code with plugin support.

---

## 1. Install

Run from the project root:

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz install
```

Where `<server-origin>` is the base URL of your artisyn-log-hub instance (e.g. `http://localhost:3000`). The API
Keys page (Install tab) shows this command pre-filled with the correct origin — copy it from there.

After installing, the installer starts every hook once with your `node`, in this project, the way Claude Code
will (`--self-check`), and checks the OTEL receiver. If something cannot start — for example no `node` on
`PATH` — it prints `⚠ Hooks installed …, but they are not working in this project yet` with the reason and a
command to reproduce it, instead of `ready to use`.

### Optional CLI flags (`install` only)

| Flag | Description |
|---|---|
| `--server-url <url>` | Writes `serverUrl` into the gitignored `.artisyn/config/log-hub.local.json` at install time (installer `1.0.75`+; a `serverUrl` in the tracked `log-hub.json` is left as is). Trailing slash is stripped automatically. Repointing an install that already has a different `serverUrl` prints a destination-change warning and asks `continue? [Y/n]` (see below). |
| `--api-key <key>` | Writes `apiKey` into `.artisyn/config/log-hub.local.json` at install time (never into the tracked `log-hub.json`). Prints a warning that the key will be visible in shell history. |
| `--otel-port <n>` | Pins the loopback port of the per-user OTEL receiver (integer `1`–`65535`; anything else exits 1). Since hook `2.30.0` one receiver serves every repo of this OS user, so this rewrites `~/.artisyn/otel/port.json`, the OTEL endpoints in `~/.claude/settings.json`, and the `.claude/settings.local.json` mirror and `otelReceiverPort` of **every** installed repo listed in `~/.artisyn/otel/repos.json`; restart Claude Code afterwards. Use it when another program already holds the port — see [Port allocation](#port-allocation). |
| `--otel-existing=proxy\|keep\|replace` | What to do when Claude Code already exports OTEL to another collector (in `~/.claude/settings.json` or the process environment) — hook `2.30.0`+, accepted by `install` **and** `upgrade`. Omitted → the choice stored with an unchanged collector config, else a TTY prompt, else `keep`. See [An existing OTEL collector](#an-existing-otel-collector). Any other value exits 1. |
| `--otel-traces=yes|no` | Whether Claude Code also exports its traces (enhanced telemetry beta) to the OTEL receiver (installer with hook `2.29.0`+). Omitted → a TTY prompt `Also export Claude Code traces (enhanced telemetry beta) to Log Hub? [Y/n]`; a non-interactive run answers yes. The answer is stored as `otelTraces` in `.artisyn/config/log-hub.json` and `upgrade` reuses it — see [Traces](#traces-opt-in). Any other value exits 1. |
| `--help` | Prints usage and exits. |

One more action takes no subcommand: `npx <server-origin>/static/artisyn-hooks-installer.tgz --restart-otel-receiver`
sends an authenticated `POST /artisyn/shutdown` to the per-user OTEL receiver and waits until its port is free (force-kill
if needed). The next Claude Code session starts it again from the installed code. It is rejected together with a
subcommand or any other option.

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
3. Decides what to do with the user-scope OTEL settings, before any file is written: managed by your organization
   (see [Admin-managed OTEL](#admin-managed-otel)), no other collector, or — when another collector is configured —
   `proxy`/`keep`/`replace` (see [An existing OTEL collector](#an-existing-otel-collector)). An unparsable or
   wrong-typed `~/.claude/settings.json` aborts the run here with every file untouched.
4. Resolves the **per-user** OTEL receiver port — `--otel-port` if given, else the port in
   `~/.artisyn/otel/port.json`, else a freshly allocated random port — and writes `port.json`. Creates
   `~/.artisyn/otel/token` (the receiver's shared secret) when missing. No receiver is stopped (since hook
   `2.30.0`): an old per-project receiver keeps its own port until its idle exit.
5. Extracts the marketplace/plugin tree bundled inside the installer tarball into `.artisyn/marketplace/` (no
   network request to the server at this step) and renames the marketplace to this repo's own name,
   `artisyn-<8 hex>` — the first 8 hex digits of the SHA-256 of the normalised `origin` URL
   (`git@host:org/repo.git` and `https://host/org/repo` both become `host/org/repo`, so every clone gets the same
   name), or of the checkout path when there is no `origin`. A name already in `marketplace.json` is reused.
   Claude Code registers marketplaces by name at the **user** level, so a single shared name made every repo of a
   user re-point one registration at itself and share one plugin cache; the per-repo name keeps them apart.
6. Writes/merges `.artisyn/config/log-hub.json` (shared settings, including the `otelTraces` answer; a legacy
   `otelReceiverPort` left there by an older installer is removed) and the per-developer `.artisyn/config/log-hub.local.json`, applying
   `--server-url`/`--api-key` to the local file if given. The local file's `otelReceiverPort` is always overwritten
   with the shared port from step 4 (hooks older than `2.30.0` still read it). A legacy
   `.artisyn/config/otel-port.json` is deleted. This repo's entry is upserted into `~/.artisyn/otel/repos.json`, and
   `otel-receiver.js`, `version.json` and `otel-ensure-receiver.js` are copied into `~/.artisyn/otel/bin/`
   (overwriting only those three files).
7. Ensures `.artisyn/config/log-hub.local.json` is git-ignored (via `.artisyn/config/.gitignore`); hard-aborts with
   a remediation message if that file is already tracked by git.
8. Merges `enabledPlugins["log-hub-hooks@artisyn-<hash>"] = true`,
   `extraKnownMarketplaces["artisyn-<hash>"].source.path = "./.artisyn/marketplace"` into `.claude/settings.json`
   (all other keys, including any hooks you wired yourself, are left untouched); writes `.claude/settings.json.bak`
   first. The nine-key OTEL `env` block (twelve keys with traces on) goes into the user-scope `~/.claude/settings.json`
   (`$CLAUDE_CONFIG_DIR/settings.json` when set; backup `settings.json.artisyn-bak`) and is mirrored into the
   gitignored, per-checkout `.claude/settings.local.json` together with `OTEL_RESOURCE_ATTRIBUTES` (both written
   before `.claude/settings.json`, each with its own backup; see [the `env` block](#the-otel-env-block)). An install made before the per-repo name (legacy shared `artisyn`) is
   migrated here: `extraKnownMarketplaces.artisyn` pointing at `./.artisyn/marketplace` is dropped and the
   `<plugin>@artisyn` keys of `log-hub-hooks` and of every other plugin listed in this marketplace move to
   `<plugin>@artisyn-<hash>`, keeping their value. The old user-level `artisyn` registration is left alone —
   repos not yet upgraded still use it.
9. Runs `claude plugin marketplace add ./.artisyn/marketplace` then
   `claude plugin install log-hub-hooks@artisyn-<hash> --scope project` so the plugin is actually registered and cached —
   declaring the settings keys alone does **not** activate it. Either command failing (e.g. `claude` not on `PATH`)
   is non-fatal: a warning prints both exact commands to run manually, in order.
10. Smoke-tests the per-user OTEL receiver: runs the authenticated handshake (`POST /artisyn/hello`, proof check,
    then an authenticated `POST /artisyn/session-status`) against whatever answers on the shared port, spawning
    `~/.artisyn/otel/bin/otel-receiver.js` first when nothing answers. Non-fatal like step 9 — on failure it prints
    the exact foreground command to reproduce the problem and names `~/.artisyn/otel/receiver.log`; it never
    re-allocates the port. An older shared receiver that lacks `session-status` passes, and is replaced by the new
    code after its idle exit.
11. If a pre-plugin install (`.claude/telemetry_tool/`) is detected, migrates it automatically — see Migration below.
12. Prints a success message describing what was registered and what to do next.

If you skip both flags, add your credentials afterwards to `.artisyn/config/log-hub.local.json` as described in
Configuration.

---

## 2. Upgrade

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz upgrade
```

The API Keys page (Install tab) has an "Upgrade Hooks" copy-and-paste box with this command pre-filled. `upgrade`
takes no `--server-url`/`--api-key`/`--otel-port`/`--otel-traces` flags — those are install-only; the
already-configured values are read from `.artisyn/config/log-hub*.json` and `~/.artisyn/otel/port.json`. It does
accept `--otel-existing=proxy|keep|replace`. The trace answer is the stored `otelTraces` when present (no question asked); an install that predates it gets the same
TTY `[Y/n]` prompt as `install`, and a non-interactive upgrade answers yes.

`upgrade` re-extracts the plugin tree, re-runs the same `claude plugin marketplace add` /
`claude plugin install --scope project` sequence (both are no-ops if already up to date), and prints
`Previous version:` / `New version:` lines. If it detects a pre-plugin install, it runs the same migration `install`
would — `upgrade` no longer hard-exits when `.claude/telemetry_tool/version.json` is missing. Running `upgrade`
(or `install`) a second time with nothing to do changes nothing.

`upgrade` also resolves the shared OTEL port and writes the `env` blocks exactly as `install` does — this is the
only route by which an already-installed project starts receiving OTEL. An existing `~/.artisyn/otel/port.json` is
reused, so upgrading never moves the port. Upgrading a project from a per-project receiver (hook `2.29.0` or older)
moves it to the shared port: `otelReceiverPort` and the mirror are rewritten, `.artisyn/config/otel-port.json` is
deleted, and the old per-project receiver is left to its idle exit — see
[Upgrading from the per-project receiver](#upgrading-from-the-per-project-receiver).

---

## 3. Uninstall

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz uninstall
```

Removes `.artisyn/marketplace/` and `.artisyn/config/` (both JSON config files plus a legacy `otel-port.json`), and
surgically removes `enabledPlugins["log-hub-hooks@artisyn-<hash>"]` / `extraKnownMarketplaces["artisyn-<hash>"]`
(and the same keys under the legacy shared `artisyn` name) from `.claude/settings.json`, leaving every other
setting untouched.

The nine OTEL `env` keys (and the three trace keys, if present) are removed too, from both `.claude/settings.local.json` and `.claude/settings.json`
(older installs wrote them there) — but only the keys that are still ours, judged per key and per file. An endpoint
key is ours while it points at a loopback receiver (`http(s)://127.0.0.1|localhost:<port>/v1/logs|metrics|traces`) on a
port in the installer's allocation range or recorded in `~/.artisyn/otel/port.json` / `otel-port.json` / `log-hub.local.json` / `log-hub.json`. Any other key is ours
while it holds the installer's value and every endpoint key in the same file is ours. An endpoint repointed at your
own collector is left untouched, with a `Note:` line saying so, and so are the exporter keys beside it. An `env`
block left empty by the removal is dropped; `.claude/settings.local.json` is rewritten (with a `.bak`) only when a
key was actually removed, and is never deleted.

**Per-user OTEL state (hook `2.30.0`+).** This repo's entry is removed from `~/.artisyn/otel/repos.json`. While other
repos are still listed, nothing else in the user scope changes (`Kept the per-user OTEL receiver and the OTEL keys in
~/.claude/settings.json — <n> other repo(s) still use them.`). When it was the **last** repo:

- `~/.claude/settings.json` gets your original collector keys back exactly (from `~/.artisyn/otel/forward.json`,
  after a `proxy`/`replace`), and loses the Artisyn OTEL keys, `_artisynOtel` and the user-level `SessionStart`
  hook entry. `~/.claude/settings.json.artisyn-bak` is kept as your safety copy and named in the output.
- The shared receiver is stopped (authenticated shutdown); if that fails it exits on its own when idle.
- The files Log Hub created in `~/.artisyn/otel/` and `~/.artisyn/otel/bin/` are unlinked one by one, then both
  folders are removed only if empty — a folder still holding other files is kept and named.

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
        │   ├── otel-status.js
        │   ├── otel-ensure-receiver.js
        │   ├── user-state.js
        │   ├── managed-settings.js
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
        │   ├── harness-git-status.js
        │   ├── post-turn-analysis-hook.js
        │   ├── post-turn-analysis-worker.js
        │   ├── session-attribution-state.js
        │   ├── process-marker.js
        │   ├── harness-state.js
        │   ├── okf-snapshot.js
        │   ├── okf-state.js
        │   ├── ndjson-sanitize.js
        │   ├── code-inventory.js
        │   ├── edit-result-counts.js
        │   ├── claude-config-dir.js
        │   ├── project-root-override.js
        │   ├── tool-wrap-names.js
        │   ├── tool-wrap-config.js
        │   ├── tool-wrap-shims.js
        │   ├── tool-wrap-tee.js
        │   ├── tool-wrap-powershell.js
        │   ├── tool-wrap-records.js
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
  "version": "2.30.2",
  "description": "Records Claude Code session telemetry and uploads it to artisyn-log-hub.",
  "author": { "name": "Artisyn" }
}
```

### `hooks/hooks.json`

All 15 events wired — the hook is monitoring/logging only and never blocks or denies a tool call (the `PreToolUse`
guardrail was removed in `2.19.0`): `telemetry-hook.js` on `UserPromptSubmit`, `tool-wrap-powershell.js` on
`PreToolUse` (matcher `PowerShell`, hook `2.27.0`+), `lifecycle-hook.js` on the 12 remaining lifecycle events, and
`send-logs-hook.js` + `post-turn-analysis-hook.js` on `Stop`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/telemetry-hook.js"], "statusMessage": "Recording prompt..." }] }
    ],
    "PreToolUse": [
      { "matcher": "PowerShell", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-wrap-powershell.js"], "statusMessage": "Preparing tool monitoring..." }] }
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

`prompt-upload-hook.js`, `otel-receiver.js`, `otel-register.js`, `otel-endpoint-check.js`, `otel-restart.js`, `otel-status.js`,
`otel-ensure-receiver.js`, `user-state.js`, `managed-settings.js`, `session-files.js`,
`throttle-state.js`, `claude-invoke-async.js`, `skill-catalog.js`, `harness-snapshot.js`, `harness-git-status.js`, `post-turn-analysis-worker.js`,
`session-attribution-state.js`, `process-marker.js`, `harness-state.js`, `okf-snapshot.js`, `okf-state.js`, `ndjson-sanitize.js`, `code-inventory.js`,
`edit-result-counts.js`, `claude-config-dir.js`, `project-root-override.js`, `tool-wrap-names.js`, `tool-wrap-config.js`,
`tool-wrap-shims.js`, `tool-wrap-tee.js` and `tool-wrap-records.js` are **not** wired to any event — they are detached child processes / shared modules
launched by the hooks above, so they never appear in `hooks.json`. The one exception is `otel-ensure-receiver.js`:
after a `proxy` choice (see [An existing OTEL collector](#an-existing-otel-collector)) the installer wires its
`~/.artisyn/otel/bin/` copy as a **user-level** `SessionStart` hook in `~/.claude/settings.json`, so the receiver
that forwards to your collector also runs for projects without the plugin. It answers within ~500 ms, never prints
and always exits 0.

`send-logs-hook.js` is wired to two events and behaves differently on each:

| Event | Behaviour |
|---|---|
| `Stop` | The full run — scans every namespace across all sessions, honours `.claude-logs.sent`, injects context events, reports `hook-status`, prunes otel. Waits up to 2s for the shared upload lock, since it blocks the interactive turn. |
| `SessionEnd` | A short, scoped flush of just the ending session's own `artisyn` + `claude` files (plus its `tool-calls` upload when the CLI tool wrapper recorded anything). Waits up to 20s for the lock — it is the session's last trigger, so giving up strands those files until some other session happens to run a full scan. Writes no `.claude-logs.sent` entry. |

`tool-wrap-powershell.js` (hook `2.27.0`+) is the only `PreToolUse` entry, and only for the `PowerShell` tool. It is
the PowerShell side of the CLI tool wrapper (Tools/MCP tab): the PowerShell tool does not read `$CLAUDE_ENV_FILE`, so
the Bash shims `lifecycle-hook.js` puts on `PATH` at `SessionStart` do not reach it. When the command mentions a
monitored tool as a command word, the hook answers with `hookSpecificOutput.updatedInput` — the same input with a
one-line prefix that defines a PowerShell function per mentioned tool; the function runs the real tool, records the
call under `.artisyn/ai_work_dir/tool-wrap/<session-id>/calls/` and re-emits its output and exit code unchanged
(text-level). In every other case — no monitored tool mentioned, `LOGHUB_TOOL_WRAP=0`, `toolWrap: false`, monitoring
paused in the UI, no cached config, a tripped breaker, or any error — it exits 0 with no output and the call runs
untouched. It never returns a permission decision, so the normal permission flow applies to every call. The recorded
calls are uploaded by `send-logs-hook.js` as log kind `tool-calls` (assembled by `tool-wrap-records.js`); a server
older than this feature stores that upload as an inert log.

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

- `.artisyn/config/log-hub.json` — tracked, non-secret settings shared by every checkout.
- `.artisyn/config/log-hub.local.json` — gitignored per-developer settings: `apiKey`, `serverUrl` and
  `otelReceiverPort`. Written by every install (installer `1.0.75`+). Older installers put `serverUrl` and
  `otelReceiverPort` into `log-hub.json`; that still works, and a `serverUrl` already in the tracked file stays a
  fallback.

`log-hub.local.json` overrides `log-hub.json` per top-level key (whole-value replacement, including arrays — no
merge/concatenation). An explicit `null` in the local file means "absent", falling through to the base file's
value. A file that's missing, unparseable JSON, or has a non-object root falls back to defaults for every key it
would have contributed (one `[warn]` line to `.artisyn/ai_work_dir/hook.log` in the malformed case; silent when merely
absent).

To add your credentials manually, merge them into `.artisyn/config/log-hub.local.json` (gitignored — never commit),
keeping the keys already there:
```json
{ "serverUrl": "<server-origin>", "apiKey": "<your-api-key>" }
```

### Project root and linked worktrees (`ARTISYN_PROJECT_ROOT`)

The "git repo root" above is the **main checkout**: inside a linked git worktree the hook resolves the root from
`git rev-parse --git-common-dir`, so a worktree session reads the main checkout's `.artisyn/config/`, writes to its
`.artisyn/ai_work_dir/` and uploads `git.root` = the main checkout.

Since hook `2.23.0`, the environment variable `ARTISYN_PROJECT_ROOT` overrides this. When it is set, non-blank, and
the hook's `cwd` is that directory or inside it, the hook uses that directory as the project root instead — for
config, the work dir, the OTEL receiver owner, Claude's transcript-project lookup and the uploaded `git.root`. It is
meant for an environment that can see only one worktree (e.g. a dev sandbox container), where the main checkout
is not available. When the `cwd` is outside the directory, or the variable is unset or blank, the variable is
ignored and nothing changes, so a container-wide value does not affect other repos run from the same environment.
It is read from the hook process's environment (inherited from Claude Code), not from the config files.

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
| `otelReceiverPort` | `0` | number | Loopback port of the OTEL receiver. Hook `2.30.0`+ reads the port from `~/.artisyn/otel/port.json` and uses this key only when that file is missing (the per-project fallback); older hooks always read it. The installer always overwrites it with the shared port, so re-install with `--otel-port` instead of editing it. `0` means "not yet allocated". |
| `otelReceiverIdleTimeoutMs` | `600000` | number | No request of any kind for this long and the receiver exits (10 min). `0` means "use the default". Applies only to the per-project fallback receiver: the shared receiver always uses 10 min, because no single repo owns it. |
| `otelReceiverMaxBodyKb` | `8192` | number | Request bodies larger than this are rejected (`413`) without writing anything. **KiB**, converted to bytes by the spawning hook. Measured on wire bytes, before decompression. `0` means "use the default". |
| `otelTraces` | _(absent)_ | boolean | The installer's trace opt-in answer (hook `2.29.0`+, written by `--otel-traces` or its prompt). It does not switch anything at runtime — the trace `env` keys do; `true` only makes the `SessionStart` endpoint self-check also check `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Change it by re-running `install --otel-traces=yes|no`. |
| `otelRealtime` | `true` | boolean | Realtime channel (hook `2.29.0`+): the OTEL receiver also forwards new log and span lines to `POST <serverUrl>/api/v2/otel-realtime` in small batches, so the OTEL tabs update during a session. Best-effort — the chunk files stay the durable copy and are uploaded on `Stop` as before. `false` turns it off. |
| `otelRealtimeIntervalMs` | `5000` | number | Minimum gap between realtime batches per session; values below `5000` are raised to it, and a larger server-requested minimum wins. |
| `otelRetentionDays` | `7` | number | `<telemetryDir>/otel/<session-id>/*.jsonl` chunks older than this (by mtime) are deleted at the end of a later `Stop` run, along with abandoned `.tmp` files and emptied session directories. A chunk whose upload failed in that same run is kept (since hook `2.21.0`), so a server outage at the cutoff never discards it. `0` means "use the default". |
| `mcpProbeTimeoutMs` | `3000` | number | Per-server timeout for the `Stop`-hook's live MCP `tools/list` probe (each configured stdio-transport MCP server is probed sequentially, so total added latency is bounded by this value × the number of configured servers). |
| `turnEndCostAdvisorModel` | `"sonnet"` | string | Claude model used for the Turn-End Cost Advisor branch's `claude -p` call (hook `2.9.0`+). |
| `turnEndCostAdvisorLlmTimeoutMs` | `600000` | number | Timeout for the advisor branch's LLM call (10 min — it runs detached, off the interactive path, and may itself read several files/skills worth of context); on timeout the run is recorded as `failed` (fail-open). |
| `turnEndCostAdvisorMaxPromptSizeKb` | `60` | number | Cap on the advisor prompt's free-text "user prompts" sample; fixed fields (aggregate numbers, tool/file usage) are never truncated. |
| `sessionAttributionMaxPromptSizeKb` | `60` | number | Cap on the AI Session Attribution prompt's free-text "user prompts" sample; attribute definitions and the changed-file list are never truncated. |
| `sessionAttributionLlmModel` | `"haiku"` | string | Claude model used for the AI Session Attribution branch's `claude -p` call. |
| `sessionAttributionLlmTimeoutMs` | `600000` | number | Timeout for the attribution branch's LLM call (10 min — same rationale as the advisor branch's timeout above); on timeout the run is recorded as `failed` and counts toward the 3-consecutive-failure cap. |
| `okf` | `{"exclude": []}` | object | OKF knowledge-base snapshot settings (hook `2.26.0`+). `okf.exclude` is an array of repo-relative globs (`**`, `*`, `?`) whose files and folders are never scanned for OKF bundles (folders whose `index.md` front matter has an `okf_version:` key); `tmp/**` is always excluded on top of it. Like every top-level key, `log-hub.local.json`'s `okf` replaces `log-hub.json`'s whole object — the two `exclude` lists are not merged. A non-array `exclude` is ignored with one `[warn]` line. An older hook ignores the key. Example: `{"okf": {"exclude": ["vendor/**", "docs/archive/**"]}}`. |
| `toolWrap` | `true` | boolean | CLI tool wrapper local kill switch (hook `2.27.0`+). `false` (or the environment variable `LOGHUB_TOOL_WRAP=0`) turns the wrapper off for this checkout: no shims are put on `PATH` at `SessionStart`, the `PreToolUse` PowerShell entry never rewrites a command and no `tool-calls` log is uploaded. The list of monitored tools itself is configured on the server, not here. An older hook ignores the key. |
| `toolWrapConfigTimeoutMs` | `2000` | number | HTTP timeout for fetching the monitored-tools config from the server (hook `2.27.0`+); the once-a-minute refresh on each prompt caps it at 1000 ms. On timeout or any error the hook keeps its cached config (fail open — it never blocks a session). |

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
a loopback endpoint and `otel-receiver.js` listens there, filing records into
`<telemetryDir>/otel/<session-id>/<epoch-ms>-<seq>.jsonl` — **one chunk file per inbound OTLP request**, which the
normal `Stop` upload then ships as a fourth log namespace (`claude-otel`, alongside `artisyn`, `claude` and
`claude-subagent`).

**One receiver per OS user (since hook `2.30.0`).** Claude Code `2.1.282` and later ignore telemetry keys in
`.claude/settings.json` and `.claude/settings.local.json`: they must be in the user scope (`~/.claude/settings.json`)
or in managed settings. A user-scope endpoint names one port for every project, so one receiver serves every repo of
the OS user. Each hook registers its session (`POST /artisyn/register`, with this repo's git root, chunk directory,
uploader and realtime target), and the receiver files every record under the repo that registered its
`session.id`. A record that arrives before its session registers waits in a small in-memory spool (5 min, 5000
records); a record without a session id is routed by its `artisyn.repo` resource attribute (see
[the `env` block](#the-otel-env-block)). The receiver binds `127.0.0.1` only and authenticates every
state-changing request with an HMAC handshake over the per-user secret `~/.artisyn/otel/token`, so another OS user
or a foreign program on the same port is detected (`port-conflict`), never trusted.

Per-user state lives in `~/.artisyn/otel/` (resolved from the home directory on every call):

| File | Written by | Purpose |
|---|---|---|
| `port.json` | installer | `{version:1, port, allocatedAt}` — the shared receiver port |
| `token` | installer (hook if missing) | 64 hex chars, the receiver's shared secret |
| `repos.json` | installer | every installed repo: `repoKey`, git root, chunk dir, uploader, traces, hook version |
| `registry.json` | receiver | registered sessions (24 h TTL), persisted across receiver restarts |
| `forward.json` | installer | the `proxy`/`keep`/`replace` choice and the backup of your original collector keys |
| `receiver.log` | receiver | the shared receiver log (1 MiB truncate, never uploaded) |
| `claude-version.json` | hook | cached Claude Code version |
| `bin/otel-receiver.js`, `bin/version.json`, `bin/otel-ensure-receiver.js` | installer | the receiver copy and the user-level hook |

**Without `port.json`** (for example the plugin auto-updated its scripts but the installer never ran), a `2.30.0`
hook keeps the pre-`2.30.0` per-project receiver on `otelReceiverPort` and writes one `warn` per session to
`hook.log`: `otel: ~/.artisyn/otel/port.json is missing — using the per-project OTEL receiver; run the log-hub
installer to enable the shared receiver`. This is a missing-install fallback, not a setting.

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
is a guess. So each OS user gets **one randomly allocated port** in `[25000, 65535]`, shared by all their repos.

Resolution order at install time, first match wins:

1. `--otel-port <n>` — also rewrites the user scope and every installed repo (see the flag table).
2. The `port` in `~/.artisyn/otel/port.json` — this is what keeps the port stable across reinstalls, upgrades and
   repos.
3. A fresh allocation, then persisted to `port.json`.

Every candidate must pass both a bind probe **and** a full loopback HTTP round-trip before anything is written, so
a port blocked by a local proxy or an IPv4/IPv6 mismatch is never persisted.

`port.json` (`{"version": 1, "port": 31447, "allocatedAt": "<ISO>"}`) is the authoritative record. It lives in the
home directory, never in the repository, so a port is never inherited by a teammate's checkout. Each repo's
`log-hub.local.json` `otelReceiverPort` is an output of it, never an input. The pre-`2.30.0` per-project store
`.artisyn/config/otel-port.json` is deleted by the next install or upgrade.

If something that is not this user's receiver holds the port (another program, or another OS user's receiver), the
hello handshake fails (`409 owner-mismatch`, a bad proof or a non-JSON answer) and the hook writes one
`otel port-conflict port=<n> detail=<…>` warning per session to `.artisyn/ai_work_dir/hook.log`. The hook never
allocates a port itself: fix it by re-installing with `--otel-port <n>`, then restart Claude Code.

### Upgrading from the per-project receiver

Up to hook `2.29.0` each project had its own receiver on its own port, in `.artisyn/config/otel-port.json`. An
`upgrade` (or `install`) to `2.30.0`:

- allocates or reuses the per-user port and writes the user-scope keys and the project mirror for it;
- rewrites `otelReceiverPort` in `log-hub.local.json` to the shared port and deletes `otel-port.json`;
- does **not** stop the old receiver — it keeps its old port until its idle exit (10 min without traffic), so a
  Claude Code session still running on the old endpoint keeps working until restarted.

### The OTEL `env` block

Written by `install` and `upgrade`, with `<port>` = the per-user port, to two places:

- **`~/.claude/settings.json`** (`$CLAUDE_CONFIG_DIR/settings.json` when set) — the user scope, the only place
  Claude Code `2.1.282`+ reads telemetry keys from (besides managed settings). Before the write the file must parse
  and have the expected shape (`env` an object of strings, `hooks` an object of arrays, `otelHeadersHelper` a
  string), otherwise the run aborts with the file untouched. The previous content is saved to
  `settings.json.artisyn-bak` and the file is replaced atomically. The trace keys go in while any installed repo of
  the user has traces on.
- **`.claude/settings.local.json`** — the per-checkout mirror (not the usually committed `.claude/settings.json`),
  read by Claude Code older than `2.1.282`. It also gets `OTEL_RESOURCE_ATTRIBUTES` = the user-scope value (if
  any) + the existing local value + `artisyn.repo=<repoKey>`, comma-joined and deduped by attribute key, so your
  own attributes are carried over. `<repoKey>` is the first 16 hex chars of `sha256(<normalised git root>)` — the
  only repo identifier sent in OTEL data, so no local path reaches a collector.

The keys:

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
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_METRIC_EXPORT_INTERVAL": "10000"
  }
}
```

Merging is **per key**, and any `OTEL_*` value you set yourself always wins ("ours" is the ownership rule from
[Uninstall](#3-uninstall); an endpoint on the per-user port is ours too). In `~/.claude/settings.json` an absent or
still-ours key is (re)written, and a value of yours is kept and listed in `Note: kept your existing
~/.claude/settings.json env values for …` — except an existing collector's endpoint, which is handled by
[An existing OTEL collector](#an-existing-otel-collector). In the project files:

- A key in `.claude/settings.json` that is still ours (an older install wrote it there) is moved out of that file;
  `Note: moved the Artisyn OTEL env keys from .claude/settings.json to .claude/settings.local.json.`
- A key in `.claude/settings.json` that is yours is kept, nothing is written for it to `settings.local.json`, and a
  `Note: kept your existing .claude/settings.json env values for …` line lists it.
- Otherwise an endpoint in `settings.local.json` that is absent or ours is set to the current receiver port. A stale
  port is rewritten, with
  `Note: rewrote stale Artisyn OTEL endpoints in .claude/settings.local.json (<KEY>: <old> → <new>, …).`
- Any other key is filled only if absent; a value of yours is kept and listed in
  `Note: kept your existing .claude/settings.local.json env values for …`.

`.claude/settings.local.json` is created when absent, and it and its `.bak` are added to `.claude/.gitignore` when
git does not already ignore them. Either file not being valid JSON aborts the run before any write.
`OTEL_EXPORTER_OTLP_COMPRESSION` is set explicitly so the encoding never depends on an exporter default; the
receiver still accepts `gzip`/`deflate` if you override it. `upgrade` also prints
`Note: Claude Code sessions that are already running keep their old OTEL endpoint until restarted.` — Claude Code
reads its env once, at startup.

**Endpoint self-check (since hook `2.18.0`):** on every `SessionStart` (when `otelEnabled`), the hook
reads the effective `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (and, since `2.29.0`,
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` when `otelTraces` is `true`) from
`.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when set) → process env. It reads the files
because Claude Code does not forward the `OTEL_*` keys to hook processes. Since `2.30.0` it resolves the
**effective** config the way Claude Code does: managed settings win per key, and for Claude Code `2.1.282`+ the
project files are ignored. If an endpoint is missing, or is a loopback endpoint on a different port than the
receiver, the hook writes one `warn` line to `hook.log` **and** shows a `systemMessage` warning in Claude Code ending
with `Fix: re-run the log-hub installer "upgrade" (it writes <keys> for port <port> to ~/.claude/settings.json and
.claude/settings.local.json), then restart Claude Code.` (only `.claude/settings.local.json` in the per-project
fallback). A non-loopback endpoint (your own collector) is never reported. Three more `warn` lines, each once per
`SessionStart`:

- `otel project-only: …` — the Artisyn keys exist only in `.claude/settings*.json`, which this Claude Code ignores;
  also shown as a `systemMessage`.
- `otel endpoint-drift: …` — the user-scope endpoint no longer points at the receiver although the installer set it
  up (`~/.artisyn/otel/forward.json`).
- `otel port-mismatch: …` — a user-scope loopback endpoint names another port than `port.json`.

The hook only detects problems and never rewrites any settings file.

### An existing OTEL collector

When `~/.claude/settings.json` or the process environment already sends Claude Code's OTEL to a collector that is not
Log Hub's (an OTLP endpoint key or `otelHeadersHelper`), the installer lists it per signal — endpoint, protocol,
`headers: set` (never the values) and exporter — names the stream changes Log Hub adds (`OTEL_LOG_TOOL_DETAILS=1`,
export intervals, traces if on), and asks:

| Choice | Effect |
|---|---|
| `proxy` (recommended, the TTY default) | The endpoints point at the Log Hub receiver, which forwards each OTLP request unchanged to your collector (header keys and `otelHeadersHelper` stay). Forwarding is bounded (1000 requests / 32 MiB per signal) and retried with backoff on `429`, `5xx` and network errors. A user-level `SessionStart` hook (`~/.artisyn/otel/bin/otel-ensure-receiver.js`) keeps the receiver running for projects without the plugin. |
| `keep` (the non-interactive default) | Your collector is left untouched and no Artisyn OTEL key goes into the user scope — the Log Hub OTEL tabs stay empty. |
| `replace` | The data goes only to Log Hub; your collector stops receiving it. |

The receiver forwards only to an OTLP/HTTP (JSON) endpoint. For a `grpc` or `http/protobuf` collector the installer
says so and offers to enter an OTLP/HTTP URL of the same collector (typically `http://<host>:4318`), `keep` or
`replace`; a non-interactive run keeps it.

For `proxy` and `replace` the original keys are saved to `~/.artisyn/otel/forward.json` first, and
`~/.claude/settings.json` gets an `_artisynOtel` note (mode, masked previous values, backup path). The choice is
remembered with a fingerprint of the collector config: an unchanged collector reuses it without asking; a changed one
asks again. `--otel-existing=` always wins. Switching back to `keep`, or uninstalling the last repo, restores the
original keys exactly.

### Admin-managed OTEL

Managed settings (the managed-settings file, OS policy / MDM, or server-managed settings) win over the user scope
per key. When they pin an OTEL endpoint or disable telemetry, the installer writes no user-scope OTEL keys and
prints `OTEL is managed by your organization — OTEL tabs are unavailable, everything else works.` It still writes
the project mirror and the `repos.json` entry. Sessions, prompts, tools, files, attribution and Log Hub cost keep
working; only the OTEL tabs, traces and telemetry cost reconciliation need the admin.

### The `otel-status` event

Since hook `2.30.0`, at `Stop` and `SessionEnd` the uploader asks the receiver how much it received for the session
(`POST /artisyn/session-status`) and appends an `otel-status` line to the session's `artisyn` log when the state
changed: `state` (`ok`, `partial`, `none`, `unknown`), a `reason` when it is not `ok` (`managed-endpoint`,
`managed-disabled`, `project-only`, `not-configured`, `receiver-down`, `unknown`), the counts per signal, the
Claude Code version, the forward health and the hook and receiver versions. `hook.log` gets one
`otel-status state=… reason=… detail=…` line per event. The session's OTEL tab uses it to explain why it is empty.
In the per-project fallback it is written only at `SessionEnd`, with `detail:"legacy-receiver"`. A server older
than this ignores the line.

### Traces (opt-in)

Since hook `2.29.0` the installer can also turn on Claude Code's trace export (enhanced telemetry beta). With
`--otel-traces=yes` (or a yes to the prompt) three more keys are merged into the same `env` block, by the same
per-key rules:

```json
{
  "env": {
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://127.0.0.1:<port>/v1/traces"
  }
}
```

The receiver accepts `POST /v1/traces` and files each span as a `signal:"spans"` line in the same chunk files.
With `no`, the three keys are removed again while they are still ours (`Note: OTEL trace export is off — removed
the Artisyn trace env keys (…).`); a trace key you set yourself is kept. The answer is stored as `otelTraces`, so
`upgrade` keeps it. A hook older than `2.29.0` answers `404` on `/v1/traces`; that only costs the traces.

### Disabling OTEL

`otelEnabled: false` is **runtime-only** — it stops the hook spawning the receiver, registering, uploading and
pruning, but does not retract the `env` block, so Claude Code keeps exporting to a port nothing listens on. That is
harmless (the port is a random high one, not `4317`/`4318`). The shared receiver is still started by other repos of
the same user. To disable it fully, run `uninstall` in every repo: removing the last one also removes the user-scope
keys. Deleting the nine `env` keys (twelve with traces) by hand works too — from both `~/.claude/settings.json` and
`.claude/settings.local.json`.

### Receiver diagnostics

The shared receiver writes `~/.artisyn/otel/receiver.log` (plain text, truncated above 1 MiB, never uploaded); its
`start listening` line names `mode=shared` and a prefix of the owner hash, never a home path. Each `ingest` line is
also mirrored into the target repo's `<telemetryDir>/otel/receiver.log`, so a repo's own log still shows that the
exporter is reaching it. Records waiting for their session to register log a pending `ingest`; rejected
authentication logs `auth-reject route=…`; a session re-registered from another repo logs `register-rebind`;
forwarding logs `forward signal=… status=… queued=… dropped=…` (no header values). An `addr-in-use` line is
normal — one receiver serves every session of every repo; back-to-back repeats are written once. A `no-data` line at
idle-exit means no OTLP request arrived during the receiver's whole life: Claude Code is not exporting to it (the OTEL
env must be in `~/.claude/settings.json`, not in a project's `.claude/settings*.json`; restart Claude Code after fixing).
Each `install` / `upgrade` also writes one `[installer]` line to `.artisyn/ai_work_dir/hook.log` with the version
change and the server; a `warn` line `DOWNGRADE` means the installer was older than the installed hook. The shared receiver exits on its own after 10 min without
traffic (the per-project fallback after `otelReceiverIdleTimeoutMs`), logging an idle-exit summary.
`<telemetryDir>/otel/receiver.log` is the whole log of the per-project fallback receiver.

The receiver runs from the OS temp directory (`os.tmpdir()`), not from the project, so it never holds a lock on
the project folder (since hook `2.21.0`). If the project's `otel` directory has been deleted while it runs, it
logs `dir-gone` and drops the incoming records instead of re-creating the directory tree. The shared receiver
creates a repo's `otel` directory only when a session of that repo registers (since hook `2.30.2`), and the
installer creates it at install.

**Telemetry tail upload (since hook `2.21.0`).** Claude Code keeps exporting after the session's last `Stop`, so
the final chunks used to wait on disk until the project's next session. The receiver now checks once a minute:
when no request has arrived for 60 s and some `<session-id>/*.jsonl` chunk is pending, it spawns
`send-logs-hook.js --otel-sweep --cwd <git-root>` detached — the shared receiver once per repo with pending chunks,
using the uploader that repo registered (or listed in `repos.json`); it does the same once more right before its idle exit.
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

This auto-restart applies to the per-project fallback only. **A shared receiver is never restarted by a hook**
(since `2.30.0`): it serves other repos and sessions too. A newer hook uses an older running shared receiver as is
and writes one `warn` per session for each capability it lacks (`spans` with traces on, `realtime`,
`session-status`); the newer code takes over after the receiver's idle exit. The first hook that finds no receiver
spawns its own plugin copy of `otel-receiver.js` ("first spawner wins"). To switch at once, run
`--restart-otel-receiver` (see [Install](#1-install)).

### Install/upgrade and the running receiver

Up to hook `2.29.0`, `install` and `upgrade` stopped the project's receiver before extracting
the new plugin tree. Since hook `2.30.0` they stop nothing: the shared receiver keeps serving the other repos and
already holds its code in memory, and an old per-project receiver is left to its idle exit. Only uninstalling the
last repo stops the shared receiver.

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
- OTEL chunk files (`<session-id>/<epoch-ms>-<seq>.jsonl`) + the repo's receiver log: `<repo-root>/.artisyn/ai_work_dir/telemetry/otel/`
- Shared OTEL receiver state and log (hook `2.30.0`+): `~/.artisyn/otel/` (`receiver.log`, `port.json`, …)
- Turn-End Cost Advisor / AI Session Attribution activity logs: `<repo-root>/.artisyn/ai_work_dir/analysis.log` and
  `<repo-root>/.artisyn/ai_work_dir/attribution.log` — same format and rotation as `hook.log`, but each branch's own,
  separate from it and from each other (see HOW_HOOK_WORKS.md's "Hook diagnostic log" section).

For configuration options, event schemas, and how it works: [HOW_HOOK_WORKS.md](HOW_HOOK_WORKS.md)
