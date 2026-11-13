# PoC: network capture for the session Network tab

Task: [Session Network Tab](../../tasks/todo/2026-11-11-session-network-tab/requirements.md)
(FR-2 classifier, FR-4 Node tap, FR-5 Python tap, FR-9 always on, FR-11 bounded capture,
FR-12 noise separation, FR-13 best effort).

Python note: the repo bans Python for utility code; the user explicitly allowed it for this PoC to
check the Python tap. The only Python file is `pytap/sitecustomize.py` (product-like code); every
check is driven from Node.

## Questions

1. Node tap via `NODE_OPTIONS=--require` with `diagnostics_channel` only: what is observable
   (http/https, `fetch`, net, TLS, DNS) and with which fields / timing phases?
2. Fail-open: identical stdout / exit code, unwritable output dir, a bug in the tap; overhead.
3. Coexistence with an existing `NODE_OPTIONS`, paths with spaces, a missing tap file, restricted flags.
4. Per-process JSONL with caps stays bounded under a flood.
5. Layer-1 transcript classifier: precision / recall on fixtures; aggregate counts on real transcripts.
6. Concrete caps for bounded capture and DB size per record / session.
7. Python tap (`sitecustomize` + `sys.addaudithook`): events, fields, fail-open, chain-loading a user
   `sitecustomize`, `-I` / `-S` / venv, overhead.
8. Noise separation (FR-12): Log Hub self-traffic, service vs script, MCP, degradation when sources are missing.

## Layout

| File | Role |
|---|---|
| `tap/loghub-net-tap.cjs` | Node tap (preload): diagnostics_channel subscribers + `once` lifecycle listeners |
| `pytap/sitecustomize.py` | Python tap: PEP 578 audit hook, chain-loads the user's `sitecustomize` |
| `classifier/classify-net.cjs` | Layer-1 classifier of Bash / PowerShell command texts |
| `classifier/fixtures.json` | 46 command strings with expected accesses |
| `merge/merge.cjs` | Merges transcript + tap files into FR-1 records with caps and a coverage line |
| `merge/fixture-session.jsonl` | Synthetic transcript (WebSearch, WebFetch, Bash, PowerShell, MCP, a broken line) |
| `target/*.cjs` | Programs run under the tap (target, load generator, simple client) |
| `probe-channels.cjs` | Which channels fire in this Node version |
| `run-*.cjs` | The checks below |

## How to run (from this folder, Node only, no dependencies)

```bash
node probe-channels.cjs                      # Q1 channel inventory (tries https://example.com)
node run-tap-checks.cjs q1|q2|q3|q4|all      # Q1-Q4 (q4 = 100k requests, ~6 s)
node run-missing-tap-mitigation.cjs          # Q3 follow-up: missing / broken tap file
node classifier/run-classifier.cjs           # Q5 fixtures
node classifier/run-classifier.cjs --transcripts   # Q5 + aggregate counts over <home>/.claude/projects
node merge/run-merge.cjs                     # Q6 sizing + Q8(d) degradation
node run-noise-checks.cjs                    # Q8(a)(b) Node
node run-python-checks.cjs [3.12]            # Q7 + Q8 Python (`python`, or `py -3.12`); skips without Python
# other Node versions, offline images already pulled:
docker run --rm -v "<poc-dir>:/poc:ro" -w /poc node:22-alpine node probe-channels.cjs
```

Run artefacts go to `work/` (gitignored). Note: do not flood real loopback connections on Windows
(a first version of the Python flood with 20 000 `connect()`s exhausted the ephemeral ports,
`WinError 10048`, and broke every other run for ~2 minutes); the Python flood now uses synthetic
`sys.audit()` events.

## Result

Environment: Windows 11, Node 26.13.0 (also Node 22.23.4 and 24.22.1 in Docker), Python 3.9.0,
3.12.10 (with `requests`), 3.15.2. Real external requests to `example.com` / `example.org` worked.

