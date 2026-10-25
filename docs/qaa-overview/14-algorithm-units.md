# Unit tests for readable algorithms: inventory, doc format, review process

Owner's decision: unit tests stay **only** for readable algorithms (pure logic whose rules a person can read). Each such
algorithm has its own doc and a separate review that checks the tests make sense. The worked examples in the doc are
the test cases, so the test and the doc cannot drift apart.

This file holds the candidate inventory, the doc format, one complete sample, the review process, the totals and the
open questions. It is a design. Nothing was run or changed. I computed the numbers in the sample with **a separate
re-implementation of the formula in node** (not with the repository's code), so they must be checked by running the
real code during implementation. The mark **[inference]** means my inference from reading the code, not a verified
fact.

Sources: the deleted test-suite audit (its analysis notes and catalogue of meaningful tests; current state: [KB test](../knowledgebase/test/index.md)), the "Not covered by scenarios" and "What we lose" sections
in `scenarios/01..04`, the KB (`llm-call-math`, `change-surface`, `token-byte-ratio`, `password-requirements`,
`harness-usage-tab`, `data-retention`, `system-info-and-cluster`, `authorization-and-authentificaiton`,
`session-log-view`, `api-reference`, `db-tables`) and the real code. The test counts in the tables are approximate
(counted by `it(`; an `it.each` counts as one).

---

## 1. Candidate inventory

**50 candidates** in total: 35 "UNIT TEST", 11 "COVERED BY SCENARIO", 4 "NOT AN ALGORITHM". The 35 testable ones map
to **30 algorithm docs** (some rows share one doc, see the "Doc" column).

Legend for the "Tests now" column: "pure" is a pure function without mocks, "mocks" means dependencies are stubbed,
"DB" means a database is needed.

### 1.1 Money, tokens, time

| ID | Algorithm | What it computes, in plain words | Code | Where the user sees it | Docs now | Tests now | Verdict | Reason |
|---|---|---|---|---|---|---|---|---|
| A-01 | Session cost (formula) | Tokens times rates: input and output with the fast-mode surcharge (fast is a subset, surcharge `M-1`), cache read, cache write 5m and 1h at their own rates, web search per request, not per million. A missing rate gives `null`, not 0 | `server/src/logs/cost.sql.ts`: `sessionCostSql`, `computeSessionCost`. Twins: `client/src/viewer/lib/format.ts: computeCost`, `hook/.claude/telemetry_tool/post-turn-analysis-worker.js: computeLocalSessionCost` | Session list, Info, Summary, Executive Summary, Analytics (field `totalCost`/`computedCost`) | `llm-call-math.md` §2: **exists, matches the code**, but the hook is not named among the twins (see discrepancy D5) | `cost.sql.spec` ≈14 (pure), `format.test` (≈48, part of it on `computeCost`), part of `post-turn-analysis-worker.test` | UNIT TEST | Money. Scenario S-COST-02 checks one session, but it does not hold the edges (fast, null, strings from the DB) or the parity of the three copies. Doc: cost-formula |
| A-02 | Choosing the OTEL or the computed cost, discrepancy flag | Takes the cost from OTEL, except when it is below 50% of the computed one (then OTEL is treated as truncated and the computed cost wins). The warning shows at a discrepancy of 33% or more | `server/src/logs/otel-cost.sql.ts`: `resolveSessionTotalCost`, `isOtelCostIncomplete` (0.5), `otelComputedDiscrepancy` (0.33) | Session header: price and warning icon; `hasCostDiscrepancy` | `llm-call-math.md` §2 "Two cost sources": **partial**: the numbers 0.5 and 0.33 are scattered (0.5 in `server-endpoint-map.md:423`, 0.33 in `api-reference.md:101`), not collected in one place | `otel-cost.sql.spec` ≈14 (pure) | UNIT TEST | Money, an asymmetric rule with thresholds; S-COST-04 is P2 and a single case. Doc: otel-cost-selection |
| A-03 | Splitting cache-write into 5m and 1h | If `usage.cache_creation` has buckets, uses them; otherwise everything goes to 5m. The buckets add up to the original number | `server/src/logs/claude-extractor.ts: splitCacheCreationTokens`; twins: `client .../log-parser.ts: splitCacheWrite`, hook `post-turn-analysis-worker.js: splitCacheCreationTokens` | Cost (the buckets have different rates, 1.25x and 2x) | `llm-call-math.md` §1: **exists, differs in a detail** (D4) | part of `claude-extractor.spec` (106), `test/claude-extractor.spec` (13) | UNIT TEST | Silently distorts money; the rule is short. Doc: cost-formula (section 2) |
| A-04 | Session tokens from the log | Sums `usage` over assistant replies: dedupe by `message.id`, sidechain skipped in the root log and counted in the sub-agent log, first model | `claude-extractor.ts: extractClaudeStats` (lines ~757-1230) | Tokens in Summary, Info, Statistics; all money grows from here | `llm-call-math.md` §1, `session-log-view.md`: **partial** (the dedupe and sidechain rule is described briefly) | `claude-extractor.spec` 106 (pure), `test/claude-extractor.spec` 13 | UNIT TEST | Scenarios GS-01/GS-07 hold the main path, but dedupe and sidechain are corner rules. Reduce 106 to ≈8 rows. Doc: token-usage-dedupe |
| A-05 | Cache read ratio | `read / (read + write)`. A zero denominator gives `null`, not 0. The aggregate is the ratio of sums, not the mean of ratios. The "root / with descendants" pair | `server/src/logs/cache-ratio.sql.ts: cacheReadRatio(Sql)`; `reports/cache-read-ratio.service.ts: aggregateTokens`, `aggregateScope`; client `format.ts: cacheReadRatio`, `cache-ratio-aggregate` | Info "Cache read ratio", Summary "Low cache reuse", the Cache Read Ratio report | `llm-call-math.md` §8: **exists, matches** | `cache-read-ratio.service.spec` 29 (pure), client `cache-ratio-aggregate` 14 | UNIT TEST | S-REPT-02 (P0) checks the number, but not "mean versus ratio of sums" on varied data. Doc: cache-ratio-and-causes |
| A-06 | Causes of a large cache-write | Walks the turns; a turn whose cache write is above the threshold (default 25 000, allowed 1 000..10 000 000) is attributed to compaction if it carries a boundary, otherwise to a file re-read, otherwise "unexplained". The three buckets add up to the total cache-write | `server/src/logs/turn-walk.ts: classifyTurnCauses`; threshold in `cache-ratio.sql.ts`; client copy (test `cache-cause-parity`) | Cache Read Ratio report: causes | `llm-call-math.md` §8 "Cause decomposition": **exists, matches** | `turn-walk.spec` 24 (pure), client `cache-cause-parity` 6 | UNIT TEST | The algorithm reads like pseudocode, and a scenario will not catch server/client parity. Doc: cache-ratio-and-causes |
| A-07 | Work time | Sum over prompts: time of the last assistant reply before the next prompt minus the prompt's time | Server `claude-extractor.ts: computeWorkTime` (line 1316); client `log-parser.ts` (BFS over the turn, lines 1934-1967); hook `post-turn-analysis-worker.js: computeWorkTime` | Info "Autonomous work time", Analytics Work Time, Productivity, Executive Summary | **Exists, but differs from the code** (D1): three docs talk about `turn_duration` | `claude-extractor.spec` (part), `log-parser.test` (part), `post-turn-analysis-worker.test` | UNIT TEST | Every "per hour" number depends on it. First the owner must decide what is the truth (question 1). Doc: work-time |
| A-08 | Merging work intervals by day | Session intervals are merged (an overlap is not counted twice) and cut at day boundaries | SQL in `repositories.controller.ts` (work-time analytics) | Analytics Work Time (minutes per day) | `api-reference.md` ~line 1681: exists, descriptive | via the DB | COVERED BY SCENARIO | S-ANLT-01 holds a clean example (3.083 min instead of 5.083 with an overlap). It is SQL; a unit test is impossible without a DB |
| A-09 | Metrics over the session tree (sum, time-based, union) and tree walk | Root plus descendants: additive metrics are summed, time-based ones come from the root, sets are unioned; the walk is limited to depth 50 | `session-tree-metrics.sql.ts`, `session-tree.sql.ts` | Every "over the agent tree" number | `session-metrics-scope.md`: **exists** | `session-tree-metrics.sql.spec` 12 (pure) | COVERED BY SCENARIO | S-SESS-09 (P0), S-SESS-04. Keep one test for a `parent_session_id` cycle (depth), as scenario 03 asks |
| A-10 | Derived metrics: lines per hour, cost per line, cost per hour | `lines / (work/3600)`, `cost / lines`, `cost / (work/3600)`; a zero denominator gives 0 or `null` (it differs by place) | client `session-info-derive.ts: computeSessionInfoDerived`, `analytics/metrics.ts: computeProductivityValue` | Info (Lines / autonomous hr, Cost / line), Analytics Productivity | **NONE — a new doc is needed** (the formulas exist only in scenario 03) | `session-info-derive.test` 20, `productivity-metrics.test` 11 (pure) | UNIT TEST | The golden sessions cover the happy path, but the scenario itself writes "What we lose: 0 instead of NaN". A table of zeros is needed. Doc: derived-productivity |
| A-11 | Token estimates from bytes and images | Tokens equal bytes / 3.5 (or the model's `charsPerToken`); an image equals `w*h/750 + 1024` after shrinking to 1568 on the long side; an MCP definition is 150 tokens | client `log-parser.ts: BYTES_PER_TOKEN`, `resolveCharsPerToken`, `estimateImageInputTokens`; server `claude-extractor.ts: HARNESS_CONTENT_BYTES_PER_TOKEN = 3.5` | Context Usage, Logs (estimates for skills, rules, files), Harness Usage | `token-byte-ratio.md`, `llm-call-math.md` §4-5: **exists, but differs from the code** (D2, D3) | partly `context-data.test` 49 (pure) | UNIT TEST | Few rules, but the estimate differs between client and server. ≈4 rows in total. Doc: byte-token-estimates |
| A-12 | Context composition (context-data) | Splits the context into parts (system, rules, tools, files, history) by estimates | `client .../charts/context-usage/context-data.ts` | Charts → Context Usage | none | `context-data.test` 49 (pure) | COVERED BY SCENARIO | These are estimates; a person cannot derive the exact values independently. S-CHART-02 checks that the sum is consistent |
| A-13 | Position of the context-compaction marker | Places the boundary between turns and finds the turn after it | `client .../compact-boundary-placement.ts` | Logs, Context Growth | none | 9 (pure) | COVERED BY SCENARIO | S-SESS-05 (between turns 8 and 9). The scenario itself admits losing "several boundaries in a row"; not critical |

### 1.2 Change surface, detectors, versions

| ID | Algorithm | What it computes | Code | Where seen | Docs | Tests now | Verdict | Reason |
|---|---|---|---|---|---|---|---|---|
| A-14 | Concentration (how focused an edit is) | A 0..100 score from four components: entropy of the distribution over folders (0.40), share of the largest folder (0.25), focus on one module (0.20), folder proximity (0.15). Small edits (up to 6 files) are softened; 1-5 files get at least 60. The total over sessions is the union of paths, not a sum | `server/src/logs/change-surface/change-surface-metrics.ts: computeChangeSurface`, `concentrationBand` | Change surface tab, Summary tile, Analytics, report, `GET .../change-surface` | `change-surface.md` §2-3: **exists, matches the code** (checked against a table of 6 examples) | `change-surface-metrics.spec` 26, `change-surface-aggregate.spec` 20 (pure), client `tree-code-impact` 10 | UNIT TEST | Scenario S-SESS-09 hands the formula to a unit test explicitly ("a lock on the formula", question G13): band edges 39/40/59/60 and the thresholds. The complete sample doc is below. Doc: change-surface-concentration |
| A-15 | Normalizing changed-file paths | Windows and POSIX into one case-insensitive key, stripping the repository root (or two roots with a worktree), `outsideRepo`, truncation to 1024 | `change-surface/path-normalise.ts: normaliseChangedPath` | Change surface (file count, "outside repo") | `change-surface.md` (Design Decision 3): **exists** | `path-normalise.spec` 15 (pure) | UNIT TEST | The scenario loses `repo` versus `repoX`, worktree, case. Doc: change-surface-paths-and-kinds |
| A-16 | File kind (source, test, config, docs, other) | Ordered rules: test before source, docs before config | `change-surface/file-kind.ts: classifyFileKind`, `fileExtension` | Change surface (breakdown by kind) | `change-surface.md`: **exists** | `file-kind.spec` 15 (pure) | UNIT TEST | The rule order is exactly what breaks. Same doc as A-15 |
| A-17 | "Detected issues" detectors in Summary | Thresholds: context at or above 80% of the window on 30% of turns or more; cache ratio below 0.70 with 10 turns or more; change surface: scattered and at least 5 folders; more than 4 modules; single-file folders above 50% with 4 folders or more | `client .../summary/detectors/thresholds.ts` and `*.ts` | Summary → Detected issues | **NO single doc**; thresholds only in the code and partly in `change-surface.md:151` | `summary-detectors.test` 16, `change-surface-detectors.test` 22 (pure) | UNIT TEST | The GS scenarios check that three warnings appeared, but not the threshold edges. Doc: summary-detectors |
| A-18 | Version comparison (semver) and the outdated Claude Code version detector | Parsing and comparing versions; `v < stable` is critical, `stable <= v < latest` is success, otherwise empty | `server/src/common/semver.ts`; client `lib/semver.ts`, `lib/release-versions.ts`, `detectors/claude-version.ts`; hook `otel-register.js: isOlderVersion` | Summary, "Claude Code versions" report | **NONE** | `test/semver.spec` 17, client `semver.test` 4, `claude-version-detector.test` 12, `release-versions.test` 7 (pure) | UNIT TEST | Three copies of one version parser. Shared vectors. Doc: semver-compare |

### 1.3 Tool calls, log parsing

| ID | Algorithm | What it computes | Code | Where seen | Docs | Tests now | Verdict | Reason |
|---|---|---|---|---|---|---|---|---|
| A-19 | Tool call outcome | No result, user rejection, permissions, interruption: `unresolved`; `is_error`: `failure`; otherwise `success`. Failure rate equals failures / (successes + failures); with no resolved calls it is `null` | `server/src/logs/tool-stats.ts: classifyToolOutcome`, `isRejectionText`, `computeFailureRate`; twins: client `session-usage-derive.ts`, hook `post-turn-analysis-worker.js` | Statistics (Failures, Unresolved), Analytics Tools | `db-tables.md`, `api-reference.md`: describe the fields, **the rule is not collected** (NONE) | `tool-stats.spec` 88 (pure, part), client `session-usage-derive.test` 38 | UNIT TEST | S-SESS-08 explicitly keeps a "table of 7 rows" of rejection wordings. Doc: tool-outcome |
| A-20 | Counting Edit/Write lines | Added and removed lines from `structuredPatch` by the `+`/`-` prefix; a new file takes the line count of its content; otherwise `null` ("unknown", not "+0/-0"). Parity of server, hook and client | `tool-stats.ts: countPatchLines`, `diffLineCounts`; `hook/.../edit-result-counts.js`; client `session-usage-derive.ts` | Lines changed, Code impact, Change surface | **NONE** | `tool-stats.spec` (part), `edit-result-counts.test` 14 (pure) | UNIT TEST | Scenario S-INGEST/S-HOOK names "line-count parity" as a leftover (≈25 hook unit tests). Doc: tool-line-and-commit-counters |
| A-21 | Commits and PRs from Bash | Counts `git commit` and `gh pr create` calls in the command line; `commit-tree` is not a commit; two joined with `&&` are two | `tool-stats.ts: countCommits`, `countPullRequests`; a client twin | Productivity Counters (Commits, PR) | **NONE** | in `tool-stats.spec` and the client tests | UNIT TEST | Regular expressions, easy to break unnoticed. Same doc as A-20 |
| A-22 | Call duration and percentiles | Duration source by priority (toolUseResult, taskTotal, time difference), histogram buckets, P50/P95 interpolation | `tool-stats.ts: resolveToolDuration`, `bucketDurationMs`, `interpolateHistogramPercentile` | Statistics (`durationP50`) | **NONE** | `tool-stats.spec` (part) | UNIT TEST | S-SESS-08 explicitly loses durations. A small table. Doc: tool-duration-percentiles |
| A-23 | What counts as a prompt, and turn boundaries | A user event that is not sidechain, not `isMeta`, has no `agentId`, is not `<command-name>` and not `<task-notification>`; `<command-message>` counts; a turn runs from the prompt along the `parentUuid` chain but stops at the next prompt | client `log-parser.ts: isQualifyingUserEvent`, `collectTurnUuids`; copies `server/src/logs/turn-walk.ts:~116`, `claude-extractor.ts:~120`, hook `post-turn-analysis-worker.js: isQualifyingUserEvent` | Logs (turn count), Info "Prompts", every "per prompt" metric | `session-log-view.md` lines 67-70, 133-137: **partial**, and D1 is there too | `log-parser.test` 161 (pure), `turn-walk.spec` 24 | UNIT TEST | Four copies of the rule. Of the 161, ≈10 rows are needed; the golden sessions cover the rest. Doc: prompt-turn-qualification |
| A-24 | Repository file category | The file path becomes relative using the list of known folders, then is matched against the category patterns (default and user-defined) | `claude-extractor.ts: normaliseFilePath`, `classifyFile`, `DEFAULT_FILE_CATEGORIES`; client `log-parser.ts` ("keep in sync"); hook `post-turn-analysis-worker.js` | Analytics Files, Logs → Files | **NONE** | part of `claude-extractor.spec`, `log-parser.test` | UNIT TEST | Three "keep in sync" copies. S-REPO-06 checks only a user-defined category. Doc: file-category |
| A-25 | Parsing `<task-notification>` (workflow) | Extracts the workflow status, agent count and result from the notification | `server/src/logs/workflow-extractor.ts` | Logs and Info → Workflows | **NONE** | `workflow-extractor.spec` 12 (pure) | UNIT TEST | Scenario 03 itself proposes keeping 3 tests of the notification shape. P2. Doc: workflow-notification |
| A-26 | Harness usage tree | Builds the tree of sessions and workflows: parentless nodes, the `agent-` prefix, sidechain merge, order by earliest activity; the "Include sub-sessions" mode | client `.../harness-usage/harness-session-tree.ts`, `harness-elements.ts` | Session → Harness usage | `harness-usage-tab.md` "Tree assembly rules": **exists** (not checked line by line against the code) | `harness-session-tree.test` 14, `harness-elements.test` 23 (pure) | UNIT TEST | Scenario S-SESS-07 explicitly loses "the exact tree assembly rules". Doc: harness-usage-tree |
| A-27 | Harness usage report (inventory versus usage) | Joins the inventory (self-report) with usage from the transcript, computes percentages, strips the MCP prefix | `server/.../reports/harness-usage.service.ts`; client `harness-usage-rows` (35) | Reports → Harness Usage | `harness-usage-tab.md`: exists | `harness-usage.service.spec` 22 (pure), `harness-usage-rows.test` 35 | COVERED BY SCENARIO | S-REPT-04 with numbers (skill-alpha=1, skill-beta=0). Sorting and filters are UI |

### 1.4 Repositories, log ingest, retention

| ID | Algorithm | What it computes | Code | Where seen | Docs | Tests now | Verdict | Reason |
|---|---|---|---|---|---|---|---|---|
| A-28 | Repository URL normalization | Azure SSH and plain SSH to https, http to https, no login, no `.git` and no trailing `/`, lower-case host, `git://` as is; the result does not change on a second pass | `server/src/logs/repo-url-normalizer.ts: normalizeRepoUrl` | Repository list: one project equals one row; sessions are lost on a duplicate | A detailed docblock in the code; the KB only mentions it in `server-endpoint-map.md`: **NONE** | `repo-url-normalizer.spec` 21 (pure) | UNIT TEST | Scenario 02 itself asks for "one table-driven unit test of 10 rows". An error here shows up as "sessions disappeared". Doc: repo-url-normalization |
| A-29 | Attribute filter `attr=<key>:<op>:<value>` | Parsing the parameter (the value may contain colons), a set of 7 operators, value type check, 400 on errors | `server/src/logs/attribute-filter.sql.ts: parseAttributeFilters`, `validateAttributeFilterTypes` | URL `?attr=`, the session list filter and reports | `api-reference.md`: partial, **the parsing rules are not collected** | `attribute-filter.sql.spec` 42 (parsing pure, SQL with the DB) | UNIT TEST | Scenario 03 proposes "one server unit test". Parsing and validation only. Doc: attribute-filter |
| A-30 | Tolerant NDJSON parsing and cleanup in the hook | The server skips up to 10% of broken lines (strictly above the threshold fails); the hook drops every unparseable line before upload and records the reason | `server/src/logs/ndjson-parser.ts: parseNdjsonLinesTolerant` (`MAX_DROPPED_LINE_RATIO=0.1`); `hook/.../ndjson-sanitize.js: sanitizeNdjson` | Session upload: "one line lost" or "the whole file rejected"; the queue | `server-endpoint-map.md`: in passing; **NONE** | `ndjson-parser.spec` 8, `ndjson-sanitize.test` 15 (pure) | UNIT TEST | Data loss. S-HOOK-02 and S-INGEST-03 take the points 0.5% and 30%; scenario 04 explicitly hands the 10% threshold to a unit test. Doc: ndjson-tolerance |
| A-31 | Slicing an upload into chunks | Slice plan: each slice is compressed and fits the budget, shrinks on overflow, then falls back to uncompressed; slices have no gaps or overlaps and follow line boundaries | `hook/.../upload-logs.js: planCompressedSlices`, `planIdentitySlices`, `alignSliceBoundary` | A large session over v2 (not a byte is lost, no 413) | `hook-system-overview.md`, `hook-api-versioning.md`: constants, **no rule** | `upload-gzip.test` 17, `upload-logs.test` 18 | UNIT TEST | Here the invariants matter (slices cover the body exactly), not specific numbers. S-HOOK-03 gives the integration. Doc: upload-chunk-planning |
| A-32 | Import conflict "the longer one wins" | When importing an archive, the longer version of a session is taken | `repository-export-import.service.ts` | Repository import | `session-log-view`/KB partial | `repository-export-import.service.spec` 14 (mocks) | COVERED BY SCENARIO | S-REPO-11 (P0) |
| A-33 | Retention (storage period) | Deletes root sessions whose earliest record is older than `SESSION_RETENTION_DAYS` (30), in batches of 200 | `server/src/sessions/session-retention.service.ts` + SQL | Data Retention, old sessions disappearing | `data-retention.md`: **exists, matches** (defaults 30/1800000/200 checked against the code) | `session-retention.service.spec` 11 (mocks) | COVERED BY SCENARIO | S-SESS-08 (P0), S-ADM-06. The logic is in SQL; a unit test with mocks proves nothing |

### 1.5 Authorization and platform

| ID | Algorithm | What it computes | Code | Where seen | Docs | Tests now | Verdict | Reason |
|---|---|---|---|---|---|---|---|---|
| A-34 | Growing login delay (backoff) | After a failure: the 1st is free, the 2nd blocks for 1 s, the 3rd for 2 s, the N-th for N-1 s; counted separately per e-mail and per IP, the maximum applies; a successful login resets the e-mail but not the IP; process memory, forget window 900 s | `server/src/auth/login-backoff.service.ts` | A 429 response with `Retry-After` | `authorization-and-authentificaiton.md` lines 65-70: **exists, matches** | `login-backoff.service.spec` 14 (pure, a subclass enables the logic under `NODE_ENV=test`) | UNIT TEST | Security. Scenario S-AUTH-06 does not replace the unit test: on stand B `NODE_ENV` is not `test`, but it is slow and step by step. Doc: login-backoff |
| A-35 | Password policy | Three levels: `any` at least 2 characters; `mid` at least 10 and a digit; `long` (default) at least 14, a digit, a symbol, upper and lower case. An unknown level or empty: `long` | `server/src/auth/utils/password-policy.ts: applyPasswordPolicy` | A `400 weak_password` response on registration, change and reset | `password-requirements.md`: **exists, matches** | `password-policy.spec` 12 (pure) | UNIT TEST | A scenario sees only the stand's one level. Length edges 9/10/13/14. Doc: password-policy |
| A-36 | Startup config validator | Refuses to start with an incomplete environment for the mode (`AUTH_MODE`, secrets, mail, `PASSWORD_POLICY`); an empty `AUTH_MODE` defaults to `password` | `server/src/auth/config/auth-startup-validation.ts: validateAuthStartupConfig` | The server does not start, with a clear message (safe behaviour) | **NO single doc** (modes in `deployment-auth-mode.md`, no list of required variables) | `auth-startup-validation.spec` 21 (pure) | UNIT TEST | Scenario 01: restarting the server is not allowed, so it cannot be checked live. Doc: auth-startup-config |
| A-37 | Request locality | Accepts the address `127.0.0.1`, `::1` and their `::ffff:` forms, plus the single container gateway; proxy headers are ignored | `server/src/auth/utils/localhost.util.ts: isLocalhostRequest` | Mode `none`: password-less login only locally (403 from outside) | `authorization-and-authentificaiton.md` lines 148-170: **exists** | `localhost.util.spec` 6, `auto-identify.guard.spec` 6 (pure) | UNIT TEST | The only protection of mode `none`; a "foreign address" cannot be reproduced from localhost. Doc: local-request-detection |
| A-38 | Detecting the container and the trusted gateway | In layers: marker files, platform variables, cgroup v1/v2, mountinfo; the gateway is only a private IPv4 from `/proc/net/route` | `server/src/auth/utils/container-gateway.util.ts` | Same as A-37 (availability of mode `none` in the image) | `authorization-and-authentificaiton.md` lines 154-181: **exists** | `container-gateway.util.spec` 27 (pure, `FsProbe` injection) | UNIT TEST | cgroup/podman/k8s cannot be reproduced. Reduce 27 to a table of ≈10. Same doc as A-37 |
| ~~A-39~~ | **Dropped:** ~~Release link signature~~ | The release download feature and its signed links were removed by 2026-10-20-github-release-pipeline | — | — | — | — | DROPPED | Doc `release-link-token` deleted |
| A-40 | Azure callback (SSO) | Checks state and nonce, token exchange, redirect to `oauthError` | `server/src/auth/azure/azure-callback.controller.ts` | SSO login | KB partial | `azure-callback.controller.spec` 10 (mocks) | NOT AN ALGORITHM | An OAuth flow on stubs, out of scope without an OIDC stand (question 10 of 13 and question 7 below) |
| A-41 | Cluster worker restarts | A crash within 10 s of uptime is a fast failure: delay 1, 2, 4, 8, 16, 30, 30, 30, 30 s (151 s in total); the 10th in a row stops the slot; after 10 s of uptime the counter resets | `server/src/cluster/worker-slot-registry.ts: onExit` | System Info (restarts, `stopped`), the container is restarted by Docker | `system-info-and-cluster.md` lines 72-80: **exists, matches** (numbers checked against `cluster.constants.ts`) | `worker-slot-registry.spec` 25 (pure, with clock injection) | UNIT TEST | Scenario 04 itself keeps "squeeze to ~6". Doc: worker-restart-policy |
| A-42 | Upload queue statistics and lease | Window arithmetic, load share, moving expired `processing` back to `pending` | `server/src/admin/upload-queue-stats.service.ts`, `upload-queue-scheduler.service.ts` | Admin → Upload queue | KB partial | `upload-queue-stats.service.spec` 11, `upload-queue-scheduler.service.spec` 19 (DB mocks) | NOT AN ALGORITHM | drizzle mocks and call counting (analysis 06 marked it X/DELETE). The live path is S-INGEST-06 |
| A-43 | Request metrics and System Info | Sliding latency windows, sizes, uptime | `system-info/*` | Admin → System Info | `system-info-and-cluster.md` | 12 + 12 (pure, part) | COVERED BY SCENARIO | S-PLAT-03. The formulas are trivial |
| A-44 | Serving precompressed static files | Choosing br, gzip or no compression by `Accept-Encoding`, `Vary`, cache | `common/precompressed-static.ts`, `static-dir.ts` | Speed and correctness of loading the app | `static-asset-serving.md` | `precompressed-static.spec` 26, `static-dir.spec` 13 | COVERED BY SCENARIO | S-PLAT-02 checks br/gzip/identity on a live server |

### 1.6 Hook

| ID | Algorithm | What it computes | Code | Where seen | Docs | Tests now | Verdict | Reason |
|---|---|---|---|---|---|---|---|---|
| A-45 | Guardrail: path inside the project | Converts a tool's path (WSL `/mnt/c/...`, Git Bash `/c/...`, relative) to an absolute one and allows it only inside the project and outside the list of forbidden files; on an error it lets the call through (fail-open) | `hook/.claude/telemetry_tool/guardrail-hook.js: wslToWindows`, `gitBashToWindows`, `resolveAbs`, `isWithinDir`, `extractPath` (**not exported**) | Claude gets a refusal when reading outside the project (safe behaviour) | **NONE** (options in the file header) | `guardrail-hook.test` 6 (pure, by running the script) | UNIT TEST | Security (S-HOOK-05 P0 takes "outside is not allowed, inside is allowed", but not WSL/Git Bash and the edge forms of a path). The functions must be exported, or tested through stdin (question 2). Doc: guardrail-path-check |
| A-46 | Attribution attempt cap in the hook | After 3 consecutive failures on one version of the attribution definitions it skips the evaluation; a retry on the same watermark is not a new failure; changing the definitions resets the streak; a success clears the state | `hook/.../session-attribution-state.js: isBlockedByFailureCap`, `recordFailure`, `recordSuccess` (`MAX_CONSECUTIVE_FAILURES=3`) | Paid LLM calls do not loop (money and safety) | **NONE** (docblock in the code) | `session-attribution-state.test` 13 (pure, state file) | UNIT TEST | Scenario 03 sent this part "to the HOOK group". Reduce 13 to ≈5. Doc: attribution-failure-cap |
| A-47 | OTEL port and merging two levels of config | Local config takes priority over the shared one, port parsing | `hook/.../env-context.js: resolveOtelPort`, `loadConfig`, `shallowMergeConfigs` | Where telemetry is written and the receiver port | `hook-installation.md` | `env-context.test` 36 (pure) | COVERED BY SCENARIO | S-HOOK-06 and S-INST-05; scenario 04 keeps 3 typical errors out of 30 |

### 1.7 Explicitly "not an algorithm"

| ID | What | Where | Tests | Verdict | Reason |
|---|---|---|---|---|---|
| A-48 | Token Flow (layout and graph model) | `client .../charts/token-flow/*` | `token-flow-*.test` ≈119 (pure) | NOT AN ALGORITHM | Hidden behind the `VITE_ENABLE_TOKEN_FLOW` flag, geometry. Its fate is the owner's decision (question 6) |
| A-49 | Formatters and chart geometry | `lib/format.ts` (48), `horizontal-bar-chart` (69), `chart-colors` (14) | ≈131 | NOT AN ALGORITHM | Formatting and pixels; the numbers are checked on screen through scenarios. Scenario 03 allows "a cheap unit test or delete" |
| A-50 | `session-summary-derive`, `session-usage-derive`, other derive files | client | 29 + 38 | COVERED BY SCENARIO | The GS number tables (S-SESS-01, 08) replace them; the exceptions are moved to A-10, A-19, A-20 |

### 1.8 "Docs versus code" discrepancies I see

| # | Doc and place | What it says | What the code does | Severity |
|---|---|---|---|---|
| D1 | `api-reference.md:1574` (`workTimeMs`: "sum of turn_duration durationMs from the claude log"); `db-tables.md:423` ("sum of `turn_duration` events"); `session-log-view.md:137` ("`turn_duration` work time is matched by direct `parentUuid`") | Work time is taken from `turn_duration` events | Server `claude-extractor.ts:1316 computeWorkTime`: the time of the last assistant reply between prompts minus the prompt's time; client `log-parser.ts:1934-1967`: the same, but along the turn's BFS chain. The client mentions `turn_duration` only in Raw Logs (grep over `client/src` and `server/src`). Scenario 03 already records it as "outdated" | High, affects the golden sessions |
| D1b | Server versus client: different methods | The doc treats them as one number | The server takes all assistant replies (without sidechain) between prompts; the client cuts at **any** boundary event (`<task-notification>`, `<command-name>`). **[inference]** a tail of async sub-agents after the last prompt extends the time on the server but not on the client. Scenario 03 expects "does not extend". A check by a run is needed. **Resolved 2026-10-22:** confirmed on a real session (Info 16 s vs ≈ 8 min on the server); the client no longer cuts at `<task-notification>`, only at `<command-name>` — both count from Enter to the final stop (S-SESS-03 step 6a) | Fixed |
| D2 | `token-byte-ratio.md` "Where It Is Used", "The Constant" | The constant is client-only; there are no other rules | There is `resolveCharsPerToken` (a per-model `charsPerToken` from the price list, a column in Admin Model Pricing) and a server copy `HARNESS_CONTENT_BYTES_PER_TOKEN = 3.5` in `claude-extractor.ts:567` | Medium |
| D3 | `llm-call-math.md` §1: `MAX_CONTEXT_TOKENS = 200_000` in `PromptTurnTokenMetrics.tsx:8` | A fixed ceiling | Line 13: `DEFAULT_MAX_CONTEXT_TOKENS`; the real window comes from `pricing[model].contextLength`; the Summary detectors use the model's `contextWindow` | Low |
| D4 | `llm-call-math.md` §1 "Cache-write TTL split": the fallback "when `cache_creation` is absent" | Only the absence of the object | `splitCacheCreationTokens`: the fallback also fires when `cache_creation` exists but its buckets add up to 0 (`write5m + write1h > 0`). If the buckets do not add up to the total, the invariant `5m+1h=cacheWrite` is not guaranteed. **[inference]** | Low |
| D5 | `llm-call-math.md` §2 (the "twin" is only the client) and the list of sites | Two implementations (server and client) | A third: `hook/.../post-turn-analysis-worker.js:1121 computeLocalSessionCost` with its own `FAST_MODE_MULTIPLIER = 2`. The same kind of copies exist for `computeWorkTime`, `classifyToolOutcome`, `countPatchLines`, `splitCacheCreationTokens`, `normaliseFilePath`, `isQualifyingUserEvent` | Medium: a source of future discrepancies |
| D6 | Header of `hook/.../ndjson-sanitize.js` | "Server ingest is all-or-nothing: `parseNdjsonLines()` fails on the first bad line" | The server is now tolerant: `parseNdjsonLinesTolerant`, up to 10% (hooks before 2.15.0). The comment is historical | Low |
| D7 (a code edge case, not a discrepancy) | `guardrail-hook.js:98 isWithinDir` | Inside the project is allowed | The check `rel.startsWith('..')` also rejects a legitimate file `..hidden/x` inside the project. A safe error (it blocks too much). **[inference]** | Low |
| D8 (a code edge case) | `computeChangeSurface`: 6 files in 6 folders | KB: score 8 | `100*score = 7.500000000000004` (by my calculation in node). The result 8 depends on the floating-point tail at the 7.5 edge; with another summation order it could be 7 | Low, but this is exactly the case the test must pin |

### 1.9 Map of "twins" (one rule in several places)

This is the main argument for shared example tables: one table in the doc runs against every copy.

| Rule | Copies |
|---|---|
| Cost | `cost.sql.ts` (SQL and TS), `format.ts`, hook worker |
| Work time | `claude-extractor.ts`, `log-parser.ts` (a different method), hook worker |
| Call outcome | `tool-stats.ts`, `session-usage-derive.ts`, hook worker |
| Edit/Write lines | `tool-stats.ts`, `edit-result-counts.js`, `session-usage-derive.ts` |
| Cache-write split | `claude-extractor.ts`, `log-parser.ts`, hook worker |
| File category | `claude-extractor.ts`, `log-parser.ts`, hook worker |
| Prompt and turn boundaries | `log-parser.ts`, `turn-walk.ts`, `claude-extractor.ts`, hook worker |
| Cache ratio, causes | SQL, server TS, client (`format.ts`, its own cause code) |
| Versions | `server/src/common/semver.ts`, `client/lib/semver.ts`, `otel-register.js` |

---

## 2. Algorithm doc format

### 2.1 Placement

- Directory: `docs/knowledgebase/algorithms/<slug>.md` (one file per algorithm, slug as in the "Doc" column).
- Index: `docs/knowledgebase/algorithms/index.md` (a table of slug, priority, review status) plus a link from
  `docs/knowledgebase/index.md` (project rule: update the index after adding a KB file).
- The test sits next to the code (server jest in `server/src/...`, client vitest in `client/.../__tests__/unit`, hook:
  a hook test) and is named `<slug>.algo.spec.ts` (or `.algo.test.js`). The shared table loader:
  `scripts/algo-docs/load-examples.js` (CommonJS on NodeJS, as CLAUDE.md requires, no python), imported by the three
  runners.
- Doc language: see question 9. The sample in this file was originally written in Russian.

### 2.2 Doc header (no front matter)

No front matter is needed. The doc starts with a heading, then the review line (see 2.3). The link to the code and the test is set in the test itself (it points to the doc's path), not in the doc's metadata. The doc file and its slug: `docs/knowledgebase/algorithms/<slug>.md`.

### 2.3 Required sections (short)

1. **Purpose**: one or two sentences: why the user needs this number or behaviour.
2. **Rules**: a numbered list of steps and formulas with the constant names from the code; good for repeating by hand.
3. **Edge cases**: a list; each one links to an example ID.
4. **Worked examples**: a table (see 2.4) whose rows are the test cases.
5. **Where the result is seen**: screen and field, or an API field, or "safe behaviour: …".

The first line of the doc: `Review: not done` or `Review: <date>, <who> — ok`. Everything else (input and output, what is deliberately not covered) is added to the doc only if it is unclear without it.

### 2.4 The examples table and how the test reads it (so they do not drift)

The columns are strictly: `ID | Input | Expected | Independent derivation`.

- **Input** and **Expected**: JSON in a `` ` `` block; a `|` inside is escaped as `\|`.
- **Expected** is matched as a subset: the listed keys must match (numbers are compared with a tolerance if the doc
  sets `tol` in the row).
- **Independent derivation**: text in which the number is obtained by hand from the rules in section 3, **not** by
  running the code. This is a review requirement (checklist item 2).

The test holds no numbers of its own:

```ts
// <slug>.algo.spec.ts
import {loadExamples} from '../../../scripts/algo-docs/load-examples';

const rows = loadExamples('docs/knowledgebase/algorithms/<slug>.md', 'Worked examples');
it('the doc has examples', () => expect(rows.length).toBeGreaterThan(0));
it.each(rows)('$id', (row) => {
    expect(run(row.input)).toMatchObject(row.expected); // run() turns the input into a call of the real function
});
```

Protection against drift:

1. The numbers live only in the doc; changing the code breaks the test, changing the table changes the test.
2. The loader fails if the table is missing, IDs repeat, the JSON is broken or a row has no "Independent derivation".
3. A meta-test walks `docs/knowledgebase/algorithms/*.md` and requires every doc to be referenced by at least one
   `*.algo.spec.*` (and the other way round).
4. If the algorithm has copies elsewhere (for example, in the hook), each copy's test reads the same table with the same loader; the doc lists the copies' files in one line.

---

## 3. One complete sample: `change-surface-concentration.md`

Chosen as the most valuable one: the rule is complex (4 components, 2 levels of softening), 5 places in the UI read it,
and the scenario explicitly hands the formula to a unit test. The full text of the doc follows. I obtained every number
in the table by re-implementing the formula separately in node from the code I read (without running the repository's
code). **Before acceptance, run the real code on every row**; a difference means an error in either the doc or the
code, and the review resolves it.

````markdown

# Concentration: how focused an edit is

## Purpose

One 0..100 number answers the question "how closely do the files the session changed sit together". 100 means all the
files are in one folder; low values mean a spread over independent folders and modules (many merge conflicts). The
number is shown by the Change surface tab, the Summary tile, the Analytics chart and the report; all of them take it
from one function.

## Input and output

Input: a list of `ChangedPathFact` facts: one row per logical path per session (the path is already normalized, see
doc change-surface-paths-and-kinds). Rows with `outsideRepo` or without `relPathKey` do not take part in the spread
calculation. Output (key fields of `ChangeSurfaceAggregate`): `changedFiles`, `foldersTouched`, `concentration` (an
integer 0..100 or `null`), `band` (`focused`, `mixed`, `scattered` or `null`), `filesPerFolder`, `largestFolderShare`,
`folderEntropyNorm`, `meanPathDistanceHops`, `commonAncestorDepth`, `topLevelModules`, `linesAdded`, `linesRemoved`,
`outsideRepoFiles`, `byChangeKind`.
`null`, not 0, means "nothing changed in the repository": 0 would read as "as scattered as possible".

## Rules step by step

1. Merge the facts by `relPathKey` (the case-insensitive path). A file counts once, even if several sessions edited it.
   Lines (+/-) are summed. `added` wins: if a file was created inside the scope, it is `added` whatever happened to it
   later; `deleted` beats `modified`, but not `added`.
2. Let F be the number of files, K the number of distinct folders, n_i the files in folder i, T the number of distinct
   top-level modules (the first segment of the folder path; a file in the root is the module ".").
3. If F = 0: `concentration = null`, `band = null`, all spread indicators `null`. Done.
4. Compute the components (all from 0 to 1, the higher the more focused):
    - E from folder entropy, S the share of the largest folder, M module focus, D folder proximity (formulas below).
5. Small-edit softening, level 2 (blend): if F ≤ 6, E and S are pulled towards 1 in proportion to the "smallness" and
   the folder proximity.
6. Score: the weighted sum, times 100, rounded to the nearest integer (half up), clamped to 0..100.
7. Small-edit softening, level 1 (floor): if 1 ≤ F ≤ 5, the result is at least 60.
8. Band by the result: 60 and above `focused`, 40..59 `mixed`, below 40 `scattered`.
9. The displayed tiles are computed from the **raw** values, not the softened ones (see "Formulas").

## Formulas

Notation: `d(f)` the number of segments of folder f's path (the root "." has depth 0), `c(u,v)` the length of the
common prefix of two folders.

- `H = −Σ (n_i/F)·ln(n_i/F)`; `folderEntropyNorm = H / ln K` (shown as 0 when K = 1).
- `E = 1 − folderEntropyNorm`; when K = 1, E = 1 by definition.
- `S = max(n_i) / F`.
- `M = 1 / T`.
- Distance of a folder pair: `sep(u,v) = ((d(u) − c) + (d(v) − c)) / (d(u) + d(v))` (0 if both are the root);
  `D = 1 − mean sep` over all pairs; when K < 2, `D = 1`. Dividing by `d(u)+d(v)` matters: `a/b/c` and `a/b/d` are
  closer to each other (0.333) than `a` and `z` (1.0), although both cases are 2 hops.
- Blend (F ≤ 6): `smallness = 1 − (F − 1)/6`; `closeness = smallness · D`; `E' = E + closeness·(1 − E)`;
  `S' = S + closeness·(1 − S)`. When F > 6: `E' = E`, `S' = S`.
- `score = 0.40·E' + 0.25·S' + 0.20·M + 0.15·D`.
- `concentration = clamp(round(100·score), 0, 100)`, then when `1 ≤ F ≤ 5`: `max(concentration, 60)`.
- Displayed: `filesPerFolder = F/K`; `largestFolderShare = S` (**without** the blend); `folderEntropyNorm` raw;
  `meanPathDistanceHops` = the mean of `(d(u)−c)+(d(v)−c)` to one decimal; `commonAncestorDepth` the length of the
  common prefix of all folders. Constants: weights `0.40/0.25/0.20/0.15`, `SMALL_CHANGE_MAX_FILES = 6`,
  `FOCUSED_SMALL_CHANGE_MAX_FILES = 5`, edges `60` and `40` (code: `change-surface-metrics.ts`).

## Edge cases

- No file in the repository: CS-13.
- One folder at any F: CS-01, CS-02 (when F > 6 it is exactly the rule "E = 1 when K = 1" that holds 100).
- A small edit with distant folders: the floor of 60 (CS-04, CS-05) versus no floor at F = 6 (CS-06).
- The blend edge F = 6 / F = 7: CS-07, CS-08.
- The band edge: CS-10.
- One file in two sessions, path case: CS-11.
- A file outside the repository: CS-12.
- Rounding at the .5 edge: CS-06 (the exact value of `100·score` is around 7.5, see owner question 11).

## Worked examples

Input format: `{"folders": {"folder": file_count}}` (the test creates the files `f1.ts, f2.ts, ...` in the folders; the
repository root is known) or `{"facts": [...]}` for rows with sessions; `{"band": N}` checks `concentrationBand`.

| ID | Input | Expected | Independent derivation |
|---|---|---|---|
| CS-01 | `{"folders":{"src/api":1}}` | `{"changedFiles":1,"foldersTouched":1,"concentration":100,"band":"focused"}` | K=1: E=S=M=D=1, score=1 |
| CS-02 | `{"folders":{"src/api":8}}` | `{"concentration":100,"band":"focused","filesPerFolder":8}` | F=8, no blend; K=1 gives E=1 by definition; score=0.40+0.25+0.20+0.15=1. If E were taken as 0 at K=1, the result would be 0.60 |
| CS-03 | `{"folders":{"a/b/c":1,"a/b/d":1}}` | `{"concentration":72,"band":"focused","largestFolderShare":0.5,"folderEntropyNorm":1,"meanPathDistanceHops":2,"commonAncestorDepth":2}` | E=0 (two equal folders, H=ln2), S=0.5, T=1 M=1; sep=2/6, D=0.666667; F=2: smallness=0.833333, closeness=0.555556; E'=0.555556, S'=0.777778; score=0.222222+0.194444+0.2+0.1=0.716667, result 72. The displayed `largestFolderShare` is 0.5, not 0.777778 |
| CS-04 | `{"folders":{"a/x":1,"z/y":1}}` | `{"concentration":60,"band":"focused"}` | E=0, S=0.5, T=2 M=0.5, sep=4/4=1, D=0, closeness=0; score=0.125+0.1=0.225, result 23, but F=2 ≤ 5, floor 60 |
| CS-05 | `{"folders":{"a":1,"b":1,"c":1,"d":1,"e":1}}` | `{"concentration":60,"band":"focused"}` | E=0, S=0.2, M=0.2, D=0; score=0.05+0.04=0.09, result 9, floor 60 |
| CS-06 | `{"folders":{"a":1,"b":1,"c":1,"d":1,"e":1,"f":1}}` | `{"concentration":8,"band":"scattered"}` | F=6: the floor does not apply. E=0, S=M=1/6, D=0 (closeness 0); score=0.25/6+0.2/6=0.075, result round(7.5)=8 (half up) |
| CS-07 | `{"folders":{"src/api":3,"src/web":3}}` | `{"concentration":44,"band":"mixed"}` | E=0, S=0.5, M=1, sep=2/4, D=0.5; F=6: smallness=1/6, closeness=0.083333; E'=0.083333, S'=0.541667; score=0.033333+0.135417+0.2+0.075=0.44375 |
| CS-08 | `{"folders":{"src/api":5,"src/web":2}}` | `{"concentration":51,"band":"mixed"}` | F=7: no blend. p=5/7, 2/7, H=0.598269, norm=0.863121, E=0.136879; S=0.714286; M=1; D=0.5; score=0.054752+0.178571+0.2+0.075=0.508323 |
| CS-09 | `{"folders":{"src/api":4,"src/web":3,"docs":1}}` | `{"concentration":30,"band":"scattered","filesPerFolder":2.666667,"largestFolderShare":0.5,"folderEntropyNorm":0.88686,"meanPathDistanceHops":2.7,"commonAncestorDepth":0,"topLevelModules":["docs","src"]}` | F=8, K=3, T=2. H=0.974334, ln3=1.098612, norm=0.88686, E=0.11314; S=0.5; M=0.5; pairs: api-web 2/4=0.5, api-docs 3/3=1, web-docs 1; D=1-0.833333=0.166667; score=0.045256+0.125+0.1+0.025=0.295256; hops (2+3+3)/3=2.667 to 2.7 |
| CS-10 | `{"band":60}`; `{"band":59}`; `{"band":40}`; `{"band":39}`; `{"band":null}` | `focused`; `mixed`; `mixed`; `scattered`; `null` | Rule 8 (five separate rows CS-10a..e in the real file) |
| CS-11 | `{"facts":[{"session":"s1","path":"src/api/a.ts","added":10,"removed":0,"kind":"modified"},{"session":"s2","path":"Src/Api/A.ts","added":5,"removed":2,"kind":"added"}]}` | `{"changedFiles":1,"foldersTouched":1,"linesAdded":15,"linesRemoved":2,"byChangeKind":{"added":1,"modified":0,"deleted":0},"concentration":100}` | The path key is case-insensitive: one file; lines 10+5 and 0+2; `added` wins; K=1 gives 100. A sum instead of a union would give changedFiles=2 |
| CS-12 | `{"folders":{"src/api":3},"outside":[{"path":"~/.claude/settings.json","added":5}]}` | `{"changedFiles":3,"outsideRepoFiles":1,"outsideRepoLinesAdded":5,"concentration":100}` | A file outside the repository is in neither F nor K; it does not enter the spread; it is counted separately |
| CS-13 | `{"folders":{}}` | `{"changedFiles":0,"concentration":null,"band":null,"filesPerFolder":null}` | Rule 3 |

## Where the result is seen

- Session → Change surface tab: headline (Changed files, Folders touched, Concentration, Lines +/-, Top-level
  modules, Common ancestor), spread cards, the file tree.
- Session → Summary: the Code impact tile and "Detected issues" (the detectors look at `band`, see doc
  summary-detectors).
- Analytics (the Change Surface chart) and the Change Surface report: the same numbers for a period.
- API: `GET /api/v1/repositories/:repoId/sessions/:sid/change-surface` (fields above).

Review: not done.

````

---

## 4. Review process ("a separate review that the unit tests make sense")

### 4.1 Checklists

**A person and an AI check against the same items. Each item has a yes/no answer and a link to a row or ID.**

1. **Readability.** Can the rules (section 3 of the doc) be read and repeated on paper in 10 minutes without reading
   the code? If not, the algorithm is not suitable for unit tests (return the verdict "covered by scenario" or
   simplify the doc).
2. **Independent derivation.** For every row, does the "Independent derivation" column hold a calculation from the
   rules, not "this is what the code returned"? The reviewer **covers the "Expected" column**, computes it alone and
   compares. Any row where a derivation is impossible without running the code is removed or replaced.
3. **Mutations.** Section 8 holds 3-6 plausible bugs. For each one: name the row that will fail; the reviewer invents
   2 more mutants and checks that some row kills them. A mutant without a killer is a hole: add an example.
4. **Edges.** Every threshold and every `<`, `<=`, `>`, `>=` condition in the code has a pair of examples on both sides
   (the value at the edge and next to it). Every `null` versus `0`, empty input, a string from the DB versus a number.
5. **Doc equals code.** Every rule from section 3 is found in the code (file:line), every constant matches. A
   discrepancy is recorded as a defect of the doc or the code, not silently adjusted.
6. **Seen by the user.** Section 7 names the screen and field (or "safe behaviour"). If the result is not seen
   anywhere, the algorithm does not need unit tests.
7. **Does not duplicate a scenario.** Check against the scenario table (`13-new-test-suite.md`): a row either checks an
   edge that no scenario touches, or it is excluded.
8. **Twins.** Do all the copies from `twins` call the same table? If a copy differs, it is a D-type finding.
9. **Size.** The table does not grow "just in case": every row kills at least one mutant (the "Kills" column is not
   empty, except for rows explicitly marked "regression for a bug" with a link).

### 4.2 Ready-made reviewer prompt (for an AI)

The prompt below is the original design. The live prompt is `scripts/algo-docs/review-prompt.md`, which asks for English.

```
You are an independent reviewer of an algorithm doc and its unit tests. You are NOT the author.
Do not run or change anything. Write in Russian. Do not trust the "Expected" column.

Input: the path to the doc docs/knowledgebase/algorithms/<slug>.md and the code and test files named in it.

Steps:
1. Read ONLY the doc's "Purpose", "Input and output", "Rules step by step" and "Formulas" sections. Do not read the examples table.
2. For every example row read ONLY the "Input" column. Compute the result yourself from the rules, showing the arithmetic.
   Then compare with the "Expected" column. Mark any difference in a number, null/0 or an edge as DISCREPANCY, with both figures.
3. Read the code from `code`. For every rule of the doc find file:line. For every condition and constant in the code that is not in the doc, mark MISSING FROM DOC.
   For every constant with a different value, mark DOC≠CODE.
4. Mutations: take the "Mutations" section. For every mutation name the row that kills it and explain with arithmetic why the result changes.
   Invent at least 3 more plausible wrong implementations (off-by-one, swapped conditions, rounding, null versus 0, rule order, a skipped twin).
   For each one find the killing row or mark HOLE.
5. Edges: list every threshold and comparison in the code. For each one check a pair of examples on both sides. Mark the missing ones HOLE.
6. Check: the result is seen by the user (the "Where the result is seen" section names a real screen or field), the algorithm is readable by a person (can it be reproduced on paper), it does not duplicate a scenario (compare with docs/qaa-overview/13-new-test-suite.md).
7. Check that the test reads the table through load-examples and holds no numbers of its own; the twins from `twins` use the same table.

Output (strictly):
VERDICT: reviewed | needs-changes
DISCREPANCIES: [list of row IDs with your figures]
HOLES: [mutants and edges without a killer]
DOC≠CODE: [list with file:line]
MISSING FROM DOC: [list]
READABILITY: yes/no + one sentence
VISIBILITY: yes/no + screen/field
SCENARIO DUPLICATE: [S-xxx or none]
REVIEW LINE FOR THE DOC: `Review: <date>, ai — ok` or what to fix
```

Rule: the AI review is done by a model and a session that did not write the doc (otherwise the reviewer repeats the
author's mistakes). It is a separate run, not part of the implementation task.

### 4.3 How the review is recorded (simply)

- One line at the start of the doc: `Review: <date>, <who> — ok` (or `not done`). No hashes, commits or lists of mutants.
- When to repeat: when the algorithm's rule or formula changes. The test itself catches a doc/code discrepancy: it reads the numbers from the doc, so changing the code without changing the doc (or the other way round) breaks it.
- Who: a person looks only at the short list "what is computed here and by which rules" plus the examples table; the AI reviewer checks the rest using the prompt above (independent derivation of the examples, edge values, discrepancy with the code).
- There is no automation (no hash-checking scripts, summary tables or release blocking). The only automation needed is the shared examples-table loader for the tests.

---

## 5. Totals

### 5.1 How many in total

- Candidates: **50** (A-39 dropped since, so 49 remain); **34** stay as unit tests; 11 are covered by a scenario; 4 are not an algorithm.
- Algorithm docs: **29** (P0 12, P1 15, P2 2).
- Doc status: already exists and matches the code **9** (cost-formula, cache-ratio-and-causes,
  change-surface-concentration, change-surface-paths-and-kinds, login-backoff, password-policy, local-request-detection,
  worker-restart-policy, harness-usage-tree; the last one was not checked line by line); exists but
  differs **2** (work-time, byte-token-estimates); partial **3** (otel-cost-selection, token-usage-dedupe,
  prompt-turn-qualification); missing entirely **15** (derived-productivity, summary-detectors, semver-compare,
  tool-outcome, tool-line-and-commit-counters, tool-duration-percentiles, file-category, workflow-notification,
  repo-url-normalization, attribute-filter, ndjson-tolerance, upload-chunk-planning, auth-startup-config,
  guardrail-path-check, attribution-failure-cap). Even the "exists" ones must be rewritten into the single format (add
  examples and mutations).

### 5.2 How many tests

Counting unit: one table row is one test (`it.each`). Estimated rows per doc (my plan, not a measurement):

| Priority | Docs | Rows (tests) | Files |
|---|---|---|---|
| P0 (money, security, data loss) | cost-formula 10, otel-cost-selection 6, login-backoff 6, password-policy 8, auth-startup-config 8, local-request-detection 10, guardrail-path-check 10, ndjson-tolerance 8, repo-url-normalization 12, change-surface-concentration 12 (15 rows in the sample with CS-10a..e), cache-ratio-and-causes 10, work-time 6 | ≈106 | 12 |
| P1 | change-surface-paths-and-kinds 14, summary-detectors 14, semver-compare 8, tool-outcome 7, tool-line-and-commit-counters 8, prompt-turn-qualification 10, token-usage-dedupe 6, derived-productivity 6, harness-usage-tree 6, worker-restart-policy 6, upload-chunk-planning 5, attribute-filter 8, file-category 6, byte-token-estimates 4, attribution-failure-cap 5 | ≈123 | 15 |
| P2 | tool-duration-percentiles 5, workflow-notification 3 | ≈8 | 2 |
| Total | 29 docs | **≈236 rows in 29 files** | |

Comparison with the owner's estimate (`13-new-test-suite.md`): there it is "about 100 for authorization and ~25 for the
hook, that is ~125, packed into ~10 files". My estimate is wider because, on top of authorization and the hook, it adds
session numbers (money, change surface, detectors) that the scenario design handed to the golden sessions, but which
lose the formula edges there. **Options:**

- **Minimum (P0 only): ≈110 tests in 13 files**, right within the target ~125. Total suite size: 148 scenario tests +
  ≈110 = **≈258** (it was ≈4260, that is minus ≈94%).
- **P0+P1 (≈233 tests, 28 files):** ≈148 + ≈233 = **≈380** (minus ≈91%).
- The owner's old estimate: ≈148 + ≈125 = ≈273. A hard limit of 200 in total is unreachable: P0 alone (≈258) exceeds
  it; to fit, the scenarios or part of P0 must be cut (the owner's decision).

Effort: the project has no estimates; **[inference]** about 0.5-1 day per doc with review, that is 15-30 person-days
for the whole set, 7-12 for P0 (rough, not verified).

### 5.3 Writing priorities

**P0 (security, money, data loss), in this order:**

1. cost-formula (A-01, A-03) and otel-cost-selection (A-02): money, three copies, a ready evidence base.
2. login-backoff (A-34), password-policy (A-35), auth-startup-config (A-36), local-request-detection (A-37, A-38):
   security, the scenarios have no replacement, the existing tests are pure and only need repackaging.
3. guardrail-path-check (A-45): hook security, **no doc and the functions are not exported** (question 2).
4. ndjson-tolerance (A-30) and repo-url-normalization (A-28): data loss and duplicate repositories.
5. change-surface-concentration (A-14): the sample is ready (section 3).
6. cache-ratio-and-causes (A-05, A-06).
7. work-time (A-07): first the owner's decision (question 1), otherwise the doc will pin the wrong behaviour.

**P1:** change-surface-paths-and-kinds, summary-detectors, semver-compare, tool-outcome, tool-line-and-commit-counters,
prompt-turn-qualification, token-usage-dedupe, derived-productivity, harness-usage-tree, worker-restart-policy,
upload-chunk-planning, attribute-filter, file-category, byte-token-estimates, attribution-failure-cap.

**P2:** tool-duration-percentiles, workflow-notification.

As a first step, before writing the docs, fix the discrepancies D1-D5 (otherwise the new docs will link to wrong KB
articles).

---

## 6. Questions for the owner

1. **Work time (D1, D1b):** what is the truth: the code (last reply minus prompt) or the KB (`turn_duration`)? Should
   the server and the client give one number with a tail of async sub-agents? Until this is decided, the work-time doc
   (P0) cannot be written.
2. **Guardrail:** may the functions `resolveAbs`/`isWithinDir`/`wslToWindows`/`gitBashToWindows` be exported from
   `guardrail-hook.js` (a hook change, which by the CLAUDE.md rule is made in `hook/` and propagated), or should they be
   tested only by running the script with stdin (6 tests already do this)? Also: should the false positive on
   `..hidden/x` (D7) be fixed?
3. **Twins (D5):** keep shared tables for all copies, or remove the copies from the hook (for example, the hook does
   not compute the cost but takes it from the server)? The hook needs a shared loader in plain node.
4. **Counting unit:** count a table row as a test (≈240) or one `it` per doc (30)? It affects the "how many tests are
   left" figure.
5. **Scope:** take P0 (≈110) or P0+P1 (≈233)? Is a hard limit of 200 in total needed?
6. **Token Flow (A-48, ≈119 tests):** delete it together with the flag, keep it as is, or postpone?
7. **Azure callback (A-40, 10 tests with mocks):** keep, delete, or build a stand with a fake OIDC (question 10 of
   `13-new-test-suite.md`)?
8. **Who reviews:** a person, an AI, or both (for P0 I propose both); does `stale` block a release (P0) or only warn?
9. **Doc language:** the whole KB is in English, but this file and the scenarios were written in Russian. Which
   language should `algorithms/*.md` be written in?
10. **Placement:** `docs/knowledgebase/algorithms/` (next to the KB, visible to skills and the index) or
    `docs/algorithms/`? Tests next to the code or in one directory `tests/algorithms/`? May the shared loader
    `scripts/algo-docs/` be added (the runners are currently jest, vitest and node for the hook)?
11. **Floating point (D8):** pin `concentration = 8` for 6 files in 6 folders (the 7.5 edge holds on the `…04` tail)
    or add an epsilon in the code so that the behaviour does not depend on the summation order?
12. **Token estimates (A-11, A-12):** are tests on approximate numbers (3.5 bytes, images, 150 tokens per MCP
    definition) needed at all, or is a scenario enough? I kept A-11 as four rows.
13. **Should the discrepancies D1-D6 be fixed before writing the docs** (I recommend yes), and who fixes them (KB or
    code)?
14. **A-17 detectors:** the thresholds (0.8, 0.3, 0.7, 10, 5, 4, 0.5) are product decisions. Should they be pinned in
    the doc as "fixed", so that a threshold change must go through review?
