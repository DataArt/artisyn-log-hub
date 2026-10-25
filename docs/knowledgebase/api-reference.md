---
type: "API Reference"
title: "API Specification"
description: "Reference for all REST endpoints, auth flows, TypeScript types, error codes, and access control rules."
tags:
  - api
  - rest
  - auth
timestamp: "2026-07-20T22:24:25+04:00"
---

# API Specification

Base URL: `/api/v1`

## Security headers

All responses (API, SPA, static files) carry:

- `Content-Security-Policy` — same-origin policy (`frame-ancestors 'none'`; `'unsafe-inline'` allowed for styles only)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`

Set by `server/src/common/security-headers.ts`, registered in `AppModule.configure` before the session/passport/body-parser middleware (so headers are still attached if those short-circuit the request) — it is the third `consumer.apply()` call, after `RequestMetricsMiddleware` and the request-context-storage middleware. `upgrade-insecure-requests` is intentionally omitted to support plain-HTTP internal deployments.

## Shared types

```ts
type LogBlockType = 'claude' | 'artisyn';
// claude  — log lines produced by Claude Code telemetry
// artisyn — log lines produced by Artisyn

type UserRole = 'admin' | 'user';

interface UserProfile {
  id: number;
  email: string;
  role: UserRole;
  created_at: string; // ISO 8601
  env_name: string;    // ConfigService ENV_NAME, defaults to 'local'; shown in client nav bar when non-default
}

type TeamAccessMode = 'transparent' | 'restricted';

interface Team {
  id: number;
  name: string;
  ownerId: number;
  createdAt: string; // ISO 8601
  accessMode: TeamAccessMode; // (0063) replaces the removed allowMemberSessionVisibility boolean.
                              // 'restricted' is the default for every creation path, including
                              // auto-created import teams.
  myIsManager: boolean;       // the CALLER's own role flags on this team, denormalised onto the
  myIsAdlcTrainer: boolean;   // team row so the client can gate its UI without a second
                              // GET :teamId/members round-trip. Meaningful only when
                              // accessMode === 'restricted' — a transparent team ignores roles.
}

interface TeamMember {
  userId: number;
  email: string;
  canInvite: boolean;
  isManager: boolean;      // full-team analytics/reports + every member's sessions, prompts masked
  isAdlcTrainer: boolean;  // every member's sessions WITH prompts, but no analytics/reports
                           // The two stack; both are ignored while accessMode is 'transparent'.
  disclosureAcknowledgedAt: string | null; // ISO 8601, or null when the member has not yet
                           // acknowledged the access-mode disclosure. Returned verbatim ONLY to the
                           // team owner — null for every other caller, so one
                           // member cannot read another's acknowledgement state.
  joinedAt: string; // ISO 8601
  isOwner: boolean;
}

interface TeamRepository {
  id: number;
  teamId: number;
  repoUrl: string;
  addedAt: string;       // ISO 8601
  repositoryId: number | null; // null when no sessions have been uploaded for this URL
  sessionCount: number;  // 0 for repos with no uploads; orange-highlighted in UI
}

interface UserRepository {
  id: number;
  repoUrl: string;
}

interface RepositorySession {
  sessionId: string;
  firstPrompt: string | null; // null ONLY means "masked": a `manager` in a restricted team sees
                              // other members' rows with the prompt stripped in the projection.
                              // Sessions without a first prompt are excluded from the listing
                              // entirely, so null can never mean "absent".
  startTime: string;    // ISO 8601
  endTime: string;      // ISO 8601
  gitBranch?: string;   // pre-computed on ingest; stored on logs table
  userEmail?: string;   // email of the user who submitted the log
  totalCost?: number | null; // OTEL-reported cost when present for this root session, else the token×price estimate; null/absent if neither is available
  computedCost?: number | null; // always the token×price estimate, independent of totalCost's OTEL preference; only present to size hasCostDiscrepancy
  hasCostDiscrepancy?: boolean; // true when both an OTEL cost and a computed cost exist and differ by 33%+ relative — drives the session header's warning icon
  costUnavailableReason: 'unknown-model' | null; // 'unknown-model' iff the session reports a
                        // model with no model_pricing row match on REGEXP_REPLACE(model, '-[0-9]{8}$', ''),
                        // i.e. a -YYYYMMDD-suffixed id still prices normally. null otherwise, including
                        // "no stats yet" (where totalCost is already null). Derived from the same
                        // p.model_id IS NULL predicate that produced the cost, so the two can never
                        // contradict. Drives NoPricingBadge in the session list, the session detail
                        // header and the session log view — all three read THIS row, so there is no
                        // separate session-detail cost endpoint.
  isFavorite?: boolean; // true when the authenticated user has favorited this session
  userId: number | null; // numeric id of the user who owns the session (the artisyn log uploader); null if unknown
  isHookService: boolean; // true when the artisyn log body contains a hook_service event
  hasWorkflow: boolean;   // true when the claude log body contains a Workflow tool_use (fast LIKE scan)
  claudeVersion: string | null; // (2026-09-23) COALESCE(session_stats.claude_version, claude_version_otel):
                        // highest Claude Code CLI version on the transcript lines, else the highest
                        // OTEL resource service.version; null when neither is known (no backfill for
                        // sessions ingested earlier). Only GET .../sessions carries it. Client twin is
                        // OPTIONAL (claudeVersion?: string | null in client/src/models/repositories.ts).
}

interface Invitation {
  id: number;
  teamId: number;
  inviterId: number;
  inviteeId: number;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  createdAt: string; // ISO 8601
  accessMode: TeamAccessMode; // the team's live mode, joined in so the invitee can be shown the
                              // pre-accept disclosure without being able to read the team yet
  hasTrainer: boolean;        // true when at least one member of that team holds the ADLC trainer
                              // role — the disclosure names that as a distinct reader
}

interface FileCategory {
  name: string;       // category identifier, e.g. "code", "docs", "knowledgebase"
  patterns: string[]; // JavaScript regexp strings matched against repo-root-relative paths (forward slashes)
}

interface RepoConfig {
  fileCategories: FileCategory[];
  // Per-turn cache-creation token count at or above which a turn is attributed to a
  // cause (compaction / file re-read) in session_cause_stats. Optional: absent means the
  // server constant DEFAULT_HIGH_CACHE_CREATION_THRESHOLD (25_000). Both teamConfig and
  // userConfig may carry it independently. Must be an integer within
  // CACHE_CREATION_THRESHOLD_MIN (1_000) … CACHE_CREATION_THRESHOLD_MAX (10_000_000).
  highCacheCreationThreshold?: number;
}

interface RepoSettingsResponse {
  effectiveConfig: RepoConfig; // config applied to queries — resolution order is user-scoped row → team-scoped row → built-in default (a personal override wins over the team config)
  teamConfig: RepoConfig | null; // team-scoped override; null if none set
  userConfig: RepoConfig | null; // personal override; null if none set
  teamId: number | null;         // team that owns the effective team config; null when no team config exists
  canEditTeamConfig: boolean;    // true when the caller is allowed to save/clear the team config
}
```

---

## Auth

Behavior below depends on the active `AUTH_MODE` (`none` | `password` | `password-confirm` |
`azure-oauth` — see `authorization-and-authentificaiton.md`). Routes not listed as active for the
current mode return `404` (not 403). `PASSWORD_POLICY` (`any`/`mid`/`long`) controls password
strength for `signup`/`reset-password`/`change-password` under Mode 2/3.

```ts
// GET /api/v1/auth/config — 200, always active, unauthenticated
response: {
  mode: 'none' | 'password' | 'password-confirm' | 'azure-oauth';
  azure?: { authority: string; clientId: string; redirectUri: string }; // only when mode === 'azure-oauth'
  adminContactEmail?: string; // only when mode is 'password' | 'password-confirm'
}
// Never includes a secret field. Used by the login page to pick which UI to render, before mounting any form.

// POST /api/v1/auth/identify — 200, Mode 1 (none) only
// No password, ever. Rejects 403 unless the request originates from a local caller — 127.0.0.1/::1
// via req.socket.remoteAddress (never X-Forwarded-For), plus the container's own private default
// gateway when running containerized (see authorization-and-authentificaiton.md).
// Auto-provisions the account on first sight;
// logs into an existing account (with or without a password already set) on a known email.
body: { email: string }
response: UserProfile

// POST /api/v1/auth/signup — 201, Mode 2/3 (password | password-confirm) only
// First user to sign up receives role='admin'; subsequent users receive role='user'.
// Under Mode 3, also issues a 24h confirmation token and sends the confirmation email.
body: { email: string; password: string; passwordConfirm: string }
response: UserProfile & { email_delivery?: 'sent' | 'failed' } // email_delivery present under Mode 3 only
// Errors: 400 { error: 'password_mismatch' | 'weak_password' }, 409 email already registered

// POST /api/v1/auth/login — 200, Mode 2/3 only
body: { email: string; password: string }
response: UserProfile
// Errors: 401 bad credentials, 400 already authenticated,
//   403 { error: 'email_not_confirmed' } (Mode 3, valid credentials but unconfirmed account),
//   429 progressive brute-force delay — Retry-After header + { retryAfterSeconds } in the
//     body. Tracked per lowercased email AND per source IP; the applied delay is max(account, ip).
//     1st failure is free, then 1s / 2s / 3s … A correct password clears the *account* counter
//     (even when the request then 403s on email_not_confirmed); the IP counter is never cleared by
//     a success. In-memory, per process, disabled under NODE_ENV=test.

// POST /api/v1/auth/logout — 204
// Requires: session cookie. Active in every mode.
// Errors: 401 not authenticated

// GET /api/v1/auth/me — 200
// Requires: session cookie. Active in every mode.
// Mode 1 (none) exception: if there is no valid session, an unauthenticated local request (same
// address rule as identify above) is
// silently auto-logged-in first (AutoIdentifyGuard/AuthService.autoIdentifyMode1) — single user in
// `users` -> that user, more than one -> id=1, zero users -> falls through to 401 as before. Every
// other mode is unaffected.
response: UserProfile
// Errors: 401 not authenticated

// GET /api/v1/ping — 204
// Keep-alive probe; renews the session expiry on the server.
// Requires: session cookie
// Errors: 401 not authenticated

// POST /api/v1/auth/confirm-email — 200, Mode 3 only
// Atomic consume — two concurrent calls with the same token resolve to exactly one 200 and one 409.
body: { token: string }
response: UserProfile
// Errors: 400 invalid/unknown token, 410 expired, 409 already confirmed

// POST /api/v1/auth/resend-confirmation — 200, Mode 3 only
// Always 200, whether or not the email exists or is already confirmed (no enumeration) — no email
// actually sent in either of those cases. 60s per-account cooldown shared with the Admin Panel's
// own "Resend" action.
body: { email: string }
response: { email_delivery: 'sent' | 'failed' }
// Errors: 429 (Retry-After header set to the remaining cooldown seconds)

// POST /api/v1/auth/forgot-password — 200, Mode 2/3 only
// Always 200 whether or not the email is registered (no enumeration); not gated on the account
// having a password already (works for OAuth-only accounts too, for the Mode 4 → 2/3 switch-back
// scenario). Same 60s cooldown mechanism as resend-confirmation.
body: { email: string }
response: { email_delivery: 'sent' | 'failed' }
// Errors: 429 (Retry-After header)

// POST /api/v1/auth/reset-password — 200, Mode 2/3 only
// Atomic consume of a 1h reset token; sets/replaces the account's password_hash.
body: { token: string; password: string; passwordConfirm: string }
response: UserProfile
// Errors: 400 invalid/unknown token OR { error: 'password_mismatch' | 'weak_password' } (distinct
//   400s — the latter only once the token itself was valid), 410 expired, 409 already used

// POST /api/v1/auth/change-password — 200, Mode 2/3 only
// Requires: session cookie. Self-service change for an already-authenticated user.
// On success every OTHER session/device for this user is signed out (their auth_sessions rows are
// deleted); the session that made the request survives. The "your password was changed"
// notification is best-effort and never fails the change.
body: { currentPassword: string; password: string; passwordConfirm: string }
response: UserProfile & { email_delivery: 'sent' | 'failed' | 'skipped' }
//   'skipped' = no SMTP_HOST configured, so nothing was even attempted.
// Errors: 403 { error: 'invalid_current_password' } — deliberately 403, NOT 401: the client's
//   apiFetch() force-navigates to the login page on any 401, which would eject the user from the
//   dialog mid-change (so this call uses bare fetch + readApiError, not apiFetch);
//   400 { error: 'password_mismatch' | 'weak_password' | 'no_local_password' }
//   ('no_local_password' = an account provisioned without a password, i.e. Mode 1/4),
//   401 not authenticated

// POST /api/v1/auth/delete-account — 204, every mode
// Requires: session cookie. Hard-deletes the caller's account and everything it owns — repositories,
// logs, logs_otel, now-orphaned sessions, owned teams (with their members/team repos/invitations),
// invitations they sent or received, API keys, queued uploads, favourites and per-repo config.
// Irreversible; there is no soft-delete. Destroys the session and clears the connect.sid cookie.
body: { confirm: 'delete' } // exact string, re-validated server-side
// Errors: 400 confirm !== 'delete', 400 'Cannot delete the last admin', 401 not authenticated

// GET /api/v1/auth/azure — 302, Mode 4 (azure-oauth) only
// Redirects to Microsoft's authorize endpoint; stores state/nonce in req.session.

// GET /api/auth/callback — 302, Mode 4 only, own controller (not under /api/v1/auth)
// OIDC redirect-URI target — the exact path already registered on the shared Azure App
// Registration. On success, req.logIn()s (auto-provisioning on first OAuth login, matched by email)
// and redirects to '/'. On any failure, redirects to '/#/login?oauthError=1' with no provider
// detail leaked (logged server-side only).
```

---

## Logs

```ts
// POST /api/v1/logs — REMOVED (open-source readiness): the route no
// longer exists and answers Nest's default 404. Hooks older than 1.7.0, which had it
// hardcoded, stop uploading and must be upgraded. POST /api/v2/logs (below) is the only
// upload route; the query params, body encoding and request-path errors in this block
// are the v2 route's. See docs/knowledgebase/hook-api-versioning.md.
//
// POST /api/v2/logs — query params
// Auth: X-API-Key header always required
interface PostLogsQuery {
  type: 'artisyn' | 'claude' | 'claude-subagent' | 'otel'; // required
                            //   'otel' (hook 2.3.0+) carries OTLP logs/metrics captured by the
                            //   project-local otel-receiver.js. No server-side change was needed:
                            //   the column is varchar(50) and every session-list/detail/export query
                            //   filters log_type to an explicit artisyn|claude|claude-subagent
                            //   allow-list, so otel rows are stored but not surfaced in the UI.
  sessionId: string;        // required; for sub-agent logs this is the agent ID
  parentSessionId?: string; // optional; required when type='claude-subagent'
                            //   sets parent_session_id on the sessions row at upsert time
                            //   ignored for all other log types
  workflowRunId?: string;   // optional; sent by hook v1.6.0+ only for workflow-subdir agent
                            //   uploads (value = the wf-id folder name, e.g. "wf_b4978a0b-2af")
                            //   sets workflow_run_id on the sessions row at upsert time,
                            //   independently of parentSessionId (both can be set on one row)
  snapshotId?: string;      // optional; sent by hook 2.22.0+ on every artisyn upload of the
                            //   current session (harness snapshot, see
                            //   docs/knowledgebase/hook-system-overview.md's "Context injection").
                            //   64-char lowercase-hex, DD-2's content-addressed id. An invalid
                            //   value (wrong shape) is silently ignored — never a 400 — and
                            //   treated the same as if it were absent.
  snapshotFull?: '1';       // optional; present only when the body's harness-snapshot line is
                            //   the FULL snapshot (not just a harness-snapshot-ref). Ignored
                            //   unless snapshotId is also present and valid.
}
// Request body: raw NDJSON stream, Content-Type: application/x-ndjson (required)
//   AppModule registers express.text() for this content-type only; a body sent as
//   application/json is parsed into an object by express.json() first and then
//   rejected by the controller's `typeof rawBody !== 'string'` check (400).
// Request encoding — NOT a contract change: the body may be gzip-compressed, in either of two forms.
//   (a) Content-Encoding: gzip — inflated by body-parser itself (inflate defaults to
//       true and nothing disables it). Content-Length is the compressed length; the
//       app-level LOGS_MAX_BODY_MB limit is counted on the DECOMPRESSED bytes.
//   (b) No Content-Encoding, compressed bytes anyway (an intermediary stripped the
//       header) — inflateSniffedGzip (server/src/logs/gzip-sniff.middleware.ts,
//       registered in AppModule.configure() for LOG_INGEST_ROUTES = POST api/v2/logs)
//       peeks the first 2 bytes, and only when they are 1f 8b takes the body over,
//       inflates it and rewrites content-length. A non-gzip body is unshifted
//       untouched, so a plain request is byte-for-byte unaffected.
//   Hook 2.8.0+ compresses by default (never to a loopback serverUrl); older hooks
//   send plain and are unaffected.
// Errors: 400 non-string or empty body (wrong Content-Type), missing sessionId or type param, 401 X-API-Key missing or invalid.
//   Malformed JSONL is NOT a request-path error: it becomes a 'failed' upload_queue row (see below).
//   400 'Malformed gzip request body' — the body starts with the gzip magic
//       bytes but fails to inflate. It never yields a 201 over a
//       mangled string. Deliberately distinct from the size error below, because the
//       hook reads a non-validation 400 as "this peer does not accept gzip" and
//       permanently downgrades to plain for the rest of its process.
//   413 — a sniffed gzip body that inflates past LOGS_MAX_BODY_MB
//       (gunzipSync's maxOutputLength), matching what the declared-Content-Encoding
//       path already did.