### Q1 Node tap: what is observable — yes, everything needed, no monkeypatching

Channels that fire (identical on Node 22, 24, 26 except one):

| Need | Channel | Notes |
|---|---|---|
| http/https client | `http.client.request.created` / `.start`, `http.client.response.finish`, `http.client.request.error` | method, host, path, status from `request` / `response` |
| `fetch` | `undici:request:create`, `undici:client:sendHeaders` (gives the socket), `undici:request:headers` (status), `undici:request:trailers` (end), `undici:request:error` | `undici:request:bodyChunkReceived` (body bytes) only on Node >= 24 |
| TCP / TLS / DNS phases | `net.client.socket` + `once('lookup' / 'connect' / 'secureConnect' / 'close')` on that socket | there is **no** DNS or TLS channel; the socket events give the phases |
| listen (service) | `tracing:net.server.listen:asyncEnd` | fires on 22, 24, 26 |

Record excerpt (Node 26, loopback recording on):

```json
{"t":"http","method":"GET","scheme":"https","host":"example.com","port":443,"path":"/","pathLen":1,"qLen":3,"status":200,"bytesIn":935,"bytesOut":65,"durMs":29.9,"phases":{"dns":4.4,"connect":5,"tls":10.5,"ttfb":29.7,"transfer":0.1},"role":"script"}
{"t":"fetch","method":"GET","scheme":"https","host":"example.org","port":443,"path":"/path/x","pathLen":7,"qLen":3,"status":404,"bytesIn":548,"bodyBytes":334,"bytesOut":148,"durMs":66,"phases":{"dns":5.9,"connect":4.5,"tls":41.8,"ttfb":64.9,"transfer":1},"role":"script"}
{"t":"socket","host":"127.0.0.1","port":"<p>","tls":false,"bytesIn":10,"bytesOut":0,"durMs":1.5,"phases":{"connect":1.2}}
```

All FR-8 waterfall phases (dns / connect / tls / ttfb / transfer) are available for a new
connection; a reused keep-alive socket gives `{reused: true}` + ttfb / transfer. The query string is
never stored, only its length (`qLen`). With the default loopback filter the same target produced
**no file at all** (the file is opened lazily on the first record).
PoC gap to fix in the product: `bytesIn` of `http` is the socket total, wrong for keep-alive reuse —
take the delta from request start like `fetch` does.

### Q2 Fail-open and overhead — passes, with one hard rule

| Case (Node) | stdout + exit code vs tap off |
|---|---|
| tap on, loopback filtered / recorded | IDENTICAL |
| output dir missing / output dir is a file | IDENTICAL, nothing recorded |
| bug inside guarded handlers | IDENTICAL |
| **bug in an unguarded diagnostics_channel subscriber** | **DIFFERENT: exit 1, uncaught exception** |

Hard rule: Node re-throws an exception from a channel subscriber as an `uncaughtException` — every
subscriber and every event listener must be wrapped in try/catch, and the tap must never add an
`'error'` listener (that would swallow errors the program expects to crash on). The same is true for
Python (below).

Overhead (median): `node -e 0` 28-33 ms → +2.5-2.9 ms with the tap (most of it is loading the
preload file; the kill switch `LOGHUB_NET_TAP=0` costs the same). 1000 sequential loopback requests:
http +0 µs/req and fetch +3-8 µs/req when filtered (realistic); +7-16 µs (http) and +34-38 µs
(fetch) per request when every request is recorded (one `writeSync` per record).

### Q3 NODE_OPTIONS coexistence — works, but two traps

- Appending works: `--max-old-space-size=300 --require "<tap>"` keeps the user's flag (heap 396 MB vs
  4192 MB default) and loads the tap.
- **Trap 1: Windows paths.** Inside double quotes `NODE_OPTIONS` treats `\` as an escape, so
  `--require "C:\x\tap.cjs"` fails with `Cannot find module 'C:xtap.cjs'` (exit 1); an unquoted path
  with spaces fails too. Use forward slashes and quotes: `--require "C:/dir with spaces/tap.cjs"` works.
- **Trap 2 (critical for always-on): a missing or broken preload kills every node process.**
  `--require <missing>` → `MODULE_NOT_FOUND`, exit 1, before the program runs (`node --version`
  still works). A tap file with a syntax error (e.g. half-written during a hook update) → exit 1 too;
  the tap's own try/catch cannot catch a parse error.
  Mitigations measured (`run-missing-tap-mitigation.cjs`):
  - **B (recommended): load through a data-URL loader** —
    `--import "data:text/javascript,await import('<file URL of tap>').catch(() => {})"` (URL-encoded).
    Missing tap → exit 0, program runs, no stderr; tap with a SyntaxError → exit 0; tap present →
    records written, channels subscribed before the main module. Startup 30.6 ms vs 31.0 ms for
    `--require` (same). Works on Node 22, 24, 26.
  - A (extra guard): in `$CLAUDE_ENV_FILE`, which Claude Code sources before every Bash command:
    `if [ -f "$tap" ]; then export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }…"; fi`. Verified,
    but it does not protect processes started after the file disappears; use it together with B.
- `--disallow-code-generation-from-strings`: tap works (no eval). `--permission` without
  fs-write: program runs normally, tap records nothing.
- Child processes inherit `NODE_OPTIONS`: a parent spawning 3 node children produced 3 files
  (one per process that made requests).

### Q4 Bounded per-process output — bounded

100 000 loopback requests (concurrency 20) with default caps (500 records / 256 KB per process):
file 147 577 bytes, 503 lines = `proc` header + 500 records + `{"t":"truncated","after":500}` +
`{"t":"summary","recorded":500,"dropped":99501}`. Average record 295 bytes. Wall time 2949 ms vs
2778 ms without the tap (+6 % under a pathological flood that records every request).

### Q5 Transcript classifier — usable; real data says 30 % of hits are loopback

Fixtures (46 commands, 42 expected accesses, incl. pipes, `&&`, `$(…)`, `bash -c`, quoted URLs,
env-var hosts, `ssh -p 2222 user@host cmd`, `git@github.com:org/repo.git`, PowerShell `-Uri`,
certutil, bitsadmin, `node -e` / `python -c`): first run precision 1.000, recall 0.976 (missed
`$r = Invoke-RestMethod …`), after the fix 1.000 / 1.000. The fixtures were written together with
the classifier, so this is an in-sample number.

Real transcripts (400 most recent local session files, aggregate only):

| Metric | Value |
|---|---|
| Bash / PowerShell commands | 7 603 (scanned in ~1.3 s) |
| commands with a network access | 594 (7.8 %), 935 accesses |
| by kind | http 602, git 203, ssh 68, package-registry 51, file-transfer 11 |
| by tool | curl 433, git 203, gh 160, ssh 68, npm 38, scp 11, docker 11, Invoke-WebRequest 5, … |
| host known | 707 / 935 (76 %; unknown = `git push origin`, `$VAR` hosts) |
| loopback / private LAN hosts | 281 (30 %) / 87 |
| command length | p50 219, p95 702, p99 1665, max 8415 chars |
| URL length | p50 40, p95 94, max 150 chars |

A manual look at 40 random hits found no clear false positive. Misses: URLs passed as arguments to
scripts (`node probe.mjs http://…`, `npx … --server-url …`) and heredoc bodies the simple tokenizer
mis-splits (8 accesses changed out of 935). The product should reuse the tree-sitter walk of
`cli-command-recognition.ts` (handles heredocs) and could tag "URL argument to an unknown command"
as low-confidence `inferred`.

### Q6 Bounded capture sizing — proposal