// POST /api/v2/logs — 201
// Auth: X-API-Key header always required
// PostLogsQuery params above, and 3 structural 400 checks
// (missing sessionId, missing type, empty/non-string body) — but NO NDJSON
// parsing on the request path. The raw body is staged to disk and queued;
// a background scheduler parses it and upserts off the request path.
//
// Request encoding: as described above (gzip accepted with or without the header;
// 400 'Malformed gzip request body' / 413 on a sniffed body that inflates over the limit).
//
// Chunked upload (hook 1.8.0+): four additional optional query params,
// sent only when the hook splits a body >CHUNK_SIZE_BYTES into chunks
// (900KB as of hook 2.6.1 — see docs/knowledgebase/hook-api-versioning.md for why; as of
// hook 2.8.0 that is the budget for the ON-THE-WIRE, i.e. compressed, body, so one chunk
// request typically carries several MB of NDJSON). All three of
// uploadId/chunkIndex/totalChunks must be present together or none at all.
interface PostLogsChunkQuery {
  uploadId?: string;    // hook-generated crypto.randomUUID(), distinct from sessionId
  chunkIndex?: string;  // 0-based integer, as a string
  totalChunks?: string; // integer >= 1, as a string
  totalSize?: string;   // decimal string; total byte length of the full un-chunked
                         //   body; required and read only on the chunkIndex===0 request.
                         //   ALWAYS uncompressed bytes, whatever encoding the chunks use,
                         //   so reassembly and upload_queue.size_bytes stay truthful.
}
response: { warnings: string[]; unknownSnapshotId?: string } | { complete: boolean; warnings?: string[]; unknownSnapshotId?: string }
// Non-chunked path (no chunk params sent) — otherwise UNCHANGED: { warnings: string[] }.
//   warnings — one message per outstanding status='failed' upload_queue row for
//   the calling API key's userId (from a PREVIOUS upload's parse/upsert
//   failure), formatted "Hook uploaded broken file: <fileName> — <errorMessage>".
//   Empty array when there are no outstanding failures. A malformed NDJSON
//   body no longer 400s synchronously on this route — it becomes a failed
//   queue row surfaced via this array on a later call instead.
//   unknownSnapshotId — additive, present only when ALL of (DD-8):
//     - the request's snapshotId query param is present and format-valid;
//     - snapshotFull was NOT '1' on this request (i.e. this was a ref-only upload);
//     - the server has no harness_snapshots row for (this API key's userId, snapshotId);
//     - the server has no upload_queue row for (userId, that snapshotId,
//       status IN ('pending','processing','partially_uploaded')) either.
//   Telling the hook "I don't have the body behind this id" is what makes it resend the
//   full harness-snapshot line on its next upload (see hook-api-versioning.md). Never
//   present when snapshotId was absent/invalid, or when this request itself carried
//   snapshotFull=1 — the server does not ask back for what the same request just sent.
// Chunked path, intermediate chunk: { complete: false } — unchanged, never carries unknownSnapshotId.
// Chunked path, final chunk (the one completing the set): { complete: true, warnings: string[], unknownSnapshotId?: string }
//   — same warnings/unknownSnapshotId semantics as the non-chunked path, evaluated once
//   for the whole reassembled upload (every chunk carries the same snapshotId/snapshotFull
//   query params — see hook-api-versioning.md).
// Errors:
//   400 — missing sessionId/type query param, or empty/non-string body;
//         chunked path also 400s on: an incomplete uploadId/chunkIndex/totalChunks
//         subset; non-integer or out-of-range chunkIndex/totalChunks; chunkIndex>0
//         referencing an unknown uploadId; a totalChunks value that mismatches the
//         uploadId's previously recorded value; missing/non-numeric totalSize on
//         the chunkIndex===0 request
//   401 — X-API-Key missing or invalid
//   500 — staging-directory write failure (disk full/permissions); no queue row created
//
// Backward compatibility: files <=CHUNK_SIZE_BYTES, or any caller that omits all four chunk
// query params, use the original single-request path and response shape unchanged
// — this is what keeps hooks older than 1.8.0 working with no code changes.
```

---

## Combined Post-Turn Analysis Config

```ts
// GET /api/v2/post-turn-analysis/config — 200
// Auth: X-API-Key header always required
// The one gate-info GET both hook branches (advisor, attribution)
// read before deciding whether to evaluate at all. A thin composition layer only: it
// normalizes repoUrl first, then Promise.all-calls each feature service's own
// resolveGate() and merges the two independent results. Replaces the two feature-specific
// GET routes from the pre-unification design; each feature's own POST result-submission
// endpoint (below) is untouched and still separate.
// Query: repoUrl (url-encoded), sessionId, promptWatermark (integer; used by the
//   attribution branch only — the advisor branch ignores it).
interface PostTurnAnalysisConfigResponse {
  advisor: TurnEndAdvisorGate;
  attribution: SessionAttributionGate;
}
interface TurnEndAdvisorGate {
  enabled: boolean;
  thresholdMet: boolean;
  minSessionCostUsd: number;
  aggregate: TurnEndAdvisorAggregate | null; // null unless enabled && thresholdMet
}
interface TurnEndAdvisorAggregate {
  toolUsage: { toolName: string; calls: number; failures: number }[];
  fileUsage: { categoryName: string; fileCount: number; byteCount: number }[];
  promptCount: number;          // tree-wide SUM(turn_count)
  turnCount: number;            // invoking (root) session's own turn_count
  workTimeMs: number;
  sessionCostUsd: number;       // tree-wide, OTEL-preferred/computed-fallback
  model: string | null;
  contextWindow: number | null;
}
interface SessionAttributionGate {
  enabled: boolean;
  attributes: AttributeDef[];
  evaluatedWatermark: number | null;
  evaluationRequired: boolean;  // enabled && promptWatermark > (evaluatedWatermark ?? -1)
}
interface AttributeDef {
  key: string;
  label: string;
  type: 'string' | 'string[]' | 'boolean' | 'number';
  prompt: string;
}
// Unknown/switch-off repoUrl: both sub-objects answer enabled:false (attribution also
//   evaluationRequired:false) — not an error.
// Unknown sessionId (not-yet-ingested): advisor treats cost as below threshold
//   (thresholdMet:false, aggregate:null); attribution answers
//   evaluatedWatermark:null, evaluationRequired:enabled.
// Side effect: upserts promptWatermark into session_prompt_watermark monotonically
//   (GREATEST) whenever the session row exists — regardless of enabled/evaluationRequired.
// Errors: 400 missing repoUrl/sessionId query param, 401 X-API-Key missing/invalid.
```

---

## Turn-End Cost Advisor

```ts
// POST /api/v2/turn-end-cost-advisor — 200
// Auth: X-API-Key header always required
// The hook's advisor-branch result submission endpoint. The combined gate-info GET the
// hook reads before deciding whether to evaluate at all is
// GET /api/v2/post-turn-analysis/config (see above).
interface SubmitTurnEndAdvisorRunBody {
  sessionId: string;               // Claude UUID; resolved as sessions.session_id = :sessionId
  startedAt: string;                // ISO 8601
  finishedAt: string;               // ISO 8601
  outcome: 'submitted' | 'failed';
  evalSessionId?: string | null;    // spawned `claude -p` session id, cross-ref only
  summary?: {                       // present only on outcome:'submitted'
    general: string;
    costFactors: string[];
    harnessAdvice: string[];
  };
  failureReason?: string | null;    // present only on outcome:'failed'
  cost?: {
    model?: string | null;
    costUsd?: number | null;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}
response: { applied: boolean }
// Ownership: accepted only if the resolved session has an artisyn `logs` row with
//   user_id = <API-key user> (same convention getSessionLogs()'s owner-only guard
//   uses) — otherwise 404, never confirming the session's existence to a caller who
//   doesn't own it. If `sessions` has no row yet for sessionId (POST /api/v2/logs only
//   staged the body into upload_queue, or the session hasn't been ingested at all yet),
//   no ownership check is possible — the request proceeds exactly as if ownership had
//   resolved 'ok' (a session unknown to the server is not distinguishable
//   from a false/negative case, so it is not treated as one).
// Not-yet-ingested / not-yet-known sessions: always 2xx { applied: true } — never
//   { applied: false } and never 5xx/404 for this reason alone.
//   `turn_end_advisor_runs.session_id` has no FK (migration `0058`), so the row is
//   written immediately holding the raw sessionId string; once the session is later
//   ingested, the run resolves and displays exactly as if it had existed at submission
//   time. Rows that never resolve (deleted session, permanently failed upload) are
//   periodically purged by `TurnEndAdvisorOrphanCleanupScheduler` after a retention
//   window — see db-tables.md's `turn_end_advisor_runs` entry.
// Writes exactly one append-only row to turn_end_advisor_runs per actual evaluation
//   attempt (outcome ∈ {'submitted','failed'}); a below-threshold or feature-off turn
//   never calls this endpoint at all. Overlapping runs on rapid consecutive turns are
//   permitted, not locked.
// Errors: 400 body validation (class-validator DTO), 401 X-API-Key missing/invalid,
//   404 session belongs to a different API-key user.
```

---

## AI Session Attribution

```ts
// POST /api/v2/session-attribution — 200
// Auth: X-API-Key header always required
// The hook's attribution-branch result submission endpoint. The combined gate-info GET the
// hook reads before deciding whether to evaluate at all is
// GET /api/v2/post-turn-analysis/config (see "Combined Post-Turn Analysis Config" above).
interface SubmitSessionAttributionBody {
  sessionId: string;                // Claude UUID; resolved as sessions.session_id = :sessionId
                                     //   — the invoking session; row key for BOTH
                                     //   session_attribution and session_attribution_runs
  promptWatermark: number;
  startedAt: string;                 // ISO 8601
  finishedAt: string;                // ISO 8601
  invokingSessionId: string;         // same session as sessionId, stored unresolved on the
                                      //   run row only — see db-tables.md's
                                      //   session_attribution_runs entry
  outcome: 'submitted' | 'failed';
  values?: Record<string, string | string[] | boolean | number | null>; // present only on
                                      //   outcome:'submitted'; loosely typed here, per-key
                                      //   type validation is a server-side concern
  evalSessionId?: string | null;     // spawned `claude -p` session id, cross-ref only
  failureReason?: string | null;     // present only on outcome:'failed'
  cost?: {
    model?: string | null;
    costUsd?: number | null;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}
response: { applied: boolean }
// Ownership: accepted only if the resolved session has an artisyn `logs` row with
//   user_id = <API-key user> — otherwise 404, never confirming the session's existence.
// Not-yet-ingested: if `sessions` has no row yet for sessionId, the answer is
//   2xx { applied: false } — never 5xx/404 — no run row written, session_attribution untouched.
// The apply is a single conditional statement:
//   INSERT ... ON CONFLICT (session_id) DO UPDATE ... WHERE excluded.prompt_watermark >
//   session_attribution.prompt_watermark — two concurrent submissions cannot interleave, and
//   a submission whose promptWatermark is lower-or-equal to the stored one is silently
//   discarded (no error, no state change).
// outcome:'failed' passes straight through to the run row's outcome='failed' and never
//   touches session_attribution. outcome:'submitted' is server-derived into 'applied' (the
//   upsert's WHERE matched) or 'ignored_stale' (it didn't) — response.applied mirrors that:
//   true only when the run's own outcome is 'applied'.
// Writes exactly one append-only row to session_attribution_runs per actual evaluation
//   attempt (outcome ∈ {'applied','ignored_stale','failed'}) — every submission is recorded.
// Errors: 400 body validation (class-validator DTO), 401 X-API-Key missing/invalid,
//   404 session belongs to a different API-key user.
```

`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs` (existing, see Repositories below)
gains `turnEndAdvisor: { generatedAt, summaryGeneral, costFactors, harnessAdvice, model,
costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } | null` — the latest
`outcome='submitted'` row from `turn_end_advisor_runs` for this session, `null` when never
successfully evaluated. `model`/`costUsd` are `null` when the submitted run didn't carry a
priced cost (`costUsd` is `Number()`-converted from the numeric-string column); the four token
fields default to `0`, matching the column defaults. This is deliberately the only
session-detail surface for the advisor result — there is no separate
session-detail cost/advisor endpoint.

---

## User Settings

Generic per-user key/value store (`SessionAuthGuard`). The server never
interprets a setting name nor parses a value — the client owns both. Every
route acts on the caller's own rows only; there is no path or body field
that targets another user.

```ts
interface UserSetting {
  name: string;
  value: string | null; // null when the setting has never been written
}

// GET /api/v1/user-settings — 200 → UserSetting[]  (the caller's rows only)
// GET /api/v1/user-settings/:name — 200 → UserSetting  (value: null when absent)
// PUT /api/v1/user-settings/:name — 200 → UserSetting  body: { value: string }
// DELETE /api/v1/user-settings/:name — 204, idempotent
// :name must match /^[A-Za-z0-9._-]{1,100}$/ — 400 otherwise
// value is capped at 64 KB (@MaxLength(65536)) — 400 otherwise
// Errors: 401 — not authenticated
```

Known setting names are client-owned; see `db-tables.md` → `user_settings`.

---

## AI Tool Versions

Release-version history of known AI tools, recorded by the server's hourly
`ai-tool-version-check` scheduler from the npm registry (see
`system-info-and-cluster.md`). `SessionAuthGuard`.

```ts
// GET /api/v1/ai-tool-versions/:toolName — 200 → AiToolVersionsResponse
// :toolName must be a key of AI_TOOLS (server/src/ai-tool-versions/ai-tool-versions.constants.ts);
// today only 'claude-code'. Any other name → 404.
// server: ai-tool-versions.types.ts, client: client/src/models/ai-tool-versions.ts
interface ReleaseVersions { latest: string; stable: string } // npm dist-tags; other tags dropped
interface AiToolVersionHistoryEntry {
  versions: ReleaseVersions;
  effectiveFrom: string; // ISO 8601 — when the server first recorded this {stable, latest} pair
}
interface AiToolVersionsResponse {
  toolName: string;
  fetchedAt: string | null;             // ISO; null before the first successful fetch
  history: AiToolVersionHistoryEntry[]; // effective_from ASC, id ASC; [] before first success
}
// Errors: 401 — not authenticated; 404 — unknown toolName
```

The client picks the entry in effect at a session's start with
`pickReleaseVersionsAt` (`client/src/viewer/lib/release-versions.ts`) for the
`claude-version` Summary detector.

---

## Sessions

All session endpoints require a session cookie (`SessionAuthGuard`).
Unauthenticated requests return 401. API key auth is not accepted.

```ts
// GET /api/v1/sessions/retention-days — 200 → { retentionDays: number }
// The effective session retention window (SESSION_RETENTION_DAYS, default 30).
// Readable by ANY authenticated user — unlike GET /api/v1/admin/retention,
// which serves the same number alongside admin-only settings.
// Errors: 401 — not authenticated
```

```ts
// DELETE /api/v1/sessions/:sessionId — 204
// Requires: authenticated session; caller must be the session owner (no admin override)
// :sessionId — the public session_id string (not the numeric PK)
// Purges all associated data (logs, session_stats, user_favorite_sessions,
//   session_file_stats, orphan contexts) and marks the session row as deleted.
// Child sub-agent sessions are also purged and soft-deleted.
// Re-uploading a deleted sessionId is silently ignored (no new data inserted).
// Errors:
//   401 — not authenticated
//   403 — caller is not the session owner (admins included)
//   404 — session not found or already deleted
```

---

## Admin

```ts
// PATCH /api/v1/users/:userId/role — 200
// Requires: session cookie, role='admin'
body: { role: 'admin' | 'user' }
response: { id: number; email: string; role: UserRole; createdAt: string }
// Only these public profile fields are returned — never passwordHash.
// Errors:
//   400 — cannot change own role; cannot demote last admin
//   401 — not authenticated
//   403 — caller is not admin

// POST /api/v1/users/:userId/reset-password-link — 200
// Requires: session cookie, role='admin'
// Generates a password reset token for the target user (via the same
// PasswordResetTokensService used by the self-service forgot-password flow) and returns the
// reset URL directly — no email is sent.
body: none
response: { resetUrl: string }
// Errors:
//   401 — not authenticated
//   403 — caller is not admin
//   404 — user not found
```

---

## Admin Panel

All admin panel endpoints require a session cookie and `role='admin'` (`AdminGuard`).
Non-admin requests return 403. Unauthenticated requests return 401.

```ts
interface AdminRepo {
  id: number | null;                  // null = orphan team link (team_repositories row, no repositories row)
  repoUrl: string;
  ownerEmail: string | null;
  sessionCount: number;
  logSize: number;                    // total size in bytes of all log bodies for the repository (0 when no logs)
  maxUploadBytes: number | null;      // largest single artisyn upload body in bytes; null until first artisyn upload
  lastSession: string | null;         // ISO 8601
  firstSeen: string | null;           // ISO 8601
  teamId?: number;                    // orphan rows only
  teamRepoId?: number;                // orphan rows only
  teamName?: string | null;           // orphan: the linking team; real rows: every team linking the URL,
                                      // comma-joined by name, or null when none
}

interface AdminTeam {
  id: number;
  name: string;
  ownerEmail: string;
  createdAt: string;   // ISO 8601
  memberCount: number;
  repoCount: number;
}

interface AdminTeamMember {   // identity only — no session data
  userId: number;
  email: string;
  isOwner: boolean;
}

interface AdminUser {
  id: number;
  email: string;
  role: 'admin' | 'user';
  createdAt: string;           // ISO 8601
  teamCount: number;
  lastActivity: string | null; // ISO 8601
}

interface ErrorLogEntry {
  timestamp: string;      // ISO 8601, parsed from the log line's local-time string
  source: string;         // NestJS logger context, e.g. "AdminPanelController"
  message: string;
  details: string | null; // trailing key=val metadata blob and/or continuation lines; null if none
}

interface UploadQueueEntry {
  id: number;
  fileName: string;
  sizeBytes: number;
  receivedAt: string;     // ISO 8601
  sessionId: string;
  logType: string;
  userId: number;
  repoUrl: string | null; // null until the session/repo link exists yet
  status: 'pending' | 'processing' | 'failed' | 'partially_uploaded'; // added 'partially_uploaded'
  errorMessage: string | null; // set only when status='failed'
  uploadId: string | null;        // set only for rows created via the /api/v2/logs
                                   //   chunked path; null for single-request uploads
  chunksReceived: number | null;  // chunks staged so far; null unless chunked
  totalChunks: number | null;     // total expected chunks; null unless chunked
}

// GET /api/v1/admin/repos — 200
// Returns all repositories across all users with usage statistics.
response: AdminRepo[]

// GET /api/v1/admin/teams — 200
// Returns all teams with member and repository counts.
response: AdminTeam[]

// GET /api/v1/admin/teams/:teamId/members — 200
// Member identity only, ordered by email. Backs the Admin → Teams "Set new owner" picker.
response: AdminTeamMember[]
// Errors: 404 team not found, 403 caller is not admin

// POST /api/v1/admin/teams/:teamId/owner — 200
// FR-8 "Set new owner": any admin, member of the team or not. Same rule as the owner's own
// transfer — the new owner must be a current member; the previous owner stays a member.
body: { userId: number }
response: { id: number; name: string; ownerId: number; createdAt: string; accessMode: TeamAccessMode }
// Errors: 400 'New owner must be a current team member', 404 team not found, 403 not admin

// DELETE /api/v1/admin/team-repos/:teamRepoId — 204
// Deletes an ORPHAN team link only (no repositories row has its repo_url); team_repo_config
// goes by FK cascade. A linked repo with data is removed only via DELETE /admin/repos/:id.
// Errors: 404 link missing or not an orphan, 403 not admin

// GET /api/v1/admin/users — 200
// Returns all registered users with team membership count and last activity timestamp.
response: AdminUser[]

// PATCH /api/v1/admin/users/:id/role — 200
// Updates the role of the specified user.
body: { role: 'admin' | 'user' }
response: { id: number; email: string; role: 'admin' | 'user'; createdAt: string }
// Only these public profile fields are returned — never passwordHash. The client
// refetches the admin-users list after this call rather than using the body.
// Errors:
//   400 — cannot change own role; cannot demote last admin
//   401 — not authenticated
//   403 — caller is not admin
//   404 — user not found

// PATCH /api/v1/admin/users/:id/email — 200
// Renames the specified user's email (same user.id — not a merge). No
// emailConfirmedAt/email-sending side effects. All FK-owned records (repos,
// teams, memberships, API keys) follow automatically since they reference
// userId, not the email.
body: { email: string }
response: { id: number; email: string; role: 'admin' | 'user'; createdAt: string }
// Only these public profile fields are returned — never passwordHash.
// Errors:
//   401 — not authenticated
//   403 — caller is not admin
//   404 — user not found
//   409 — email already belongs to a different user

// POST /api/v1/admin/users/:id/delete — 204
// Requires: session cookie, role='admin'
// Hard-deletes another user's account and everything it owns — same cascade as the self-service
// POST /api/v1/auth/delete-account. POST rather than DELETE because of the confirmation body.
body: { confirmEmail: string } // must case-insensitively equal the TARGET user's email
// Errors:
//   400 — :id is the caller's own id (self-deletion must use /api/v1/auth/delete-account, which
//         also signs the caller out); confirmEmail does not match; target is the last admin
//   401 — not authenticated
//   403 — caller is not admin
//   404 — user not found

// DELETE /api/v1/admin/repos/:id — 204
// Requires: session cookie, role='admin'
// Hard-deletes every repository row with the same repoUrl, its team_repositories rows, the artisyn
// logs linked through log_repositories, and each of those sessions' whole family — the root session,
// its claude / claude-otel logs, session_stats and other child data, and all descendant sub-agent
// sessions (SessionsService.hardDeleteSessionsInTx). No deleted_session_log audit row is written.
// Errors:
//   401 — not authenticated
//   403 — caller is not admin
//   404 — repo not found

// GET /api/v1/admin/error-logs — 200
// Scans up to the 30 most recent server/logs/app-*.log files for ERROR-level lines
// (server-side app logs, not the hook-originated repositories.hook_log_tail entries),
// merges and sorts them newest first, and caps the result to 30 entries. Returns
// { entries: [] } (not an error) if the logs directory doesn't exist yet.
response: { entries: ErrorLogEntry[] }

// GET /api/v1/admin/logs-archive — 200
// Requires: session cookie, role='admin'
// Zips the entire server/logs/ directory into a temp file (os.tmpdir()) synchronously
// (fully archived before the response starts), then streams it back as a file download
// and deletes the temp file afterward.
response: application/zip (Content-Disposition: attachment; filename="logs-<ISO timestamp>.zip")

// GET /api/v1/admin/upload-queue — 200
// Requires: session cookie, role='admin'
// Flat list of all upload_queue rows (client groups by sessionId for display),
// ordered by sessionId then receivedAt. repoUrl resolved via sessions -> logs ->
// log_repositories -> repositories (most-recently-updatedAt logs row wins if a
// session links to more than one repo); null if the session/link doesn't exist yet.
// Rows with status='partially_uploaded' are chunked uploads still in
// progress — chunksReceived < totalChunks; the row flips to 'pending' the instant
// the final chunk reassembles the file, and is never seen by the scheduler's
// pending-claim query while partially_uploaded.
response: UploadQueueEntry[]

// DELETE /api/v1/admin/upload-queue/failed — 200
// Requires: session cookie, role='admin'
// Deletes all status='failed' rows and their staged files (best-effort unlink,
// ENOENT ignored). pending/processing rows are left untouched.
response: { deletedCount: number }

// POST /api/v1/admin/upload-queue/reprocess-failed — 200
// Requires: session cookie, role='admin'
// Resets all status='failed' rows back to pending (clearing errorMessage) so the
// scheduler's next tick reclaims and reprocesses them. Staged file is kept (no
// file I/O). pending/processing rows are left untouched.
response: { updatedCount: number }

// GET /api/v1/admin/upload-queue/:id/file — 200
// Requires: session cookie, role='admin'
// Streams the staged file behind one queue row as an attachment (Content-Disposition
// filename = the row's fileName) so an admin can analyze why it failed. For a
// partially_uploaded row this is the chunk part-file the row points at.
// 404 when the row does not exist or its staged file is gone from disk.
response: raw file bytes (application/octet-stream)

// GET /api/v1/admin/upload-queue/stats — 200
// Requires: session cookie, role='admin'
// Queue backlog + worker load/throughput/latency, from one 3-CTE aggregate over
// upload_queue and upload_queue_measurements. Every rate/latency field and drainEtaMs
// are null — never 0/Infinity/NaN — when the window holds no successful attempt (or,
// for drainEtaMs, when the pending backlog is empty).
response: {
  windowMs: number;              // UPLOAD_QUEUE_STATS_WINDOW_MS (default 900000)
  retentionWindowMs: number;     // UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS (default 604800000)
  // Always all four statuses, zero-filled server-side, in this fixed order:
  // pending, processing, partially_uploaded, failed
  byStatus: {
    status: 'pending' | 'processing' | 'partially_uploaded' | 'failed';
    files: number;
    bytes: number;
  }[];
  total: { files: number; bytes: number };
  processingNow: number;
  worker: {
    instanceCount: number;       // computeInstanceCount(os.availableParallelism())
    activeMs: number;            // summed duration_ms in the window (successes + failures)
    utilizationPercent: number;  // activeMs / (windowMs * instanceCount) * 100, clamped 0..100
    filesPerSec: number | null;  // successes / (summed successful duration_ms / 1000)
    bytesPerSec: number | null;  // successful bytes / (summed successful duration_ms / 1000)
    successCount: number;
    failureCount: number;
  };
  // Same summed-active-duration formula over the whole retention window. No utilisation
  // (the cluster's instance count over 7 days is not knowable), no latency, no ETA.
  worker7d: {
    filesPerSec: number | null;
    bytesPerSec: number | null;
    successCount: number;
  };
  // End-to-end queue wait (finished_at - received_at) over SUCCESSFUL attempts only.
  // p95Ms uses percentile_cont(0.95) — the repo's only ordered-set aggregate.
  latency: {
    avgMs: number | null;
    p95Ms: number | null;
    minMs: number | null;
    maxMs: number | null;
  };
  // Time to clear the status='pending' backlog at the measured rate; the max of the
  // file- and byte-constrained estimates. processing/partially_uploaded are not backlog.
  drainEtaMs: number | null;
}

// GET /api/v1/admin/auth — 200
// Requires: session cookie, role='admin'
// Non-secret config for the active AUTH_MODE — the field group present matches the mode
// (Mode 1 has none).
response: {
  mode: string;
  smtp?: { host: string; port: number; from: string };
  azure?: { tenantId: string; clientId: string; redirectUri: string; authority: string };
}

// GET /api/v1/admin/auth/pending-registrations — 200
// Requires: session cookie, role='admin'. Mode-3 concept — [] in every other mode (client hides
// the table; server does not restrict the query by mode). Oldest-registered-first, unpaginated.
response: { id: number; email: string; registeredAt: string; tokenExpiresAt: string }[]

// POST /api/v1/admin/auth/pending-registrations/:id/resend — 200
// Requires: session cookie, role='admin'. :id is users.id. Shares the same 60s cooldown as the
// user-facing resend-confirmation endpoint (triggering one 429s the other).
response: { email_delivery: 'sent' | 'failed' }
// Errors: 404 (no such pending row), 409 (already confirmed), 429 (Retry-After header)

// DELETE /api/v1/admin/auth/pending-registrations/:id — 204
// Requires: session cookie, role='admin'. Atomic — deletes the account only if still unconfirmed
// (email_confirmation_tokens row cascades). Same 404-vs-409 guard as resend.
```

---

## Data Retention (admin or team owner)

`GET /api/v1/admin/retention` requires a session cookie and either `role='admin'` OR
ownership of at least one team (`AdminOrTeamOwnerGuard`) — this is the one admin-panel-adjacent
endpoint reachable by team owners who are not site admins. Unauthenticated requests return 401;
authenticated requests from a user who is neither an admin nor a team owner return 403.

```ts
interface RetentionDailyBucket {
  day: string;            // ISO 8601, UTC midnight
  sessionCount: number;
  totalSizeBytes: number; // sum of octet_length(logs.body::text) for sessions in this day
}

interface RetentionResponse {
  retentionDays: number;              // SESSION_RETENTION_DAYS (same value the purge scheduler uses)
  oldestSessionAt: string | null;     // ISO 8601; null when there are zero non-deleted sessions
  youngestSessionAt: string | null;   // ISO 8601
  totalSessionCount: number;
  dailySeries: RetentionDailyBucket[]; // UTC-day-bucketed, gap-filled (zero-session days included)
}

// GET /api/v1/admin/retention — 200
// Session "age" per session = MIN(logs.created_at) across all of that session's log rows
// (same column SessionRetentionService uses to judge purge-eligibility), scoped to
// non-deleted sessions only. Not scoped to the caller's own sessions/team — shows
// retention stats across the whole install.
response: RetentionResponse
```

---

## Teams

All team endpoints require a session cookie (`SessionAuthGuard`).
Unauthenticated requests return 401. API key auth is not accepted.

```ts
// POST /api/v1/teams — 201
// Requires: authenticated session
body: { name: string }
response: Team
// Errors: 409 team name taken

// GET /api/v1/teams — 200
// Returns teams the caller belongs to (owner or member) — admins included; the admin role
// grants no team visibility (admins see every team only in GET /api/v1/admin/teams).
response: Team[]

// GET /api/v1/teams/:teamId — 200
// Requires: team member (TeamAccessGuard — no admin bypass)
response: Team
// Errors: 403 not a member, 404 team not found

// PATCH /api/v1/teams/:teamId — 200
// Requires: team owner (TeamOwnerGuard — no admin bypass)
body: { name?: string; accessMode?: TeamAccessMode }
response: Team
// Errors: 403 not owner, 409 name taken, 400 no fields to update
//   409 'Cannot switch to transparent: the team has members besides the owner' — setting
//       accessMode:'transparent' on a team with any non-owner member is permanently refused:
//       those members joined under the restricted privacy promise and it cannot be revoked.
//       The reverse direction ('transparent' -> 'restricted') only reduces exposure and is
//       never blocked. The client derives the same lock from its member list and renders the
//       Transparent card disabled, so this 409 is a backstop, not the normal UX path.

// DELETE /api/v1/teams/:teamId — 204
// Requires: team owner
// Cascades: deletes team_members, team_repositories; cancels pending invitations
// Errors: 403 not owner

// GET /api/v1/teams/:teamId/members — 200
// Requires: team member
// disclosureAcknowledgedAt is returned verbatim only to the team owner;
//   every other caller gets null on every row.
response: TeamMember[]
// Errors: 403, 404

// PATCH /api/v1/teams/:teamId/members/:userId — 200
// Requires: team owner (TeamOwnerGuard — deliberately NO admin bypass: role grants are the
//   owner's alone)
body: { canInvite?: boolean; isManager?: boolean; isAdlcTrainer?: boolean }
//   All three optional and independently patchable (canInvite included). The two
//   role flags stack (a member can be both manager and ADLC trainer) and are only consulted
//   while the team's accessMode is 'restricted'.
response: the updated team_members row
// Errors: 403, 404 member not found, 400 no fields to update (empty body)

// GET /api/v1/teams/pending-disclosures — 200
// Requires: session cookie only (no team guard — it answers "which of MY teams still owe a
//   disclosure"). Declared BEFORE @Get(':teamId') in the controller, or that route's
//   ParseIntPipe swallows the literal segment and 400s.
// Teams the caller is a member of where team_members.disclosure_acknowledged_at IS NULL —
//   i.e. the two membership paths with no Accept step (force-invite auto-provisioning and
//   addMemberIfRealUser during an import). Ordered by teamId. The client shows one disclosure
//   modal per row at login and drains them via the POST below.
response: Array<{ teamId: number; teamName: string; accessMode: TeamAccessMode; hasTrainer: boolean }>
// Errors: 401

// POST /api/v1/teams/:teamId/acknowledge-disclosure — 200
// Requires: team member (TeamAccessGuard)
body: { acknowledgedAccessMode: TeamAccessMode }
// Stamps team_members.disclosure_acknowledged_at = now() for the CALLER's own row.
// acknowledgedAccessMode must equal the team's live access_mode, so a modal rendered before the
//   owner flipped the mode cannot consent to the wrong contract.
response: { acknowledged: true }
// Errors:
//   400 — acknowledgedAccessMode differs from the team's current mode, or is not one of the two
//         enum values
//   403 — not a member
//   404 — no membership row for the caller

// DELETE /api/v1/teams/:teamId/members/:userId — 204
// Requires: team owner (TeamOwnerGuard)
// Also cancels pending invitations for the removed user in this team
// Errors: 403, 404

// POST /api/v1/teams/:teamId/leave — 204
// Requires: authenticated session; caller must be a member (not owner)
// Errors: 400 owner cannot leave

// POST /api/v1/teams/:teamId/transfer — 200
// Requires: team owner
body: { userId: number }  // must be a current member
response: Team
// Errors: 400 new owner not a member, 403

// GET /api/v1/teams/:teamId/repositories — 200
// Requires: team member
response: TeamRepository[]
// Errors: 403, 404

// POST /api/v1/teams/:teamId/repositories — 201
// Requires: team owner
body: { repoUrl: string }
response: TeamRepository
// Idempotent: returns existing row if URL already in team

// DELETE /api/v1/teams/:teamId/repositories/:repoId — 204
// Requires: team owner (TeamOwnerGuard)
// Hard-deletes the underlying repositories row if no other team references the URL.
// Errors: 403 (not owner), 404

// POST /api/v1/teams/:teamId/invitations — 201
// Requires: team member
// Permission to invite: owner OR member with canInvite=true
body: { email: string, force?: boolean }
response: Invitation
// Errors:
//   403 no invite permission
//   404 invitee email not found, error: 'user_not_registered' (unless force: true, which auto-provisions the user and proceeds)
//   409 already a member / pending invitation already exists
// force:true path: team_members row is inserted immediately, but the invitation itself is
//   created with status:'pending' (not 'accepted') — it flips to 'accepted' automatically on the
//   invitee's first login (UsersService.acceptGrantedInvitations(), called from identify/
//   auto-identify/OAuth callback), not via the usual PATCH .../invitations/:invId accept step.

// DELETE /api/v1/teams/:teamId/invitations/:invId — 204
// Requires: team owner ('Only the team owner can cancel invitations')
// Sets invitation status to 'cancelled'
// Errors: 403, 404
```

---

## Repositories

All repository endpoints require a session cookie (`SessionAuthGuard`).

```ts
// GET /api/v1/repositories — 200
// Returns distinct repositories linked to logs submitted by the caller.
response: UserRepository[]
// Sorted by repoUrl ascending.

// GET /api/v1/repositories/hooks — 200
// Lists the caller's own repos that have reported at least one hook-status event
// (Hook State Panel "Installed Hooks" list). Declared before :repoId in the
// controller so the literal 'hooks' segment isn't swallowed by :repoId's ParseIntPipe.
interface HookRepositorySummary {
  id: number;
  repoUrl: string;
  hookVersion: string;
  outdated: boolean;
  issueCount: number;
}
response: HookRepositorySummary[]
// Filtered to hookVersion IS NOT NULL. Sorted by repoUrl ascending.

// GET /api/v1/repositories/:repoId?teamId= — 200
// Returns the repository record with the caller's effective config (see "Repo config
// resolution" below): with teamId, team T's config → default; without it, personal → the
// caller's lowest-id team linking the URL → default.
// Access: without teamId the caller must own repoId; with teamId the caller must be a member
// of T and T must link the repo URL (no admin bypass).
interface GetRepositoryResponse {
  id: number;
  repoUrl: string;
  repoConfig: RepoConfig;
}
response: GetRepositoryResponse
// Errors:
//   400 — teamId is not a positive integer
//   401 — not authenticated
//   403 — no access (see above)
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/hook-state — 200
// Returns the current hook-state detail for a repository (Hook State Panel).
// Uses the same assertRepoAccess(user, repoId, teamId?) guard as sibling :repoId endpoints.
interface HookStateDetail {
  repoUrl: string;
  hookVersion: string;
  latestVersion: string | null;
  outdated: boolean;
  lastActivity: string | null;       // ISO timestamp
  logTail: string[];                 // last 50 hook.log lines
  nonUploadableLogs: { file: string; reason: string }[];
  recommendations: { rule: string; message: string; detectedAt: string }[];
  errors: string[];                  // logTail lines matching [error]/[fail]/[warn]
}
response: HookStateDetail
// Errors:
//   401 — not authenticated
//   403 — caller does not have access to the repository
//   404 — repoId not found, OR the repo has never reported a hook-status event (hookVersion IS NULL)

// Repo config resolution (personal vs team, task 2026-10-16-team-vs-personal-config):
//   - Personal configs live in repo_config (one per user and repository row, looked up by
//     (repoUrl, userId)); the single team config of a (team, repoUrl) pair lives in
//     team_repo_config, owned by its team_repositories link.
//   - Team view (teamId = T passed): T's config → default. The personal config is ignored.
//   - Personal view (no teamId): personal → the config of the caller's lowest-id team
//     (member or owner) linking the URL → default. The same lowest-id rule picks the team for
//     every request without teamId (old clients, the hook endpoints).
//   - default = { fileCategories: DEFAULT_FILE_CATEGORIES }, threshold 25 000.

// GET /api/v1/repositories/:repoId/settings?teamId= — 200
// Returns all config layers for the repository:
//   effectiveConfig   — per "Repo config resolution" above (sessionAttribution from the team only)
//   teamConfig        — the single config of the resolved team (T, else the lowest-id team), or null
//   userConfig        — the caller's own personal config for the URL, or null (also when the
//                       caller opens a colleague's repoId in team view)
//   teamId            — the resolved team (T, else the lowest-id team), or null
//   canEditTeamConfig — the caller owns that team
// Access: without teamId the caller must own repoId; with teamId the caller must be a member
// of T and T must link the repo URL (no admin bypass).
response: RepoSettingsResponse
// Errors:
//   400 — teamId is not a positive integer
//   401 — not authenticated
//   403 — no access (see above)
//   404 — repoId not found

// PUT /api/v1/repositories/:repoId/settings/team?teamId= — 200
// Saves or clears the single team config of a (team, repoUrl) pair (all RepoConfig fields).
// With teamId it writes exactly T's config; without it, the config of the caller's lowest-id
// owned team linking the URL. Writing through any same-URL repoId writes the same record.
// Passing config: null removes the team config (teamConfig becomes null; team view then
// shows the defaults).
// The whole RepoConfig is replaced — clients must read-modify-write (the Settings UI's
// "Analysis" tab replaces only highCacheCreationThreshold and re-sends fileCategories
// unchanged) or the other field is clobbered.
// Saving triggers recomputeTeamScope(T, repoUrl): T's session_file_stats and
// session_cause_stats rows are rewritten for every session of the URL (all owners,
// descendants included) with the saved config, or the defaults after a null save.
body: { config: RepoConfig | null }
response: RepoSettingsResponse
// Errors:
//   400 — teamId is not a positive integer; or config is invalid (empty fileCategories, blank
//          names, invalid regex patterns, duplicate names; or highCacheCreationThreshold
//          non-integer / outside 1_000…10_000_000)
//   401 — not authenticated
//   403 — no access to repoId (as for GET settings), or 'Only the team owner can edit team
//          config': the caller does not own T (or, without teamId, owns no team linking the
//          URL). Admins get no write bypass.
//   404 — repoId not found

// PUT /api/v1/repositories/:repoId/settings/user — 200
// Saves or clears the personal (user-scoped) repo config override. Same body, validation,
// read-modify-write requirement and recompute side effect as the team route above.
// Passing config: null removes the stored user config row. File stats are NOT deleted: the
// recompute rewrites this user's session_file_stats rows with DEFAULT_FILE_CATEGORIES,
// for every session tree on the same repo_url. The user's session_cause_stats rows are deleted.
// Caller must own the repository. Never touches the team config.
body: { config: RepoConfig | null }
response: RepoSettingsResponse
// Errors:
//   400 — config is invalid (same rules as the team route)
//   401 — not authenticated
//   403 — caller does not own the repository
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/sessions — 200
// Returns sessions linked to the given repository, filtered to artisyn logs only.
// Sessions with no first_prompt are excluded.
// Sorted by endTime descending (falls back to updatedAt when endTime is NULL).
//
// Performance note: firstPrompt, startTime, endTime, and gitBranch are read from
// pre-computed columns on the logs table (populated at ingest time) — no JSONB
// extraction at query time.
//
// Personal route (no teamId): caller must directly own the repository.
// Team route (?teamId=X): caller must be a member of team X AND team X must
//   have the repository URL in team_repositories.
//
// Team access mode (?teamId present) — resolveTeamScope() turns the caller's membership row
// and the team's access_mode into one three-state scope that every team-scoped repository
// route shares:
//   transparent team, any caller ........ every member's sessions, prompts intact (identical
//                                         to the old allowMemberSessionVisibility = true)
//   restricted + team owner ............. every acknowledged member's sessions, prompts intact
//   restricted + ADLC trainer ........... every acknowledged member's sessions, prompts intact
//   restricted + manager ................ every acknowledged member's sessions, firstPrompt
//                                         nulled on rows the caller does not own
//   restricted + plain member / non-member  own sessions only
// Members who have not acknowledged the access-mode disclosure are absent from every
//   team-wide result set, including the team owner's.
// Prompt masking happens in the response projection, never as a WHERE clause — first_prompt
//   IS NOT NULL is the root-session discriminator, so filtering on it would delete sessions
//   from a manager's list instead of just hiding the text.
// Analytics and report routes additionally 403 outright when the caller has no analytics
//   right (plain member, or a trainer without the manager role) and teamId is present; the
//   per-session :sessionId routes 403 when the session's owner is outside the caller's
//   visible set (never an empty payload). See server-endpoint-map.md.
//
// Branch filtering (optional):
//   ?branch=<name>  — filter to sessions where git_branch = <name>
//   ?branch=        — filter to sessions with no branch (git_branch IS NULL OR git_branch = '')
//   (omitted)       — return all sessions regardless of branch (existing behavior, backward-compatible)
//
// Attribute filtering (optional, repeatable):
//   ?attr=<key>:<op>:<value>  — op in eq|is|any|gte|lte|isnull|unattributed
//   Same-key repeats OR; different keys AND. Unknown key or an operator/type mismatch against
//   this repo's resolved attribute definitions -> 400.
interface GetRepositorySessionsQuery {
  teamId?: number;        // optional; activates team-based access check
  branch?: string;        // optional; filter by branch name; empty string matches sessions with no branch
  attr?: string | string[]; // optional, repeatable; see Attribute filtering above
}
response: RepositorySession[]
// (2026-09-23) each row carries claudeVersion: string | null — see RepositorySession above.
//   Filled by one batched per-page enrichment query over session_stats; the sessions/ids,
//   badge-poll and export-scope siblings do NOT carry it.
// each row also gains:
//   attribution: { values: Record<string, string | string[] | boolean | number | null>,
//                  promptWatermark: number, updatedAt: string } | null
//   lastRun: { outcome: 'applied' | 'ignored_stale' | 'failed', finishedAt: string,
//              failureReason: string | null } | null
// attribution is null when the session has no session_attribution row; lastRun is null when
// no evaluation attempt has ever been recorded. attribution.values has any orphaned entry
// (unknown key, or a stored value whose type no longer matches the declared type) stripped
// server-side before this response is built.
// Errors:
//   400 — teamId present but not a positive integer; malformed/unknown attr= filter
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/sessions/ids — 200
// Lightweight sibling of /sessions for callers that only need to detect new
// session ids (e.g. the client's 15s new-session badge poll) without paying for
// a full session list. Same access control as /sessions (teamId, branch), but
// skips firstPrompt and the cost/favorite/hasWorkflow enrichment queries
// entirely, and returns a bare array of session id strings (no per-session
// objects) — hideHookSessions/filterByUserEmail filtering is applied
// server-side so those fields never need to go over the wire.
interface GetRepositorySessionIdsQuery {
  teamId?: number;             // optional; activates team-based access check
  branch?: string;             // optional; filter by branch name; empty string matches sessions with no branch
  hideHookSessions?: string;   // optional; 'true' excludes sessions whose claude log contains a hook_service event
  filterByUserEmail?: string;  // optional; restricts to sessions owned by this user's email
}
response: string[]  // bare session id array, e.g. ["0002b8d8-...", "001ff495-..."]
// The client's fetchRepositorySessionIds() also appends a `_ts=<Date.now()>` cache-busting
// param and sends `cache: 'no-store'`, since this endpoint is polled on an interval and an
// unchanged URL/response could otherwise be served from the browser's HTTP cache.
// Errors: 400, 401, 403, 404 (same as /sessions)

// GET /api/v1/repositories/:repoId/sessions/branches — 200
// Returns a summary of distinct branches for sessions in the given repository.
// Only counts sessions that have a matching claude log (same filter as /sessions).
// Sessions with no git_branch are grouped under branch: null.
// Sorted by latestEndTime descending.
//
// Personal route (no teamId): caller must directly own the repository.
// Team route (?teamId=X): caller must be a member of team X AND team X must
//   have the repository URL in team_repositories.
//
// Team access mode (?teamId present): same three-state scope as GET .../sessions above —
//   transparent => every member's rows with prompts; restricted => the team owner and ADLC
//   trainers see every acknowledged member with prompts, a manager sees the same rows with
//   firstPrompt nulled, and a plain member sees only their own. See server-endpoint-map.md's
//   "Team access-mode gate" for the full table.
export interface BranchSummary {
  branch: string | null;       // null → "(no branch)" group
  sessionCount: number;
  latestEndTime: string;       // ISO 8601
  totalWorkTimeMs: number;     // sum of session_stats.work_time_ms for the branch
  // TREE-scoped: sum of session_stats.lines_changed over every session on the branch
  // AND every sub-agent session below it at any depth (session-tree-metrics.sql.ts →
  // loadTreeMetricsByRoot). Summing only the roots' own rows would make a branch of
  // delegating sessions report ~0. The name is tree-scoped on purpose: this
  // endpoint is consumed only by this repo's client, served from the same build.
  totalLinesChanged: number;
  // The root-only figure, kept additively: the branch's root sessions only. Never add
  // it to totalLinesChanged — it is already included there (double count).
  totalLinesChangedOwn: number;
  totalCost: number | null;    // sum of per-session cost, OTEL-preferred when a session's root has one, else session_stats + model_pricing; null when no pricing data
}
interface GetRepositorySessionBranchesQuery {
  teamId?: number;    // optional; activates team-based access check
  startDate?: string; // optional; ISO 8601 — must be provided together with endDate
  endDate?: string;   // optional; ISO 8601 — must be provided together with startDate
}
response: BranchSummary[]
// startDate/endDate filter the aggregation by logs.start_time; when both are omitted the
// endpoint keeps its original all-time behaviour (existing callers unaffected).
// Errors:
//   400 — teamId present but not a positive integer; only one of startDate/endDate provided;
//          startDate/endDate not valid ISO 8601
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/session-attribution/values — 200 (new)
// Feeds the session-list attribute-filter popover: for each of this repo's resolved
// attribute definitions, the distinct values seen in session_attribution.values across
// sessions in scope, with how many sessions carry each. Modeled on sessions/branches above —
// same query scope/params, different aggregation.
interface GetSessionAttributionValuesQuery {
  teamId?: number;    // optional; activates team-based access check
  startDate?: string; // optional; ISO 8601 — must be provided together with endDate
  endDate?: string;   // optional; ISO 8601 — must be provided together with startDate
}
response: Record<string, { value: string | boolean | number; sessionCount: number }[]>
// Keyed by attribute key; each attribute's array is capped at 50 entries, ordered by
// sessionCount desc. A string[]-typed attribute fans out — each array element becomes its own
// bucket (matching the `any` filter operator's element-match semantics), deduplicated per
// session. Explicit null ("not determined") values and any orphaned value (unknown key, or a
// value whose type no longer matches the declared type) are excluded — never bucketed. An
// attribute with zero attributed sessions in scope, or a repo resolving to no attribute
// definitions at all, simply has no key (or an empty object) in the response.
// Errors:
//   400 — teamId present but not a positive integer; only one of startDate/endDate provided;
//          startDate/endDate not valid ISO 8601
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/summary — 200
// Returns aggregated counts for the given repository (artisyn logs only).
//
// Personal route (no teamId): caller must directly own the repository; counts that one
//   repository row.
// Team route (?teamId=X): caller must be a member of team X AND team X must
//   have the repository URL in team_repositories; counts every team member's repository
//   row of the URL (resolveRepoIds — the rows the team's session list reads), so the
//   numbers do not depend on whose repoId was opened.
//
// Not team-access-mode scoped: these are whole-repository counts, exactly as they were under
//   the old visibility flag.
interface GetRepositorySummaryQuery {
  teamId?: number; // optional; activates team-based access check
}
interface RepositorySummary {
  sessionCount: number; // distinct sessions with artisyn logs in this repo
  userCount: number;    // distinct users who submitted artisyn logs to this repo
}
response: RepositorySummary
// Errors:
//   400 — teamId present but not a positive integer
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/contexts — 200
// Returns distinct context key/value pairs across all artisyn logs for this repo.
// Sorted by contextKey ascending.
// Same access control as /sessions and /summary.
interface RepositoryContext {
  key: string;
  value: string;
}
response: RepositoryContext[]
// Errors: 400, 401, 403, 404 (same as /sessions)

// GET /api/v1/repositories/:repoId/sessions/:sessionId/contexts — 200
// Returns distinct context key/value pairs for a specific session within the repo.
// Sorted by contextKey ascending.
// Same access control as /sessions.
response: RepositoryContext[]
// Errors: 400, 401, 403, 404 (same as /sessions)

// ─────────────────────────────────────────────────────────────────────────────
// Change Surface — two session-scoped routes.
// Split deliberately: the aggregate is fetched on EVERY session open (the Summary
// tile + the three CS detectors), the per-path rows only when the Change surface
// tab is opened. Access control on both is identical to /sessions/:sessionId/contexts.
// Every figure is TREE-scoped (root + every recursive sub-agent) and is a UNION over
// distinct changed paths, never a SUM. See docs/knowledgebase/change-surface.md.
// ─────────────────────────────────────────────────────────────────────────────

type FileKind = 'source' | 'test' | 'config' | 'docs' | 'other';
type ChangeBand = 'focused' | 'mixed' | 'scattered';   // >= 60 / 40-59 / < 40
type ChangeKind = 'added' | 'modified' | 'deleted';    // 'deleted' is never emitted today

interface ChangeSurfaceAggregate {
  computed: boolean;              // false -> render "no data" on every surface, NEVER 0
  repoRootKnown: boolean;         // false -> nothing could be normalised into the repo
  changedFiles: number;           // distinct in-repo paths
  foldersTouched: number;
  topLevelModules: string[];      // display names, sorted
  concentration: number | null;   // 0-100; null when changedFiles === 0
  band: ChangeBand | null;        // the ONLY source of the band — clients never recompute it
  filesPerFolder: number | null;
  largestFolderShare: number | null;   // [0,1]
  folderEntropyNorm: number | null;    // raw H/ln(K), NOT the formula's E; 0 when K === 1
  meanPathDistanceHops: number | null; // raw mean hop count, one decimal
  singleFileFolders: number;
  commonAncestorDepth: number | null;
  linesAdded: number;             // in-repo only
  linesRemoved: number;
  diffCoveredFiles: number;       // in-repo files with >= 1 diff-covered edit call
  outsideRepoFiles: number;       // excluded from every spread/percentage figure above
  outsideRepoLinesAdded: number;
  outsideRepoLinesRemoved: number;
  byExtension: { extension: string; files: number; linesAdded: number; linesRemoved: number }[];
  byFileKind: { kind: FileKind; files: number; share: number; linesAdded: number; linesRemoved: number }[];
  byChangeKind: { added: number; modified: number; deleted: number };
  folderDistribution: { folder: string; files: number; linesAdded: number; linesRemoved: number }[];
}

// GET /api/v1/repositories/:repoId/sessions/:sessionId/change-surface — 200
// One session TREE's change-surface aggregate. Never capped — no headline number may
// depend on a listing limit.
// Query: teamId? (positive int)
// An inaccessible or never-recomputed session returns { computed: false, ... }, not a 404
// and not a zeroed aggregate.
response: ChangeSurfaceAggregate
// Errors:
//   400 — teamId not a positive integer
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/sessions/:sessionId/change-surface/files — 200
// The per-path rows behind the Change surface tab's file tree.
// Query: teamId? (positive int)
interface ChangeSurfaceFileRow {
  rawPath: string;                // always the verbatim spelling first seen
  relPath: string | null;         // null -> outside the repo, or no root was ever learned
  folder: string | null;          // '.' for a file at the repo root
  fileKind: FileKind | null;
  extension: string | null;       // lowercased, no dot; '' when the file has none
  changeKind: ChangeKind;
  editCalls: number;
  diffCoveredCalls: number;       // 0 -> the tree prints a "no diff coverage" chip
  linesAdded: number;
  linesRemoved: number;
  outsideRepo: boolean;
}
response: {
  files: ChangeSurfaceFileRow[];  // capped at CHANGE_SURFACE_MAX_FILE_ROWS (5000)
  total: number;                  // paths the server actually holds for the scope
  truncated: boolean;             // true -> the tab says "showing the first N of M paths"
}
// Errors: same as the aggregate route above


// POST /api/v1/repositories/:repoId/sessions/:sessionId/favorite — 200
// Sets or clears the favorite flag for a session on behalf of the authenticated user.
// :sessionId is the public sessions.session_id string (not the DB PK).
// Optional ?teamId=<number> query param activates team-route access check.
// Idempotent: calling set with favorite: true multiple times returns { isFavorite: true } each time.
body: { favorite: boolean }
response: { isFavorite: boolean }
// Errors:
//   400 — teamId not a positive integer; body missing or favorite not a boolean
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found; session not found in repo

// GET /api/v1/repositories/:repoId/analytics/timeline — 200
// Returns sessions within a date range, optionally grouped by branch, user or a resolved
// session attribute. Used to render a Gantt / timeline chart on the client.
//
// Personal route (no teamId): caller must directly own the repository.
// Team route (?teamId=X): caller must be a member of team X AND team X must
//   have the repository URL in team_repositories.
//
// Team access mode (?teamId present): same three-state scope as GET .../sessions above —
//   transparent => every member's rows with prompts; restricted => the team owner and ADLC
//   trainers see every acknowledged member with prompts, a manager sees the same rows with
//   firstPrompt nulled, and a plain member sees only their own. See server-endpoint-map.md's
//   "Team access-mode gate" for the full table.
//
// Same-day shorthand: when startDate === endDate the range is expanded to
// 00:00:00–23:59:59 UTC for that day.
//
// groupBy=attr:<key> FANS OUT rather than folding: a `string[]`-typed attribute with
// N resolved values on one session produces N TimelineSession rows for it (identical fields
// except `group`), each counted in full — not one row with a comma-joined `group`. Scalar
// (`string`/`number`/`boolean`) attributes, and the fixed `branch`/`user` groupings, still
// produce exactly one row per session. See attributeGroupLabels() (attribute-filter.sql.ts).
interface GetAnalyticsTimelineQuery {
  teamId?: number;     // optional; activates team-based access check
  startDate: string;   // required; ISO 8601 (e.g. 2025-01-01 or 2025-01-01T00:00:00Z)
  endDate: string;     // required; ISO 8601
  groupBy?: 'branch' | 'user' | `attr:${string}`; // optional; cannot combine with the corresponding filter
  branches?: string;   // optional; comma-separated branch names (URL-encoded each)
  users?: string;      // optional; comma-separated user emails (URL-encoded each)
  attr?: string | string[]; // optional; repeatable attribute filter, attr=<key>:<op>[:<value>]
}
interface TimelineSession {
  sessionId: string;
  startTime: string;       // ISO 8601
  endTime: string;         // ISO 8601
  firstPrompt: string | null;
  gitBranch: string | null;
  userEmail: string | null;
  group: string | null;    // null when groupBy is absent; branch/email when groupBy is set
  workTimeMs: number;      // session_stats.work_time_ms: per-prompt active time from the claude transcript (0 if no claude log)
  totalCost: number | null; // USD cost computed from token usage × model_pricing; null if model unknown
  fileStatsByCategory: Record<string, { files: number; bytes: number }>; // per-category file read stats; `bytes` = what the Read calls put into the context: the `String.length` of the tool-result text (UTF-16 code units, not UTF-8 bytes; incl. the line-number prefixes), not the size of the file on disk; every Read with a `file_path` counts toward `files`, failed and repeated Reads included — by design (2026-10-24; `computeToolResultBytes` in `server/src/logs/claude-extractor.ts`); keys are category names from RepoConfig (e.g. "code", "docs"); resolved using the effective config for the caller's scope
  // Both TREE-scoped: the session AND every sub-agent session below it at any depth,
  // summed from the per-node session_stats rows by session-tree-metrics.sql.ts →
  // treeMetricsCte(), plus the root's raw-JSONB fallback when the root has no session_stats
  // row (never on top of a rollup that already counted it — see withOwnFallback). Root-only
  // figures would be the root transcript only, i.e. 0 for a Workflow-driven session whose sub-agents
  // did all the editing. Every consumer of the two (analytics Files/Productivity charts,
  // linesPerHour, costPerLine, the productivity report) is tree-scoped.
  filesEditedWritten: number; // Edit + Write + MultiEdit tool CALL count (not distinct files)
  linesChanged: number;    // lines in new_string (Edit) + content (Write) + edits[].new_string (MultiEdit)
  // The root-only figures, kept additively for a surface that wants the
  // own/tree split. Never add these to the two above — they are already included (double count).
  filesEditedWrittenOwn: number;
  linesChangedOwn: number;
  imageCount: number;      // base64 images in user tool_result messages
  imageTotalBytes: number; // decoded bytes of those images (base64.length * 3/4)
  mcpCallsTotal: number;          // total mcp__* tool_use calls in the session
  mcpCallsByServer: Record<string, number>; // per-server call counts (server name → count)
  logLineCount: number;    // total raw log event count for the session (proxy for prompt activity)
  isFavorite?: boolean;    // true when the authenticated user has favorited this session
  // Cache traffic, always present, default 0 — backs the "Cache Read Ratio" analytics
  // view. The root/descendant pair is reported side by side, never blended: descendant* sums
  // EVERY recursive descendant sub-agent (descendantSessionsCte, depth > 0), not a
  // single-level parent_session_id match. The client computes the ratio itself as
  // ratio-of-sums (see llm-call-math.md § 8) — the endpoint returns tokens only.
  cacheReadTokens: number;            // COALESCE(ss.cache_read_tokens, se.cache_read_tokens, 0)
  cacheWriteTokens: number;           // COALESCE(ss.cache_write_tokens, se.cache_write_tokens, 0)
  descendantCacheReadTokens: number;  // SUM over descendant_sessions WHERE depth > 0
  descendantCacheWriteTokens: number; // SUM over descendant_sessions WHERE depth > 0
  // The three new billing inputs, selected next to cacheWriteTokens from the same
  // COALESCE(session_stats, raw-JSONB CTE) pair, always present, default 0.
  webSearchRequests: number;  // Σ usage.server_tool_use.web_search_requests over deduped
                              // assistant messages; priced PER REQUEST (web_fetch_requests is not billed)
  inputTokensFast: number;    // SUBSET of inputTokens billed at usage.speed = 'fast' — not extra tokens
  outputTokensFast: number;   // SUBSET of outputTokens billed at usage.speed = 'fast' — not extra tokens
  costUnavailableReason: 'unknown-model' | null; // same semantics as on RepositorySession above
}
response: TimelineSession[]
// Errors:
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601;
//          groupBy not 'branch'/'user'/'attr:<known key>'; groupBy=branch + branches filter;
//          groupBy=user + users filter; groupBy=attr:<key> + an attr filter on the same key
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found


// GET /api/v1/repositories/:repoId/analytics/change-surface — 200
// The change-surface analytics timeline. Backs the "Change Surface" analytics view.
//
// Parameter parsing mirrors /analytics/timeline exactly — required startDate/endDate,
// single-day UTC widening, branch/user/attr:<key> grouping and the same
// "cannot combine groupBy=branch with a branches filter" guards — plus `bucket`.
//
// EVERY number here comes out of the same ChangeSurfaceAggregateService.build() call
// that /reports/change-surface makes; the report merely pins bucket:'week'. That is why
// the chart and the report cannot disagree.
//
// groupBy=attr:<key> FANS OUT: a root session whose `string[]`-typed attribute
// carries N resolved values appears in `groups[]` entries for every one of them (via
// changed-paths.sql.ts's flattened root_id/group_key VALUES join — each of the root's fact
// rows is joined once per value), not folded into one comma-joined group.
interface GetChangeSurfaceTimelineQuery {
  teamId?: number;
  startDate: string;                     // required, ISO 8601
  endDate: string;                       // required, ISO 8601
  groupBy?: 'none' | 'branch' | 'user' | `attr:${string}`;
  branches?: string;                     // comma-separated
  users?: string;                        // comma-separated
  attr?: string | string[];              // repeatable attribute filter
  bucket?: 'hour' | 'day' | 'week';      // overrides the range-derived default
}
interface ChangeSurfaceBucket {
  bucketStart: string;                   // ISO timestamp of the date_trunc boundary
  sessions: number;
  sessionIds: string[];                  // drives the bar -> SessionModal click-through
  concentration: number | null;          // null -> render n/a, NEVER a 0 bar
  changedFiles: number;
  foldersTouched: number;
  topLevelModules: number;
  linesAdded: number;
  linesRemoved: number;
}
response: {
  bucket: 'hour' | 'day' | 'week';       // the bucket actually used
  buckets: ChangeSurfaceBucket[];
  groups: { key: string; label: string; buckets: ChangeSurfaceBucket[] }[] | null;
}
// The default bucket comes from CHANGE_SURFACE_BUCKET_THRESHOLDS (span <= 3d -> hour,
// <= 60d -> day, otherwise week). Each bucket and each group is its own union
// recomputation, so a group's buckets do not sum to the repo-wide ones.
// Errors:
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601;
//          groupBy not one of none/branch/user/attr:<known key>; groupBy=branch + branches
//          filter; groupBy=user + users filter; bucket not one of hour/day/week
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/analytics/work-time — 200
// Returns per-day work-time buckets (in minutes) within a date range.
// Zero-fills days that have no session activity so the full range is always present.
// Optionally groups by branch, user or a resolved session attribute; each (day × group) pair
// appears as its own row.
//
// Each session's work interval is [start_time, start_time + work_time_ms] (clamped to
// end_time). Overlapping/concurrent sessions within the same day+group are merged (union of
// intervals, split at day boundaries) before summing, so workTimeMinutes reflects real
// elapsed time — it is never inflated by double-counting concurrent sessions and can never
// exceed 1440 minutes for a single day+group.
//
// groupBy=attr:<key> FANS OUT: a `string[]`-typed attribute's N resolved values
// duplicate a session's interval into N groups' sweep-line merges (CROSS JOIN LATERAL over
// attrGroupKeysSql(), a raw-SQL set-returning form of attributeGroupLabels() — this endpoint
// buckets entirely in SQL with no per-row TS pass) — the session's full work time is counted
// in each of its groups, never split between them.
//
// Access control and same-day normalisation identical to /analytics/timeline.
interface GetAnalyticsWorkTimeQuery {
  teamId?: number;     // optional; activates team-based access check
  startDate: string;   // required; ISO 8601
  endDate: string;     // required; ISO 8601
  groupBy?: 'branch' | 'user' | `attr:${string}`; // optional; cannot combine with the corresponding filter
  branches?: string;   // optional; comma-separated branch names (URL-encoded each)
  users?: string;      // optional; comma-separated user emails (URL-encoded each)
  attr?: string | string[]; // optional; repeatable attribute filter, attr=<key>:<op>[:<value>]
}
interface WorkTimeBucket {
  day: string;                 // ISO 8601 — start of the UTC calendar day
  group: string | null;        // null when groupBy absent; branch/email when groupBy set
  workTimeMinutes: number;     // merged (non-overlapping) minutes of session activity that day (0 when none)
}
response: WorkTimeBucket[]
// Errors:
//   400 — same rules as /analytics/timeline
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/reports/executive-summary — 200
// Backs the Reports tab's "Executive Summary" document (ReportsController,
// server/src/logs/reports/reports.controller.ts + executive-summary.service.ts).
// Cost is a two-phase rollup: each session's own session_stats tokens (Phase A)
// PLUS the summed cost of every descendant sub-agent session under it (Phase B,
// via the descendantSessionsCte/subagent_costs pattern) — total_cost is redefined
// once as (ownCost ?? 0) + subagentCost before any aggregate is built, so
// totalCost/weeklyBuckets/modelMix/topSessions/engineerBreakdown all read the
// same rolled-up value (sum(engineerBreakdown[].totalCost) === totalCost, same
// for weeklyBuckets). excludedSessionCount/excludedModels are computed from the
// pre-rollup own-pricing check only (unrelated to whether the rolled-up total
// ends up non-zero).
// when a session's root has an OTEL cost (logs.log_type='claude-otel'), that
// value REPLACES (ownCost ?? 0) + subagentCost outright for that session — it already
// covers the whole descendant tree, so it is never added on top of the computed
// rollup. excludedSessionCount/excludedModels still reflect the pre-rollup own-pricing
// check regardless of OTEL availability (see the excludedSessionCount comment in
// executive-summary.service.ts) — a session can be OTEL-priced (contributing real
// cost to totalCost) while still counting toward excludedSessionCount if its own model
// has no model_pricing match, since that count is a model-coverage-gap signal, not a
// "did this session get priced at all" signal.
//
// Access control identical to /analytics/timeline (team visibility gate applies).
interface GetExecutiveSummaryQuery {
  teamId?: number;     // optional; activates team-based access check
  startDate: string;   // required; ISO 8601
  endDate: string;     // required; ISO 8601
  branches?: string;   // optional; comma-separated branch names (URL-encoded each)
  users?: string;      // optional; comma-separated user emails (URL-encoded each)
}
interface ExecutiveSummaryWeekBucket {
  weekStart: string;    // ISO date (yyyy-mm-dd) — Monday of the ISO week, UTC;
                         // the first/last bucket is shortened to the selected
                         // date range instead of overflowing into adjacent weeks
  sessionCount: number;
  totalCost: number;
}
interface ExecutiveSummaryModelMixEntry {
  model: string;       // 'unknown' when the session has no recorded model
  sessionCount: number;
  share: number;        // sessionCount / totalSessions, 0 when totalSessions is 0
  cost: number;          // sum of this model's rows' rolled-up total_cost (root session's own model only)
  costShare: number;     // cost / report totalCost; 0 when totalCost is 0
}
interface ExecutiveSummaryTopSession {
  startTime: string;    // ISO timestamp; sessions ordered top 5 by cost descending
  userEmail: string;
  branch: string | null;
  workTimeMs: number;
  cost: number;          // rolled-up total_cost (own cost + descendant sub-agent cost)
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUnavailableReason: 'unknown-model' | null; // same semantics as on RepositorySession —
                        // 'unknown-model' when this session's own model has no model_pricing match, so
                        // the report row and its PDF twin show the no-pricing badge instead of a figure
                        // that silently omits this session's spend. Independent of the report-level
                        // excludedSessionCount / excludedModels, which stay the aggregate disclosure
                        // over the same underlying signal.
}
interface ExecutiveSummaryEngineerEntry {
  userEmail: string;
  sessionCount: number;
  share: number;              // totalCost for this user / report totalCost; 0 when totalCost is 0
  totalCost: number;
  avgCostPerSession: number;  // 0 when sessionCount is 0
  avgSessionLengthMs: number; // this user's totalWorkTimeMs / sessionCount; 0 when sessionCount is 0
  costPerLine: number;        // same formula as report-level avgCostPerLine, scoped to this user
  linesPerHour: number;       // same formula as report-level avgLinesPerHour, scoped to this user
  subAgentsPerSession: number; // sum(descendant-session count across this user's root sessions) / sessionCount; 0 when none
}
interface ExecutiveSummaryPreviousPeriod {
  totalCost: number;
  totalSessions: number;
  activeUsers: number;
  avgCostPerSession: number;
}
// Sits alongside (not inside) totalCost — its own KPI
// tile. Scoped by joining turn_end_advisor_runs.session_id directly to sessions/logs for
// the SAME repo/date/branch/user/owner filters the rest of the report uses (own private
// computeAdvisorSpend() method, called once, not per previousPeriod window). No
// hook_service marker scan needed — turn_end_advisor_runs.session_id already IS the
// invoking session (unlike Part B's analogous attributionSpend section).
interface ExecutiveSummaryAdvisorSpend {
  evaluationCount: number;            // COUNT(*) of run rows in scope, any outcome (rows only exist for actual attempts)
  distinctInvokingSessions: number;   // COUNT(DISTINCT session_id) in scope
  costUsd: number;                    // SUM(turn_end_advisor_runs.cost_usd) in scope; own cost columns, never joined via session_stats
}
interface ExecutiveSummaryReport {
  totalCost: number;
  totalSessions: number;
  activeUsers: number;       // distinct users with a session whose startTime falls in range
  teamSize: number | null;   // team_members count for teamId; null when no teamId (personal repo view)
  avgCostPerSession: number; // 0 when totalSessions is 0
  // TREE-scoped, response SHAPE unchanged but the VALUES changed: every eligible
  // session now contributes its own lines plus those of every sub-agent below it
  // (session-tree-metrics.sql.ts → treeMetricsCte(), folded in Phase B via withOwnFallback).
  // totalLinesChanged and avgLinesPerHour therefore rise, avgCostPerLine and the per-engineer
  // costPerLine fall (same cost, larger line denominator) — both sides of every ratio are
  // tree-scoped now, where before they mixed tree cost with root-only lines.
  totalLinesChanged: number;
  avgCostPerLine: number;    // totalCost / totalLinesChanged; 0 when totalLinesChanged is 0
  avgLinesPerHour: number;   // totalLinesChanged / (totalWorkTimeMs/3600000); 0 when no work time
  avgSessionLengthMs: number; // totalWorkTimeMs / totalSessions; 0 when totalSessions is 0
  excludedSessionCount: number; // count of eligible sessions whose OWN model had no model_pricing match (pre-rollup check)
  excludedModels: string[];     // distinct unpriced model identifiers behind excludedSessionCount; [] when 0
  previousPeriod: ExecutiveSummaryPreviousPeriod | null; // immediately preceding window of equal length; null when that window has 0 sessions
  weeklyBuckets: ExecutiveSummaryWeekBucket[];
  modelMix: ExecutiveSummaryModelMixEntry[];
  topSessions: ExecutiveSummaryTopSession[]; // top 5 by cost desc; no prompt text — date/engineer/branch/duration/cost/model/tokens only
  engineerBreakdown: ExecutiveSummaryEngineerEntry[]; // grouped by session user_email, sorted by totalCost desc
  advisorSpend: ExecutiveSummaryAdvisorSpend; // sibling KPI section, unrelated to totalCost's rollup
}
response: ExecutiveSummaryReport
// Errors:
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/reports/cache-read-ratio — 200
// Backs the Reports tab's "Cache Read Ratio" document (ReportsController +
// server/src/logs/reports/cache-read-ratio.service.ts).
//
// Access control, visibility resolution and date handling are identical to
// /reports/executive-summary (team visibility gate applies).
//
// Every aggregate is reported TWICE and side by side (never blended): `root` is the root
// session's own session_stats tokens, `withDescendants` adds every recursive descendant
// sub-agent (descendantSessionsCte, depth > 0). The one exception is `causes`, which is
// deliberately root-only.
//
// Every ratio is a ratio-of-sums — SUM(read) / (SUM(read) + SUM(write)) — never a mean of
// per-session ratios, and is `null` (not 0) when the denominator is 0. See llm-call-math.md § 8.
//
// The `causes` block is computed against THIS requester's effective threshold: in team
// view (teamId) team T's team_repo_config → the server constant, read from T's
// session_cause_stats rows; in personal view the personal repo_config → the lowest-id team's
// config → the server constant, read from the caller's own rows (thresholdSource says which). Two callers on the same repo with different thresholds get
// different splits from identical request parameters, while totalCreationTokens is identical.
//
// groupBy=attr:<key> FANS OUT: a session whose `string[]`-typed attribute carries N
// resolved values contributes its full row to N `groups[]` entries, not one comma-joined
// entry — a ratio-of-sums is unaffected by this uniform duplication (only the group's
// `sessionCount` is inflated; see CacheRatioScopeSummary's caveat on the client).
interface GetCacheReadRatioQuery {
  teamId?: number;     // optional; activates team-based access check
  startDate: string;   // required; ISO 8601
  endDate: string;     // required; ISO 8601
  groupBy?: 'none' | 'branch' | 'user' | `attr:${string}`; // optional, default 'none'; whitelisted (any other value 400s)
  branches?: string;   // optional; comma-separated branch names (URL-encoded each)
  users?: string;      // optional; comma-separated user emails (URL-encoded each)
  attr?: string | string[]; // optional; repeatable attribute filter, attr=<key>:<op>[:<value>]
}
interface CacheRatioTokens {
  sessionCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  ratio: number | null;              // ratio-of-sums; null when read + write === 0
}
interface CacheRatioScopeTotals extends CacheRatioTokens {
  cacheReadCost: number | null;      // Σ tokens / 1e6 × that session's rate; null when no session in scope was priced
  // The SUM OF THE TWO TTL TERMS —
  //   Σ (cacheWrite5mTokens / 1e6 × price_cache_w_5m + cacheWrite1hTokens / 1e6 × price_cache_w_1h)
  // — each bucket at its own rate, never both at one flat cache-write rate. The token base is
  // cacheWrite5mTokens + cacheWrite1hTokens = cacheWriteTokens (invariant).
  // Per-session the service carries the two rates as priceCacheWrite5m / priceCacheWrite1h;
  // both are null together, from the same missing pricing row.
  cacheWriteCost: number | null;
  undefinedRatioSessionCount: number; // sessions with a zero denominator (excluded from the ratio)
}
interface CacheRatioCauseEntry { turns: number; creationTokens: number; share: number }
interface CacheReadRatioReportData {
  root: CacheRatioScopeTotals;
  withDescendants: CacheRatioScopeTotals;
  // Fixed UTC day buckets regardless of groupBy; `bucket` is a YYYY-MM-DD key
  buckets: Array<{ bucket: string; root: CacheRatioTokens; withDescendants: CacheRatioTokens }>;
  // Present only when groupBy !== 'none'; per-group token sums equal the top-level totals
  groups?: Array<{ group: string; root: CacheRatioScopeTotals; withDescendants: CacheRatioScopeTotals }>;
  causes: {
    scope: 'root';                   // always root-only, by design
    thresholdTokens: number;         // the requester's effective highCacheCreationThreshold
    thresholdSource: 'user' | 'team' | 'default';
    staleSessionCount: number;       // sessions whose stored cause row used a different threshold
    sessionsWithoutCauseData: number; // sessions with no session_cause_stats row for the resolved scope
    totalCreationTokens: number;     // = root.cacheWriteTokens; the three entries sum to it
    compaction: CacheRatioCauseEntry;
    fileReread: CacheRatioCauseEntry;
    unattributed: CacheRatioCauseEntry;
  };
}
response: CacheReadRatioReportData
// Errors:
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601;
//          groupBy not one of none/branch/user/attr:<known key>
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found


// GET /api/v1/repositories/:repoId/reports/change-surface — 200
// Backs the Reports tab's "Change Surface" document (ReportsController +
// server/src/logs/reports/change-surface-report.service.ts).
//
// Same teamId/startDate/endDate/branches/users/attr params and the same fixed-vs-attr:
// groupBy split as /reports/harness-usage (CHANGE_SURFACE_GROUP_BY_VALUES). Access
// control, visibility resolution and date handling identical to the other reports.
//
// There is NO scope toggle: everything is tree-scoped, always.
//
// groupBy=attr:<key> FANS OUT: a root session whose `string[]`-typed attribute
// carries N resolved values appears in `groups[]` entries for every one of them (same
// changed-paths.sql.ts VALUES-join fan-out /analytics/change-surface uses — shared service),
// not folded into one comma-joined group.
interface GetChangeSurfaceReportQuery {
  teamId?: number;
  startDate: string;                     // required, ISO 8601
  endDate: string;                       // required, ISO 8601
  groupBy?: 'none' | 'branch' | 'user' | `attr:${string}`;
  branches?: string;
  users?: string;
  attr?: string | string[];
}
interface ChangeSurfaceMedians {         // EXACT (lower) medians, over change-having sessions only
  changedFiles: number;
  foldersTouched: number;
  concentration: number | null;
  filesPerFolder: number;
  topLevelModules: number;
  folderEntropyNorm: number;
  singleFileFolderShare: number;
}
interface ChangeSurfaceInventory {       // the repo_code_inventory snapshot the % rows divide by
  capturedAt: string;                    // newest snapshot with captured_at <= endDate
  branch: string | null;
  trackedFiles: number;
  trackedLines: number;
  trackedBinaryFiles: number;
}
interface ChangeSurfaceReportData {
  repo: ChangeSurfaceAggregate;          // the period's union
  sessionsWithChanges: number;
  noChangeSessions: number;              // excluded from the medians, reported separately
  perSessionMedian: ChangeSurfaceMedians | null;
  inventory: ChangeSurfaceInventory | null;
  shareOfTrackedFiles: number | null;    // null -> "n/a · denominator unavailable", NEVER 0%
  shareOfTrackedLines: number | null;    // diff-based linesAdded / trackedLines
  groups:
    | {
        key: string;
        label: string;
        sessions: number;
        aggregate: ChangeSurfaceAggregate;
        shareOfTrackedFiles: number | null;
      }[]
    | null;
  buckets: { bucketStart: string; sessions: number; concentration: number | null }[]; // weekly
  truncated: boolean;                    // CHANGE_SURFACE_MAX_SCOPE_ROWS hit -> partial union
}
response: ChangeSurfaceReportData
// Group rows are each their own union recomputation and DO NOT sum to `repo` — two branches
// that both touched src/app.ts each count it. The report prints that caveat inline.
// Errors:
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601;
//          groupBy not one of none/branch/user/attr:<known key>
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/reports/harness-usage — 200
// Backs the Reports tab's "Harness Usage" document (ReportsController +
// server/src/logs/reports/harness-usage.service.ts). Cache-read-ratio-shaped: same
// teamId/startDate/endDate/branches/users query params, own `groupBy` whitelist.
//
// Access control, visibility resolution and date handling are identical to
// /reports/executive-summary and /reports/cache-read-ratio (team visibility gate applies).
//
// One row per harness element (skill/rule/MCP server/tool) the repo(s) have ever self-reported
// via the hook's harness-snapshot / harness-snapshot-ref lines (hook 2.22.0+; see
// docs/knowledgebase/hook-system-overview.md's "Context injection" — the four older
// skill-definitions/agent-definitions/mcp-config/system-context events are no longer sent or
// read), merged with real per-session usage/token facts from session_harness_usage. `harness_elements` supplies
// every zero-usage row; a usage fact with no matching inventory row still gets a row (e.g. an
// old-hook MCP tool call with no self-reported inventory).
//
// groupBy=attr:<key> FANS OUT: a root session whose `string[]`-typed attribute
// carries N resolved values is seeded into (and any of its usage facts bucketed into) every
// one of the N groups, not one comma-joined group — its full usage counted in each.
interface GetHarnessUsageQuery {
  teamId?: number;     // optional; activates team-based access check
  startDate: string;   // required; ISO 8601
  endDate: string;     // required; ISO 8601
  groupBy?: 'none' | 'branch' | 'user' | `attr:${string}`; // optional, default 'none'; whitelisted (any other value 400s)
  branches?: string;   // optional; comma-separated branch names (URL-encoded each)
  users?: string;      // optional; comma-separated user emails (URL-encoded each)
  attr?: string | string[]; // optional; repeatable attribute filter, attr=<key>:<op>[:<value>]
}
interface HarnessUsageRow {
  kind: 'skill' | 'rule' | 'mcp' | 'tool';
  name: string;
  mcpServer: string | null;        // non-null only for tool-kind rows sourced from an MCP server
  mcpConnected: boolean | null;    // kind='mcp' only; null = never reported (old hook / no data yet)
  uses: number;
  inputTokens: number;
  outputTokens: number;
  countPct: number;                // 0..100, within-kind, within-slice (repo-wide or one group)
  tokenPct: number;
  schemaSizeTokens: number | null; // null = not applicable (skill/rule/built-in-tool/MCP-server row);
                                    // whether '-' should render is schemaSizeReported, not this field's nullness
  schemaSizeReported: boolean;     // false => client renders '-', never 0/null
  firstSeen: string | null;        // ISO timestamp; null for built-in tools and usage-only rows
  lastSeen: string | null;
  removed: boolean;                // lastSeen older than the repo's latest inventory self-report
  source: 'project' | 'plugin' | null; // kind='skill' only; null = older hook, or not a skill row
}
interface HarnessUsageGroup { group: string; rows: HarnessUsageRow[] }
interface HarnessUsageReportData {
  inventoryReported: boolean;      // repositories.harness_inventory_reported_at IS NOT NULL,
                                    // OR'd across every repo id in scope; false => empty state
  elementCount: number;
  neverUsedCount: number;          // rows in `rows` (or, when grouped, per-group) with uses === 0
  totalUses: number;               // excludes mcp-kind rows (their count is a rollup of tool children)
  sessionCount: number;            // root sessions in scope (date/branch/user filters) — replaces
                                    // an earlier "total tokens" tile that double-counted skill/rule
                                    // context injection across turns
  rows: HarnessUsageRow[];         // repo-wide; empty when grouped
  groups?: HarnessUsageGroup[];    // present iff groupBy !== 'none'
}
response: HarnessUsageReportData
// Errors:
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601;
//          groupBy not one of none/branch/user/attr:<known key>
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/reports/attribution-breakdown — 200
// Backs the Reports tab's "Attribute Breakdown" document (ReportsController +
// server/src/logs/reports/attribution-breakdown.service.ts).
//
// Access control, visibility resolution and date handling are identical to
// /reports/executive-summary (team visibility gate applies). No `groupBy` — this report
// already breaks every attribute into its own section.
//
// Copies cache-read-ratio.service.ts's two-phase shape: Phase A is a
// cheap scan of each in-scope session's own cost plus its whole session_attribution.values
// object; Phase B is a cost rollup (recursive descendants via descendantSessionsCte,
// OTEL-preferred via resolveSessionTotalCost()) keyed on Phase A's session_row_ids, the same
// pattern executive-summary.service.ts's Phase B uses.
//
// One section per this repo's resolved attribute definition, fixed by declared type:
//   - boolean:            exactly 4 rows — 'true', 'false', 'Not determined', 'Unattributed';
//                          no ranking.
//   - string / number:    a ranked table, top 15 by session count, tail collapsed into one
//                          'Other' row (summed sessions/share/cost).
//   - string[]:           same ranked-table shape, but each session's deduplicated array
//                          elements each contribute to their own value's bucket — fanOut:
//                          true, and that section's shares can legitimately sum above 100%.
// 'Not determined' (row exists, key null/absent/orphaned) and 'Unattributed' (no
// session_attribution row at all) are always their own rows, in every layout, never folded
// into 'Other'. Every row's `share` is against the report's own `totalSessionCount`, never a
// per-section total.
interface GetAttributionBreakdownQuery {
  teamId?: number;     // optional; activates team-based access check
  startDate: string;   // required; ISO 8601
  endDate: string;     // required; ISO 8601
  branches?: string;   // optional; comma-separated branch names (URL-encoded each)
  users?: string;      // optional; comma-separated user emails (URL-encoded each)
  attr?: string | string[]; // optional, repeatable; '<key>:<op>[:<value>]'
}
interface AttributionBreakdownRow {
  value: string;        // the stringified attribute value, or 'Other' / 'Not determined' / 'Unattributed'
  sessionCount: number;
  share: number;        // sessionCount / report-level totalSessionCount
  costUsd: number;
}
interface AttributionBreakdownSection {
  key: string;
  label: string;
  type: 'string' | 'string[]' | 'boolean' | 'number';
  fanOut: boolean;      // true only for string[] — rows can sum above 100% of totalSessionCount
  rows: AttributionBreakdownRow[];
}
interface AttributionBreakdownReportData {
  totalSessionCount: number;
  totalCostUsd: number;
  orphanedSessionCount: number; // sessions with >=1 orphaned attribute value; disclosed once, independent of each section's own fold
  sections: AttributionBreakdownSection[]; // one per resolved attribute definition, in definition order
}
response: AttributionBreakdownReportData
// Errors:
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601;
//          malformed attr= filter; unknown attribute key; operator/type mismatch
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/reports/attribution-usage — 200
// Backs the Reports tab's "Attribute Extraction Usage" document (ReportsController +
// server/src/logs/reports/attribution-usage.service.ts).
//
// Access control, visibility resolution and date handling are identical to
// /reports/executive-summary (team visibility gate applies). supportsAttributeFilter: false
// — no attr= here; population is session_attribution_runs (every
// evaluation ATTEMPT, including 'failed' ones with no values to filter on), not sessions
// carrying resolved values. Date scope applies to each run's own `startedAt`, not the
// invoking session's start time — this population is evaluation events, which can span many
// days for one repeatedly re-evaluated session.
//
// evaluationCount counts every run row in scope; distinctSessionCount counts unique invoking
// sessions among those runs. evaluationCount >= distinctSessionCount is expected and normal,
// not a data-quality signal — a session is re-evaluated at each new prompt watermark, so it
// contributes one run per evaluation, not one run total.
interface GetAttributionUsageQuery {
  teamId?: number;     // optional; activates team-based access check
  startDate: string;   // required; ISO 8601
  endDate: string;     // required; ISO 8601
  branches?: string;   // optional; comma-separated branch names (URL-encoded each)
  users?: string;      // optional; comma-separated user emails (URL-encoded each)
  outcome?: string | string[]; // optional, repeatable; 'applied' | 'ignored_stale' | 'failed'
}
interface AttributionUsageOutcomeRow {
  outcome: 'applied' | 'ignored_stale' | 'failed';
  count: number;
  costUsd: number;
}
interface AttributionUsageDayPoint {
  date: string;  // UTC YYYY-MM-DD
  count: number;
}
interface AttributionUsageTopSession {
  sessionId: string; // sessions.session_id — the invoking session's own transcript id
  evaluationCount: number;
  costUsd: number;
}
interface AttributionUsageReportData {
  evaluationCount: number;       // every run row in scope, including 'failed'
  distinctSessionCount: number;  // unique invoking sessions among those runs; always <= evaluationCount
  totalCostUsd: number;
  avgCostUsd: number;            // totalCostUsd / evaluationCount, 0 when there are no runs in scope
  outcomeBreakdown: AttributionUsageOutcomeRow[]; // always all 3 fixed outcomes, count:0 for one with no runs
  byDay: AttributionUsageDayPoint[]; // ascending by date; only days with >=1 run appear (no gap-filling)
  topReevaluatedSessions: AttributionUsageTopSession[]; // top 10 by evaluation count, cost desc tie-break
}
response: AttributionUsageReportData
// Errors:
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601;
//          outcome not one of applied/ignored_stale/failed
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// =========================================================================================
// Usage analytics (8 endpoints, 4 DTOs)
// =========================================================================================
//
// GET /api/v1/repositories/:repoId/analytics/tools           → ToolAnalyticsResponse
// GET /api/v1/repositories/:repoId/analytics/tokens          → TokenAnalyticsResponse
// GET /api/v1/repositories/:repoId/analytics/productivity    → ProductivityAnalyticsResponse
// GET /api/v1/repositories/:repoId/analytics/active-sessions → ActiveSessionsResponse
// GET /api/v1/repositories/:repoId/reports/tool-analytics        → ToolAnalyticsResponse
// GET /api/v1/repositories/:repoId/reports/token-usage           → TokenAnalyticsResponse
// GET /api/v1/repositories/:repoId/reports/productivity-counters → ProductivityAnalyticsResponse
// GET /api/v1/repositories/:repoId/reports/active-sessions       → ActiveSessionsResponse
//
// The four analytics/* routes live on UsageAnalyticsController
// (server/src/logs/analytics/usage-analytics.controller.ts); the four reports/* routes are on
// ReportsController. Each reports/* route delegates to the SAME service as its analytics/*
// counterpart and returns a byte-identical body (asserted by an e2e test), so a report document
// can never disagree with its analytics view.
//
// Access control, team-visibility resolution and date handling are identical to
// /reports/executive-summary. startDate and endDate are REQUIRED.
//
// Scope: each figure covers the filtered ROOT sessions plus every recursive descendant sub-agent
// (descendantSessionsCte), because sub-agents hold ~62% of all tool_use blocks — a root-only
// figure would report near-zero tools for an agent-driven session. Each root's tree is counted
// exactly once. No endpoint here parses logs.body; all read pre-computed session_stats /
// session_tool_stats columns.
interface UsageAnalyticsQuery {
  teamId?: number;     // optional; activates team-based access check
  startDate: string;   // required; ISO 8601
  endDate: string;     // required; ISO 8601
  branches?: string;   // optional; comma-separated branch names (URL-encoded each)
  users?: string;      // optional; comma-separated user emails (URL-encoded each)
  limit?: number;      // active-sessions ONLY; default 100, max 500 (out of range → 400)
}

type DurationSource = 'toolUseResult' | 'taskTotal' | 'timestampDelta';

interface ToolAnalyticsRow {
  tool: string;                  // full name, e.g. 'Bash' or 'mcp__postgres__query'
  mcpServer: string | null;      // 'postgres' for an mcp__ tool, else null
  calls: number;
  successes: number;
  failures: number;              // ONLY where the matching tool_result had is_error === true
  unresolved: number;            // no result, or rejected / permission-denied / interrupted
  failureRate: number | null;    // failures / (successes + failures); null when nothing resolved
  durationCoveredCalls: number;  // numerator of "over N of M calls"; M is `calls`
  durationP50Ms: number | null;
  durationMaxMs: number | null;
  durationMeanMs: number | null;
  durationApproximate: boolean;  // true at repo scope (histogram-interpolated p50)
  durationBySource: Record<DurationSource, number>;
  parallelBatchCalls: number;    // calls in a wall-clock-overlapping batch
}
// NOTE: there is deliberately NO summed "total tool time" field anywhere in this DTO —
// parallel tool_use batches run concurrently, so their durations overlap.
interface ToolAnalyticsResponse {
  tools: ToolAnalyticsRow[];     // combined ranking, call count DESC
  mainAgent: ToolAnalyticsRow[]; // descendant depth 0 — the root session's own calls
  subAgent: ToolAnalyticsRow[];  // descendant depth > 0
  mcpServers: { server: string; calls: number; failures: number; unresolved: number }[];
  totalCalls: number;
  parallelBatchCalls: number;
}

interface TokenTotals {
  input: number; output: number; cacheRead: number; cacheCreation: number;
  cacheWrite5m: number; cacheWrite1h: number;   // reported separately, NEVER summed together
}
interface TokenAnalyticsResponse {
  totals: TokenTotals;
  byServiceTier: ({ tier: string } & TokenTotals)[];  // includes the 'unknown' bucket
  buckets: ({ bucket: string } & TokenTotals)[];      // per UTC day of the root's start time
}
// Totals follow each call's top-level message.usage (llm-call-math.md). The per-iterations
// breakdown is session-scope only, computed client-side, and never added to any total.

interface ProductivityAnalyticsResponse {
  totals: {
    linesAdded: number;        // DIFF-BASED, not session_stats.lines_changed. Source is
                               // toolUseResult.structuredPatch when the transcript has one;
                               // otherwise a real line diff of the Edit/MultiEdit
                               // input's old_string vs new_string, which is what gives
                               // workflow-spawned agents coverage at all. Write is never
                               // covered by the fallback (no prior content in its input), nor
                               // is a rejected/errored/unresolved call. No response-shape
                               // change; sessions ingested before this fallback existed
                               // keep their lower figures until recomputed.
    linesRemoved: number;
    commits: number;           // git commit invocations in Bash commands, per invocation
    pullRequests: number;      // gh pr create invocations, per invocation
    diffCoveredCalls: number;  // "over N of M Edit/Write calls"
    diffTotalCalls: number;
  };
  buckets: { bucket: string; linesAdded: number; linesRemoved: number;
             commits: number; pullRequests: number }[];
}
// lines_changed keeps its own definition (lines WRITTEN, no delta, no removals) and every one
// of its consumers, including costPerLine. No view/report/PDF shows both measures at once.

interface ActiveSessionRow {
  sessionId: string; firstPrompt: string | null; userEmail: string; gitBranch: string | null;
  lastActivity: string;     // ISO 8601 — end_time when present, else start_time
  workTimeMs: number; turns: number; totalTokens: number;
  totalCost: number | null; // null (NOT 0) when no model in the tree has a pricing row
  toolCalls: number; linesAdded: number; linesRemoved: number; topTool: string | null;
}
interface ActiveSessionsResponse {
  sessions: ActiveSessionRow[];  // last activity DESC
  limit: number;
  truncated: boolean;            // true when more sessions matched than `limit`
}
// "Active" means recency inside the selected range — transcripts are uploaded after the fact,
// so there is no live-session concept in the data.
// Errors (all eight):
//   400 — teamId not a positive integer; startDate/endDate missing or not ISO 8601;
//          limit out of range (active-sessions only)
//   401 — not authenticated
//   403 — repo exists but caller lacks access
//   404 — repoId not found

// =========================================================================================
// 2026-09-23 — Claude Code version usage (2 endpoints, 1 DTO)
// =========================================================================================
//
// GET /api/v1/repositories/:repoId/analytics/claude-versions → ClaudeVersionUsageResponse
// GET /api/v1/repositories/:repoId/reports/claude-versions   → ClaudeVersionUsageResponse
//
// analytics/* on UsageAnalyticsController, reports/* twin on ReportsController; both call
// ClaudeVersionUsageService.build() and return a byte-identical body. The client calls the
// reports/ twin (fetchClaudeVersionUsageReport in client/src/viewer/api.ts).
// Query: the standard UsageAnalyticsQuery above plus repeatable attr=<key>:<op>:<value> —
// teamId?, startDate, endDate (both required), branches?, users?, attr?. (Deliberately NOT
// the from/to/userId of the original requirement: every report shares fetchUsageAnalytics.)
// Semantics: over the scoped ROOT sessions (loadScopedRootSessions), a session is "checked"
// when its COALESCE(claude_version, claude_version_otel) parses as semver AND a release
// history entry (ai_tool_version_history, tool 'claude-code') existed at its start_time;
// it is "outdated" when that version < the stable dist-tag in effect at session start.
// Users with 0 checked sessions are dropped.
interface ClaudeVersionUsageRow {
  userId: number;
  userEmail: string;
  sessionsChecked: number;
  outdatedSessions: number;
}
interface ClaudeVersionUsageResponse {
  rows: ClaudeVersionUsageRow[]; // outdatedSessions > 0 first, then userEmail ASC
}
// Errors: same as the usage analytics block above (400 bad teamId/dates, 401, 403, 404).

// GET /api/v1/repositories/:repoId/sessions/:sessionId/logs — 200
// Returns the claude log for the primary session plus claude-subagent logs for
// every sub-agent session descended from :sessionId at ANY depth — a recursive lookup over
// parent_session_id, not a single-level match. A sub-agent can itself spawn further sub-agents
// (3+ levels), and each one's parent_session_id points at its true immediate parent, not
// always :sessionId directly; subagentStats uses the same recursive descendant lookup.
// Access control: owner-only, with a team-owner exception. Non-owner callers
// (admins included) receive 403 Forbidden UNLESS the request includes ?teamId and the caller is
// the owner of that team (RepositoriesService.isTeamOwner) — that caller may fetch any
// team member's session logs. Enables the "Session Statistics
// Export" feature (export-scope below) to read another member's full logs.
// Team access modes (2026-09-22, extended 2026-10-12): with ?teamId of a TRANSPARENT team any
// team member gets 200 for any member's session (every member sees everything, raw logs
// included — the old "raw logs stay owner-only" rule no longer applies there). In a RESTRICTED
// team the caller needs the team-owner exception or the adlc-trainer role, and the session
// owner must have acknowledged the disclosure. Membership itself is checked by assertRepoAccess.
// The owner is the user whose artisyn log row is linked to this session.
interface SubagentLog {
  sessionId: string;                  // sub-agent's own session_id (agent ID)
  // True immediate parent session/agent's session_id (sessions.parent_session_id), or null.
  // DB-authoritative — a background-launched agent's completion event can arrive after its
  // parent's own session already ended, so the client cannot always reconstruct real nesting
  // from transcript content (agent_progress / Agent tool_use + toolUseResult completions);
  // this field must be used to build the real descendant tree for cost rollup.
  parentSessionId: string | null;
  logs: Record<string, unknown>[];    // claude-subagent log event array
}
interface WorkflowFinding {
  claim: string;
  confidence: string; // 'high' | 'medium' | 'low' | other
}
interface WorkflowRun {
  taskId: string | null;      // from <task-id> in XML; null when running
  toolUseId: string;          // tool_use.id — join key
  name: string;               // input.name from tool_use
  args: string | null;        // input.args; objects are JSON.stringify'd
  status: 'completed' | 'failed' | 'running';
  durationMs: number | null;  // from usage.duration_ms; null when running
  agentCount: number | null;
  subagentTokens: number | null;
  toolUses: number | null;
  summary: string | null;
  findings: WorkflowFinding[];
  // wf-id extracted from the completion notification's <diagnostics> tag (primary:
  // `resumeFromRunId: '...'`; fallback: the wf-id path segment). null when running
  // (no <diagnostics> exists yet) or unresolvable.
  wfId: string | null;
  // Full multi-level agent linkage for this run: the workflow's direct agents
  // (sessions.workflow_run_id === wfId) plus their own regular Task-tool sub-agents
  // at any depth — NOT a sub-agent's own nested Workflow call (out of scope).
  // "agent-<id>"-prefixed, same format as SubagentLog.sessionId. Resolved
  // server-side (repositories.controller.ts) from the same owner-scoped
  // descendant-session set already computed for `subagents`, so it inherits that
  // endpoint's access control automatically. Empty array when wfId is null,
  // unresolvable, or the session predates the workflow_run_id column (no backfill).
  agentSessionIds: string[];
}
interface SessionLogsResponse {
  main: Record<string, unknown>[];    // claude log event array for the primary session
  subagents: SubagentLog[];           // one entry per sub-agent; empty array when none
                                      // sorted by sub-agent sessionId ascending
                                      // sub-agents with NULL body are omitted (not a 422)
  subagentStats?: Record<string, SubagentStats>; // token totals from session_stats per child session
                                      // each entry also carries webSearchRequests /
                                      // inputTokensFast / outputTokensFast (same subset-of-the-total
                                      // semantics as on TimelineSession). Required by the client's
                                      // Workflow-agent fallback fold in log-parser.ts, which would
                                      // otherwise have to fill TokenBreakdown's three new required
                                      // fields with 0 and under-report fast/web-search spend.
                                      // each entry also carries six optional numeric fields, read straight off that
                                      // child's session_stats row: linesChanged, filesEditedWritten, linesAdded,
                                      // linesRemoved, diffLinesCoveredCalls, diffLinesTotalCalls. Strictly PER-NODE — that
                                      // child's own transcript, never its own descendants — and the map is keyed by EVERY
                                      // recursive descendant, so the client sums it once and adds the root's own walked
                                      // figure to get the tree total (client tree-code-impact.ts). Optional because a client
                                      // may run against an older server without these fields. The select carries the OTEL-only
                                      // EXISTS guard, the same one session-tree-metrics.sql.ts applies, which is what stops
                                      // this client-side sum and the server-side rollup from disagreeing.
                                      // Client twin: SubagentStats in client/src/viewer/api.ts
  workflows: WorkflowRun[];           // workflow runs extracted from the claude log on the server; empty array when none
  turnEndAdvisor: TurnEndAdvisorResult | null; // latest outcome='submitted'
                                      // turn_end_advisor_runs row for this session; null when
                                      // never successfully evaluated. The
                                      // only session-detail surface for the advisor result.
  sessionAttribution: SessionAttributionState; // everything the
                                      // session detail attribution row needs to derive its
                                      // state (feature off -> failed -> unevaluated -> stale ->
                                      // evaluated, in that priority order) without an extra
                                      // fetch.
  harnessSnapshot: HarnessSnapshot | null; // the root session's bound harness snapshot (DD-12),
                                      // shaped exactly as the hook's `harness-snapshot` NDJSON
                                      // line minus its `type` discriminant (DD-1) — see
                                      // "Context injection" in hook-system-overview.md. null when
                                      // the session has no bound snapshot_id, the referenced row
                                      // no longer exists (DD-21's accepted race), or the session
                                      // predates hook 2.22.0 (no backfill, DD-17). Same access
                                      // checks as the rest of this response: owner, team
                                      // scope. Client type: HarnessSnapshot in
                                      // client/src/viewer/api.ts; server type:
                                      // HarnessSnapshotBody in server/src/logs/harness-snapshot.ts.
}
interface HarnessSnapshot {
  snapshotId: string;
  schemaVersion: number;
  perToolDetailSupported: boolean;    // capability flag; NOT part of the snapshotId (DD-2)
  skills: HarnessSnapshotSkill[];
  agents: HarnessSnapshotAgent[];
  mcpServers: HarnessSnapshotMcpServer[];
  systemContext: { totalBytes: number; files: HarnessSnapshotFile[] } | null;
}
interface HarnessSnapshotSkill {
  name: string;                       // plugin entries are "<pluginName>:<name>"
  kind: 'skill' | 'workflow' | 'command';
  source: 'project' | 'user' | 'plugin';
  description: string;
  argumentHint?: string;
  body: string;                       // file text after frontmatter; workflow = whole .js text
  path: string;                       // DD-3 path, shaped per source
  bytes: number;
  contentHash: string;                // sha256 hex of the raw UTF-8 file text
  plugin?: { id: string; name: string; marketplace: string; version: string; gitCommitSha?: string };
}
interface HarnessSnapshotAgent {
  name: string;
  description: string;
  body: string;
  path: string;
  bytes: number;
  contentHash: string;
  source: 'project';
}
interface HarnessSnapshotMcpServer {
  name: string;
  command: string;
  args: string[];
  url?: string;
  configSource: 'project' | 'user';
  connected?: boolean;                // absent on a ref-only resend (the probe never re-ran)
  tools?: { name: string; schemaSizeTokens: number }[];
}
interface HarnessSnapshotFile {
  path: string;
  bytes: number;
  contentHash: string;
  content?: string;                   // rule-file contents only
}
interface TurnEndAdvisorResult {
  generatedAt: string;               // the run's startedAt, ISO 8601
  summaryGeneral: string | null;
  costFactors: string[];
  harnessAdvice: string[];
  model: string | null;              // null when the submitted run had no priced cost
  costUsd: number | null;            // Number()-converted from the numeric-string column
  inputTokens: number;               // defaults to 0, matching the column defaults
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
interface SessionAttributionState {
  enabled: boolean;                  // this repo's resolved sessionAttribution.enabled
  attributes: AttributeDef[];        // this repo's resolved definitions (see the combined
                                      // post-turn-analysis/config endpoint below); present even
                                      // before any evaluation has run, so chips/labels can render
  values: Record<string, string | string[] | boolean | number | null> | null;
                                      // current session_attribution.values, orphaned entries
                                      // stripped; null when never evaluated
  evaluatedWatermark: number | null; // session_attribution.prompt_watermark; null when values is null
  currentWatermark: number | null;   // session_prompt_watermark.prompt_watermark; null when the
                                      // combined config GET has never run for this session.
                                      // currentWatermark > evaluatedWatermark is the "stale" signal
  lastRun: {
    outcome: 'applied' | 'ignored_stale' | 'failed';
    finishedAt: string;              // ISO 8601
    failureReason: string | null;
  } | null;                          // most recent session_attribution_runs row; null when no
                                      // evaluation attempt has ever been recorded. Independent of
                                      // whether it actually changed `values`.
}
response: SessionLogsResponse
// Errors:
//   400, 401 — same as /sessions
//   403 — repo exists but caller lacks access, OR caller is not the session owner
//   404 — session/log not found; primary claude log not found
//   422 — primary claude log row exists but body is NULL

// GET /api/v1/repositories/:repoId/sessions/export-scope — 200
// Lists sessions in scope for the "Session Statistics Export" feature (Settings tab).
// Privileged and deliberately more restrictive than GET .../sessions: the result
// BYPASSES the per-team access mode, returning every matching member's sessions in the date
// range with prompts intact, regardless of whether the team is restricted. Its ONE new
// restriction: members who have not acknowledged the access-mode disclosure are excluded from
// the result set. Authorization: team owner (team view) or repo owner, so no manager or plain
// member ever reaches it.
interface GetSessionsExportScopeQuery {
  teamId?: number;   // optional; when present, activates the team-owner check below
  from: string;       // required; ISO 8601 date-time, inclusive lower bound on logs.startTime
  to: string;         // required; ISO 8601 date-time, inclusive upper bound on logs.startTime
  userId?: number;    // optional; filter to one uploader's sessions
}
interface ExportSessionRow {
  sessionId: string;
  firstPrompt: string | null;
  startTime: string;   // ISO 8601
  endTime: string;      // ISO 8601
  userId: number;
  userEmail: string;
}
response: ExportSessionRow[]
// Access control:
//   - Personal view (no teamId): assertRepoAccess's owner check (same as GET .../sessions).
//   - Team view (teamId present): caller must be that team's owner (RepositoriesService.isTeamOwner)
//     — no admin bypass; a regular team member is 403'd even though assertRepoAccess alone would pass.
// Errors:
//   400 — teamId not a positive integer; from/to missing or not ISO 8601
//   401 — not authenticated
//   403 — repo exists but caller lacks access, OR (team view) caller is not that team's owner
//   404 — repoId not found

// POST /api/v1/repositories/:repoId/recompute-all-sessions — 200
// "Recompute all sessions" maintenance action (Settings tab). Recomputes session_file_stats
// (scoped to team/user config, via the existing recomputeForRepo) and then session_stats
// (unscoped — that table has one row per session, no team/user column) for every session
// linked to this repo.
interface RecomputeAllSessionsQuery {
  teamId?: number; // optional; when present, activates the team-owner check below
}
interface RecomputeAllSessionsResponse {
  recomputed: number; // count of sessions whose session_stats row was recomputed
}
response: RecomputeAllSessionsResponse
// Access control: same shape as export-scope above — team owner when teamId is
// present, else assertRepoAccess's personal owner check.
// Errors:
//   400 — teamId not a positive integer
//   401 — not authenticated
//   403 — repo exists but caller lacks access, OR (team view) caller is not that team's owner
//   404 — repoId not found
```

---

## Repository Export/Import

All routes require a session cookie (`SessionAuthGuard`) AND pass
`RepositoriesService.assertRepoOwnerOrTeamOwner(user, repoId, teamId?)` — stricter than the plain
`assertRepoAccess` used elsewhere under `/api/v1/repositories`: without `teamId` the caller must
personally own the repo; with `teamId` the caller must be that **team's owner** (no admin bypass) —
a regular team member is 403'd even if team session visibility is otherwise enabled for them.
`teamId` must be passed on every request against a team repo (query param on GETs, body field on
POSTs) — omitting it falls through to the personal-owner branch and 403s a legitimate team owner.

```ts
type ExportImportScope = 'all' | 'dateRange' | 'sessionIds';
type ExportImportJobStatus = 'staged' | 'running' | 'done' | 'error';

interface ExportMetaJson {
  formatVersion: number;
  createdAt: string;          // ISO 8601
  sourceHost: string;
  sourceRepoUrl: string;
  sourceRepoContext: { type: 'personal' | 'team'; teamId?: number; teamName?: string };
  description?: string;
  sessionCount: number;
  approxUncompressedBytes: number;
}

// GET /api/v1/repositories/:repoId/export-import/scope — 200
// Session-count + approximate-uncompressed-size preview for one export/import scope.
// Synchronous — no job row is created. approxUncompressedBytes is a
// SUM(octet_length(logs.body::text)) approximation, not a byte-exact re-serialized size.
interface GetScopeSummaryQuery {
  teamId?: number;
  scope: ExportImportScope;
  from?: string;         // ISO 8601; required when scope === 'dateRange'
  to?: string;            // ISO 8601; required when scope === 'dateRange'
  sessionIds?: string;    // comma-separated; required when scope === 'sessionIds'
}
interface ScopeSummary {
  sessionCount: number;
  approxUncompressedBytes: number;
}
response: ScopeSummary
// Errors:
//   400 — teamId not a positive integer; scope not one of the three values;
//         from/to missing for dateRange; sessionIds missing for sessionIds
//   401 — not authenticated
//   403 — repo exists but caller lacks owner access
//   404 — repoId not found

// POST /api/v1/repositories/:repoId/export — 202
// Starts a background export job: creates an exportImportJobs row (kind: 'export',
// status: 'running'), fires RepositoryExportImportService.runExportJob() WITHOUT
// awaiting it, and returns immediately. The job batches matching sessions
// (EXPORT_IMPORT_CHUNK_SIZE = 25), yielding the event loop between batches, and zips
// meta.json + one sessions/<sessionId>/{session.json,claude.jsonl,artisyn.jsonl} per
// session (archiver). Progress/failure is observed purely via the status endpoint below
// (never SSE/WebSocket).
body: {
  teamId?: number;
  scope: ExportImportScope;
  from?: string;          // ISO 8601; required when scope === 'dateRange'
  to?: string;             // ISO 8601; required when scope === 'dateRange'
  sessionIds?: string[];   // required when scope === 'sessionIds'
  description?: string;
}
response: { jobId: string }
// Errors:
//   400 — teamId not a positive integer; scope not one of the three values;
//         from/to missing for dateRange; sessionIds missing for sessionIds
//   401 — not authenticated
//   403 — repo exists but caller lacks owner access
//   404 — repoId not found

// GET /api/v1/repositories/:repoId/export/:jobId/status — 200
// GET /api/v1/repositories/:repoId/import/:jobId/status — 200
// Polls an exportImportJobs row. The export route only resolves kind: 'export' rows;
// the import route only resolves kind: 'import' rows (a still-staged_upload row, not yet
// confirmed, 404s here too). Client polling cadence: 5s (same as AdminUploadQueueTab).
interface GetJobStatusQuery {
  teamId?: number;
}
interface JobStatusResponse {
  status: 'running' | 'done' | 'error'; // 'staged' is possible in principle but never
                                          // observed here — staged_upload rows 404 above
  processed: number;
  total: number;
  errorMessage?: string;
}
response: JobStatusResponse
// Errors:
//   400 — teamId not a positive integer
//   401 — not authenticated
//   403 — repo exists but caller lacks owner access
//   404 — repoId not found; jobId not found, wrong repo, or wrong kind

// GET /api/v1/repositories/:repoId/export/:jobId/download
// Streams the finished export zip via res.download() (mirrors
// admin-panel.controller.ts's downloadLogsArchive()). On completion (success or
// failure of the stream), best-effort unlinks the zip and deletes the job row —
// a downloaded export doesn't linger for the cleanup sweep to reap.
interface DownloadExportQuery {
  teamId?: number;
}
response: <zip file stream>
// Errors:
//   400 — teamId not a positive integer
//   401 — not authenticated
//   403 — repo exists but caller lacks owner access
//   404 — repoId not found; jobId not found or not kind: 'export'
//   409 — job exists but status !== 'done' yet

// POST /api/v1/repositories/:repoId/import/upload — 200
// multipart/form-data, field "file". Streams the upload straight to disk
// (FileInterceptor + diskStorage — no in-memory buffering of the whole file, and
// naturally exempt from the global JSON/text/urlencoded body limit — GLOBAL_BODY_LIMIT
// = 512,000 bytes, server/src/common/body-limits.ts; the 2500MB LOGS_MAX_BODY_MB limit
// applies only to POST /api/v2/logs — since multipart bodies aren't parsed by those
// middlewares). The disk-generated filename (<randomUUID()>.zip)
// doubles as uploadToken. Immediately inserts a kind: 'staged_upload', status: 'staged'
// exportImportJobs row keyed by that token (so the cleanup sweep reaps an
// uploaded-but-never-confirmed zip after 30 minutes), then streams just meta.json out of
// the zip (yauzl, no full-archive buffering) to validate formatVersion and compute the
// preview counts.
interface UploadImportZipQuery {
  teamId?: number;
}
interface UploadImportZipResponse {
  uploadToken: string;
  sessionCount: number;
  approxUncompressedBytes: number;
  meta: ExportMetaJson;
}
response: UploadImportZipResponse
// Errors:
//   400 — teamId not a positive integer; file field missing
//   401 — not authenticated
//   403 — repo exists but caller lacks owner access
//   404 — repoId not found
//   409 — ownership conflict (not under AUTH_MODE=none): the archive holds a session
//         another user owns (foreign-session), a log authored by another registered user's
//         email (foreign-author) or a parentSessionId of another user's session, soft-deleted
//         included (foreign-parent). Whole import blocked; the staged row is marked
//         status: 'error' with the message. Body:
//         { statusCode: 409, error: 'Conflict', message: string,
//           conflicts: Array<{ sessionId: string;
//                              reason: 'foreign-session' | 'foreign-author' | 'foreign-parent' }> }
//         message names at most 5 session ids (+ "and N more"), never owners or emails.
//         The importer is the caller — no admin bypass.
//   422 — zip has no meta.json entry, meta.json is unparseable, or formatVersion is
//         unsupported (the staged row is marked status: 'error' in this case)
//   422 — a sessions/<id>/session.json is invalid (bad JSON, sessionId not a non-empty
//         string of <= 255 chars, bad parentSessionId, logs not an object, non-string
//         userEmail) or a sessionId appears twice; also an unsafe entry path or an import
//         limit hit by the pre-check — the staged row is marked status: 'error'. Checked
//         in every AUTH_MODE.

// POST /api/v1/repositories/:repoId/import/:uploadToken/confirm — 202
// Looks up the staged_upload row by uploadToken, re-validates meta.json defensively
// (a stale/corrupted staged file could in theory have changed since upload), updates the
// row IN PLACE to kind: 'import'/status: 'running' (same row id, now the jobId), then
// fires RepositoryExportImportService.runImportJob() WITHOUT awaiting it. The job
// zip-slip-guards every entry path (rejects '..'-prefixed/absolute paths, aborting the
// whole job with an error status on the first unsafe entry), resolves each log's original
// owner by EMAIL (meta.logs.<type>.userEmail) — an unknown email gets an unauthenticatable
// placeholder users row — and applies the keep-longer merge for any (sessionId, logType)
// that already exists locally (overwrites only when the incoming array is strictly longer;
// otherwise the existing row is untouched). Before any of that, the upload must still be
// status: 'staged' and the ownership pre-check (findImportConflicts) must pass. Each
// session is written by LogsService.importSession() in one transaction with an owner
// guard; a race that makes a session foreign after confirm ends the job in 'error'
// (sessions written before it stay). Under AUTH_MODE=none no author is resolved and
// every imported session's logs are reassigned to the importer.
body: {
  teamId?: number;
}
response: { jobId: string }
// Errors:
//   400 — teamId not a positive integer
//   401 — not authenticated
//   403 — repo exists but caller lacks owner access
//   404 — repoId not found; uploadToken has expired or was never staged; the upload is
//         no longer status: 'staged' (e.g. blocked by a 409/422) — message is the stored
//         errorMessage, so a second confirm repeats the same text
//   409 — ownership conflict (not under AUTH_MODE=none): the archive holds a session
//         another user owns (foreign-session), a log authored by another registered user's
//         email (foreign-author) or a parentSessionId of another user's session, soft-deleted
//         included (foreign-parent). Re-checked against the confirmer; whole import blocked; the staged row is marked
//         status: 'error' with the message. Body:
//         { statusCode: 409, error: 'Conflict', message: string,
//           conflicts: Array<{ sessionId: string;
//                              reason: 'foreign-session' | 'foreign-author' | 'foreign-parent' }> }
//         message names at most 5 session ids (+ "and N more"), never owners or emails.
//         The importer is the caller — no admin bypass.
//   422 — re-validated meta.json is unparseable or formatVersion is unsupported
//   422 — a sessions/<id>/session.json is invalid (bad JSON, sessionId not a non-empty
//         string of <= 255 chars, bad parentSessionId, logs not an object, non-string
//         userEmail) or a sessionId appears twice; also an unsafe entry path or an import
//         limit hit by the pre-check — the staged row is marked status: 'error'. Checked
//         in every AUTH_MODE.

// --- "Bootstrap import" — no existing target repoId -----------------------
// Same 3-step upload/confirm/status shape as above, but these routes don't call
// assertRepoOwnerOrTeamOwner (there's no repo to check access on yet) — auth is just
// SessionAuthGuard, scoped to the caller's own uploads/jobs by userId. The target repo
// is always PERSONAL (no teamId), resolved/created at confirm time from the zip's own
// meta.sourceRepoUrl via RepositoriesService.resolveOrCreatePersonalRepo(). Lets a
// previously exported zip be imported onto an empty server (no repos yet) or reattached
// under a brand-new personal repo named after the export's source repo.

// POST /api/v1/repositories/bootstrap-import/upload — 200
// Same multipart/form-data + FileInterceptor/diskStorage staging as
// :repoId/import/upload, but the staged_upload exportImportJobs row is created with
// repoId left null (there's nothing to attach it to yet).
interface UploadImportZipResponse {
  uploadToken: string;
  sessionCount: number;
  approxUncompressedBytes: number;
  meta: ExportMetaJson;
}
response: UploadImportZipResponse
// Errors:
//   400 — file field missing
//   401 — not authenticated
//   409 — ownership conflict (not under AUTH_MODE=none): the archive holds a session
//         another user owns (foreign-session), a log authored by another registered user's
//         email (foreign-author) or a parentSessionId of another user's session, soft-deleted
//         included (foreign-parent). Whole import blocked; the staged row is marked
//         status: 'error' with the message. Body:
//         { statusCode: 409, error: 'Conflict', message: string,
//           conflicts: Array<{ sessionId: string;
//                              reason: 'foreign-session' | 'foreign-author' | 'foreign-parent' }> }
//         message names at most 5 session ids (+ "and N more"), never owners or emails.
//         The importer is the caller — no admin bypass.
//   422 — zip has no meta.json entry, meta.json is unparseable, or formatVersion is
//         unsupported (the staged row is marked status: 'error' in this case)
//   422 — a sessions/<id>/session.json is invalid (bad JSON, sessionId not a non-empty
//         string of <= 255 chars, bad parentSessionId, logs not an object, non-string
//         userEmail) or a sessionId appears twice; also an unsafe entry path or an import
//         limit hit by the pre-check — the staged row is marked status: 'error'. Checked
//         in every AUTH_MODE.

// POST /api/v1/repositories/bootstrap-import/:uploadToken/confirm — 202
// Looks up the staged_upload row by uploadToken + current userId, re-validates
// meta.json to read meta.sourceRepoUrl, resolves-or-creates a personal repository row
// for the current user (same onConflictDoNothing + re-select pattern as
// LogsService.importSession()'s own repo-link step), writes that repoId onto the job
// row, then fires runImportJob() WITHOUT awaiting it — same merge/zip-slip/placeholder-user
// behavior as the per-repo confirm route above.
response: { jobId: string; repoId: number }
// Errors:
//   401 — not authenticated
//   404 — uploadToken has expired, was never staged, or belongs to a different user; the
//         upload is no longer status: 'staged' — message is the stored errorMessage
//   409 — ownership conflict (not under AUTH_MODE=none): the archive holds a session
//         another user owns (foreign-session), a log authored by another registered user's
//         email (foreign-author) or a parentSessionId of another user's session, soft-deleted
//         included (foreign-parent). Checked before the repository and team are resolved or created, so a blocked
//         confirm creates neither; whole import blocked; the staged row is marked
//         status: 'error' with the message. Body:
//         { statusCode: 409, error: 'Conflict', message: string,
//           conflicts: Array<{ sessionId: string;
//                              reason: 'foreign-session' | 'foreign-author' | 'foreign-parent' }> }
//         message names at most 5 session ids (+ "and N more"), never owners or emails.
//         The importer is the caller — no admin bypass.
//   422 — re-validated meta.json is unparseable or formatVersion is unsupported
//   422 — a sessions/<id>/session.json is invalid (bad JSON, sessionId not a non-empty
//         string of <= 255 chars, bad parentSessionId, logs not an object, non-string
//         userEmail) or a sessionId appears twice; also an unsafe entry path or an import
//         limit hit by the pre-check — the staged row is marked status: 'error'. Checked
//         in every AUTH_MODE.

// GET /api/v1/repositories/bootstrap-import/:jobId/status — 200
// Polls a bootstrap-import exportImportJobs row, scoped by userId instead of repoId.
interface JobStatusResponse {
  status: 'running' | 'done' | 'error';
  processed: number;
  total: number;
  repoId: number | null; // the resolved/created target repo — null only before confirm
  errorMessage?: string;
}
response: JobStatusResponse
// Errors:
//   401 — not authenticated
//   404 — jobId not found, belongs to a different user, or not kind: 'import'
```

---

## Server Logs

Application logs are written to `server/logs/` (gitignored, not served via API).

- Format: `app-YYYY-MM-DD.log` (or `app-YYYY-MM-DD-iN.log` per cluster worker slot N, where N is the worker's `NODE_APP_INSTANCE`; a restarted worker reuses its slot, so no new file series is started) — rolling cut every day.
- Retention: no automatic file retention/deletion is configured in code — old files accumulate unless pruned externally. See `server-conventions.md` for details.
- Console: colourised output is also written to stdout simultaneously.
- Logger: `server/src/common/app-logger.ts` (pino + pino-pretty for colourised console output,
  custom `DailyRotateStream` for file rotation — no external rotate package),
  passed to `NestFactory.create()` so all NestJS internal calls go through it.

---

## Model Pricing

```ts
// GET /api/v1/model-pricing — 200
// Requires: nothing (no SessionAuthGuard; public endpoint, so the hook's
//   local session-cost derivation can fetch rates without a session cookie).
// Returns the most-recent pricing row (effective_from <= today) for every model_id
// in the model_pricing table.  An empty table returns {}.
// NUMERIC columns are returned as JavaScript numbers.
response: Record<
  string,  // model_id
  {
    priceIn: number;    // USD per million input tokens
    priceOut: number;   // USD per million output tokens
    priceCacheR: number; // USD per million cache-read tokens
    // Cache writes have two TTL rates and no single flat cache-write rate.
    // A 1h cache write bills at 1.6x a 5m one, so the two token buckets
    // (session_stats.cache_write_5m_tokens / cache_write_1h_tokens) are priced
    // separately. There is no priceCacheW field: client and server ship together.
    priceCacheW5m: number; // USD per million 5-minute-TTL cache-write tokens
    priceCacheW1h: number; // USD per million 1-hour-TTL cache-write tokens
    priceWebSearch: number; // USD per web-search REQUEST — not per million tokens; 0 for
                            // third-party models, which offer no server tools
    charsPerToken: number | null; // estimation-only chars-per-token ratio; null for unresearched (third-party) tokenizers
    contextLength: number | null; // max context window in tokens for this model; null if unresearched
  }
>
// Errors:
//   401 — not authenticated
// Unpriced models (auto-registered from telemetry, migration 0066) have no model_pricing
//   row, so they are simply absent here — shape unchanged.
```

### Admin model pricing

Controller: `server/src/model-pricing/model-pricing-admin.controller.ts`. Every route requires a
session cookie **and** the admin role (`SessionAuthGuard` + `AdminGuard`). Without a session
the call returns 401; a non-admin gets 403. Types live in
`server/src/model-pricing/model-pricing.types.ts`, with the client twin in `client/src/models/pricing.ts`.
Semantics are described in [model-pricing-research.md](model-pricing-research.md).

```ts
type StoredPricingSource = 'anthropic' | 'openrouter' | 'manual' | 'override'; // model_pricing.source
type PricingSource = 'anthropic' | 'openrouter' | 'manual' | 'unpriced';       // resolved
interface ModelPricingRates {
  priceIn: number; priceOut: number; priceCacheR: number;  // USD per million tokens
  priceCacheW5m: number; priceCacheW1h: number;            // USD per million tokens
  priceWebSearch: number;                                  // USD per web-search REQUEST
  charsPerToken: number | null; contextLength: number | null;
}
interface AdminModelPricingRow {
  modelId: string;
  source: PricingSource;        // an override shows as its base source + overrideActive
  overrideActive: boolean;
  effective: (ModelPricingRates & { effectiveFrom: string /* YYYY-MM-DD */ }) | null; // null = unpriced
  base: ModelPricingRates | null; // fetched/imported price hidden under an override; else null
  firstSeenAt: string | null;     // ISO; set when ingest auto-registered the model
}
interface PricingFetchStatus {
  lastAttemptAt: string | null; lastSuccessAt: string | null;
  lastResult: 'changed' | 'unchanged' | 'imported' | 'failed' | null;
  lastCounts: Record<string, number> | null; // anthropic: { changed }; openrouter: import counts
  lastError: string | null;
}
interface AdminModelPricingResponse {
  anthropic: PricingFetchStatus; openrouter: PricingFetchStatus;
  unpricedCount: number;          // known ids with no effective row
  models: AdminModelPricingRow[]; // one per id in model_pricing ∪ model_pricing_meta
}
interface OpenRouterImportResult {
  updated: number; added: number; unchanged: number;
  skippedOverride: number; skippedAnthropic: number; skippedOther: number;
}

// Shared body of PUT /price and PUT /override (ModelPriceInputDto)
interface ModelPriceInputDto {
  modelId: string;          // 1–255 chars; in the BODY, never the path (ids can contain '/')
  priceIn: number;          // required, 0 ≤ x ≤ 9999.999999
  priceOut: number;         // required, same range
  priceCacheR?: number;     // default 0
  priceCacheW5m?: number;   // default round6(priceIn × 1.25)
  priceCacheW1h?: number;   // default round6(priceIn × 2)
  priceWebSearch?: number;  // default 0
  charsPerToken?: number;   // 0 < x ≤ 999.999; default: current effective row's value, else null
  contextLength?: number;   // positive integer ≤ 100,000,000; default as charsPerToken
}

// GET /api/v1/admin/model-pricing — 200
response: AdminModelPricingResponse
// Errors: 401, 403

// PUT /api/v1/admin/model-pricing/price — 200
// Sets a manual price (writes a today row with source 'manual').
body: ModelPriceInputDto
response: AdminModelPricingRow   // refreshed row
// Errors: 400 validation; 404 unknown id (no model_pricing and no model_pricing_meta row);
//   409 resolved source is not 'unpriced' / 'manual'

// PUT /api/v1/admin/model-pricing/override — 200
// Overrides a fetched/imported price. On the first override, the current effective rates are
//   saved as the base in model_pricing_meta; then a today row with source 'override' is written.
body: ModelPriceInputDto
response: AdminModelPricingRow
// Errors: 400; 404; 409 resolved source is not 'anthropic' / 'openrouter', or the model has a
//   future-dated row ("model has a scheduled price change")

// POST /api/v1/admin/model-pricing/override/clear — 200
// Writes the base back as a today row with its base source, then clears the meta base.
body: { modelId: string }        // ModelIdDto, 1–255 chars
response: AdminModelPricingRow
// Errors: 400; 404; 409 no active override

// POST /api/v1/admin/model-pricing/import-openrouter — 200
// Synchronous fetch of https://openrouter.ai/api/v1/models; updates non-Anthropic models only.
body: none
response: OpenRouterImportResult
// Errors: 502 { message } on fetch/HTTP/parse failure — nothing is written, and
//   model_pricing_fetch_state['openrouter'] records 'failed'
```

---

## Invitations

```ts
// GET /api/v1/invitations — 200
// Requires: session cookie
// Returns invitations where caller is inviter or invitee — BOTH directions on one
//   payload, because a team's Invitations tab needs the sent ones and the notification
//   bell needs the received ones. Consumers that want a single direction must filter on
//   inviteeId/inviterId themselves; PATCH below rejects responding to one you sent.
// Rows are enriched beyond the bare Invitation columns with:
//   inviteeEmail: string  // joined from users
//   teamName: string      // joined from teams — an invitee is not yet a member, so they
//                         // cannot resolve the name from GET /api/v1/teams
//   accessMode, hasTrainer // see the Invitation interface — they drive the mode badge on the
//                         // card and the pre-accept disclosure modal
response: Invitation[]
// Errors: 401

// PATCH /api/v1/invitations/:invId — 200
// Requires: session cookie; caller must be the invitee
body: { action: 'accept' | 'decline'; acknowledgedAccessMode?: TeamAccessMode }
// acknowledgedAccessMode is REQUIRED when action is 'accept' — it is the mode the invitee was
//   actually shown in the disclosure modal, and it must still match the team's live access_mode.
//   Ignored on decline.
// On accept: inserts into team_members (in one transaction with the status update) and sets
//   status='accepted'. Accepting IS the acknowledgement: disclosure_acknowledged_at is stamped
//   on the new row, so this member never sees the login-time disclosure gate for this team.
// On decline: sets status='declined'
// Errors:
//   400 — invitation not pending
//   400 — action:'accept' sent without acknowledgedAccessMode
//   400 — acknowledgedAccessMode differs from the team's current mode
//   403 — caller is not the invitee
//   404 — invitation not found
//   401 — not authenticated
```