Measured inputs: tap record ~260-300 bytes; merged FR-1 record avg 279 bytes (max 338) on the
fixture; worst case with every excerpt at its cap 2198 bytes; URL p95 94 chars; ~2.3 accesses per
session file on real data.

| Cap | Value | Why |
|---|---|---|
| URL excerpt | 512 chars; taps never store the query, only `qLen` | max seen 150 |
| path (taps) | 256 chars + `pathLen` | |
| WebSearch query | 256 chars | queries are short; full text stays in the transcript |
| search result | domains only, max 20, no snippet text | snippets are the big part |
| WebFetch | URL only, no body | |
| command excerpt | 300 chars + "truncated, N bytes total" | p50 219; the full command stays in the transcript, the record links to the `tool_use` |
| host | 253 chars (DNS maximum) | |
| per process (tap file) | 500 records / 256 KB, truncation marker + summary | Q4: 148 KB at the cap |
| per session upload of tap files | 2 MB, oldest processes dropped first | ~7 000 tap records |
| per session stored records | 2 000, `droppedRecords` in coverage | typical ~0.6 MB, worst 4.2 MB before TOAST compression |

So one session costs about 300 bytes × accesses (≈ 1 KB for a typical session with 2-3 accesses);
the hard ceiling is ~4 MB per session tree, far below the wrapper's 50 MB.

### Q7 Python tap — works on 3.9 / 3.12 / 3.15 (minimum 3.8: `sys.addaudithook`)

Observable audit events and what they give:

| Event | Fields | Record |
|---|---|---|
| `socket.getaddrinfo` | host, port | folded into the next connect (host name for the IP) |
| `socket.connect` | IP, port | `connect` — every TCP connection: urllib, `requests` (urllib3 skips `http.client.connect`), raw sockets |
| `urllib.Request` | URL, method, data present | `url` — method, host, path, `qLen` |
| `http.client.send` | bytes sent | `bytesOut` total per process |
| `socket.bind` | address | service flag when the port is non-zero (`requests`' urllib3 binds `('::1', 0)` on import as a probe) |

**Not observable:** no response event exists → HTTP status, bytes in and duration are unknown
(records are point markers in the waterfall; FR-1 "unknown", never 0). `http.client.connect` is
redundant (not raised for `requests`) and is not recorded.

- urllib + `requests` + raw socket + external `https://example.com`: all captured (3.12: 1 `url` +
  3 `connect` loopback, 1 `url` + 1 `connect` external).
- stdout + exit code IDENTICAL for: tap on, output dir missing, output dir is a file, guarded bug.
  An **unguarded** exception in the audit hook aborts the audited operation → exit 1 (same rule as Node).
- Existing user `sitecustomize`: chain-loaded (next one on `sys.path` after ours, run under the name
  `sitecustomize`): output identical with and without the tap; a broken user `sitecustomize` gives
  the same "Error in sitecustomize" line and exit 0 as without the tap. A venv's own
  `sitecustomize` also still runs.
- `python -I`, `-S`, `-E`: tap bypassed (0 records), program unaffected. venv + `PYTHONPATH`: works.
- A missing `PYTHONPATH` directory is ignored by Python (no failure mode like Node's `--require`).
- Startup (`python -c pass`, median of 21): +0.6 ms (3.9), +1.1 ms (3.12), +1.4 ms (3.15) — only
  after two fixes: `import json` (+13 ms) moved to the first record, `threading` (+6 ms) replaced by
  `_thread`, `importlib.util` (+15 ms on 3.9) imported only when another `sitecustomize` exists.
  The audit hook sees every event (open, import, exec…): 50 000 `open()` calls cost ≤ 0.3 µs extra
  each. 300 loopback urllib requests (filtered): +0-27 µs per request.
- Flood: 100 000 synthetic getaddrinfo + connect events → 60 KB file, 500 records, truncation marker
  + `{"recorded":500,"dropped":99500}`.

### Q8 Noise separation

**(a) Log Hub self-traffic.** Hook processes are started by Claude Code from `hooks.json` as
`node <script>` with Claude Code's own environment; `$CLAUDE_ENV_FILE` is sourced only by the Bash
tool (see `docs/knowledgebase/tool-monitoring.md`), so hook scripts and the processes they spawn
(OTEL receiver, upload workers) never load the tap. Exception: the tool-wrapper shim runs
`node tool-wrap-tee.js` inside the Bash tool environment, so it does load the tap (no network, no
file, ~2.5 ms) — the shim should set `LOGHUB_NET_TAP_SKIP=1` for it. The hook knows the Log Hub URL
from `serverUrl` in `.artisyn/config/log-hub.local.json` (`hook/HOW_HOOK_WORKS.md`) and the OTEL
receiver port from `otelReceiverPort`; it writes them as `LOGHUB_NET_TAP_EXCLUDE=host:port,…` next to
`NODE_OPTIONS`. Measured (Node, two local servers "LH" and "API"):

| Case | Records |
|---|---|
| plain script calling LH and API | LH, API |
| `LOGHUB_NET_TAP_EXCLUDE=<LH host:port>` | API only |
| `LOGHUB_NET_TAP_SKIP=1` | none |
| main script under `LOGHUB_NET_TAP_SKIP_DIR` (hook install dir) | none |

Python: `SKIP` → no file, `EXCLUDE` → 0 records. The server drops Log Hub-origin records again
(merge case below), for old taps or a changed URL.

**(b) Service vs script.** Node: a short script's request → `role: script`; the same request
from a process that called `listen()` → `role: service` (+ `listenPort`); a process older than
`SERVICE_AFTER_S` (30 s default, 1 s in the test) without listen → `service`. Python: `bind` to a
fixed port → `service`, a short urllib script → `script`. The role is stamped on each record (no
extra line, so a listen-only process creates no file).

**(c) MCP:** not researched (user decision). MCP calls are already extracted from transcripts into
`session_tool_usage` (channel `mcp`, see `docs/knowledgebase/tool-monitoring.md`); the Network tab
can show them as kind `mcp`, destination unknown.

**(d) Degradation (`merge/run-merge.cjs`)** — every combination returns records and a coverage line,
none fails:

| Sources | Records | Coverage / hidden |
|---|---|---|
| transcript + node tap | 12 | transcript 7, nodeTap 5 (5 hidden as service: the target listens) |
| transcript only (old hook) | 7 | nodeTap / pythonTap / wrapper `missing` |
| node tap only | 5 | transcript `missing` |
| nothing | 0 | all `missing` |
| tap dir missing | 7 | `missingTapDirs: 1` |
| corrupt / half-written tap files | 8 | `malformedLines: 3`, the valid line kept |
| Log Hub origin given | 11 | `hidden.logHub: 1` |

No join of a transcript `curl` with its tap / wrapper record is done in the PoC (FR-3 matching is
the wrapper's existing algorithm).

### Blockers and surprises

1. **A missing or syntactically broken `--require` preload makes every node process exit 1.** With
   always-on taps this is the main risk; load the tap through the `--import data:` loader with
   `.catch()` (Q3 B), plus the `[ -f ]` guard in the env file.
2. An exception in a channel subscriber / audit hook is **not** isolated by Node / Python: it crashes
   the program (Node) or fails the socket call (Python). Every callback must be guarded.
3. Windows `NODE_OPTIONS` quoting: backslashes inside quotes are escapes → use forward slashes.
4. Python startup cost depends on what the tap imports (json +13 ms, threading +6 ms, importlib.util
   +15 ms on 3.9); with lazy imports it is ~1 ms.
5. Python cannot see responses: status, bytes in and duration are unknown for Python records.
6. 30 % of the transcript-visible accesses on real data are loopback (dev servers, local Log Hub):
   the loopback / service filtering of FR-12 matters as much as the capture itself.
