/**
 * seed.ts — self-owned test data seeding for e2e specs.
 *
 * Part of the e2e shared-helper suite. Generalizes the now-relative seeding
 * pattern from analytics-horizontal-view.spec.ts into a reusable helper so every
 * spec can own an isolated repo instead of relying on ambient DB rows.
 *
 * What it does (see seedRepoWithSessions):
 *   (a) ensures the role user exists + is logged in on `request`, and mints an
 *       API key for log ingestion;
 *   (b) POSTs artisyn NDJSON to POST /api/v2/logs?sessionId=..&type=artisyn
 *       (content-type: text/plain) — a `git.repo` line (unique URL under
 *       E2E_REPO_PREFIX), an `event:'prompt'` line, run-time-relative timestamps
 *       (now - daysAgo), and optional session_stats; plus an optional `claude`
 *       log (type=claude) carrying turn / tool-call data. v2 queues the upload,
 *       so each POST then polls `upload_queue` until the server has stored it;
 *   (c) resolves + returns { repoId, repoUrl, apiKey, sessionIds };
 *   (d) exposes cleanup() that deletes the seeded API key via the owner's own
 *       DELETE /api/v1/api-keys/:id, deletes the seeded repo through a shared
 *       admin request context (DELETE /api/v1/admin/repos/:id — there is no
 *       owner-level repo-delete endpoint), and optionally purges sessions via
 *       the owner's DELETE /api/v1/sessions/:sessionId.
 *
 * Repo URL: pass `repoUrl` for full control. Otherwise the URL is built by
 * `buildSeedRepoUrl(slug)` (see repo-url.ts) as
 * `E2E_REPO_PREFIX + runUuid + '/' + specSlug + '-w' + workerIndex`, so parallel
 * workers and fullyParallel retries never collide. `specSlug` defaults to a
 * random short id when omitted, keeping the module self-consistent standalone.
 *
 * Session id uniqueness: an explicitly passed `sessionId` must be worker-unique
 * (e.g. suffix it with `-w${workerIndex()}`, imported from repo-url.ts) — omit it
 * and the auto-generated `${slug}-sN-${uuid}` id is unique on its own. `logs` is
 * globally unique on `(session_id, log_type)` and ingestion upserts, so two
 * workers posting the same explicit id share (and overwrite) the same physical
 * log rows; the first worker's cleanup() then deletes them as orphaned, and the
 * sibling worker's session is deleted out from under its own still-running test.
 *
 * Tool-call / file-category support: pass `toolCalls: [{ name, filePath }]` on a
 * session to emit a claude assistant `tool_use` log with that file_path, so
 * repo-file-categories can assert a category without discovery. `.png` paths work
 * the same way.
 *
 * Sub-agent support: pass `subAgents: [{ model, inputTokens, ... }]` on a session to
 * seed descendant sessions POSTed as `type=claude-subagent&parentSessionId=<this
 * session's id>` (see `SeedSubAgent`) — required for executive-summary cost-rollup
 * coverage.
 */
import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import { BASE_URL, E2E_API_KEY_PREFIX, ROLES, type Role } from './credentials';
import { isNoAuthMode } from './auth-mode';
import { ensureUser } from './auth';
import { buildSeedRepoUrl, workerIndex } from './repo-url';
import { waitForUploadQueueDrained } from './db';

/** A tool call to embed in a session's claude log (Read/Write/Edit + file path). */
export interface SeedToolCall {
  name: 'Read' | 'Write' | 'Edit';
  filePath: string;
}

/**
 * One sub-agent (descendant) session to seed under a root `SeedSession` — required to
 * exercise the executive-summary cost rollup (see
 * `session-tree.sql.ts`'s `descendantSessionsCte`/`subagent_costs` pattern). POSTed as
 * its own `type=claude-subagent&parentSessionId=<root sessionId>` log carrying a
 * single synthetic assistant event — the same shape the hook's real
 * `subagents/workflows/<wfId>/` upload uses (see session-log-view.spec.ts's
 * workflow-agent fixture). No artisyn log: sub-agent sessions never link to a
 * repository directly, only via their root's `parent_session_id` chain.
 */
export interface SeedSubAgent {
  /** Sub-agent session id. Defaults to `${parentSessionId}-subN`. */
  sessionId?: string;
  /** Model recorded on the synthetic assistant event. Default 'claude-sonnet-4-6'. */
  model?: string;
  /** Input tokens on the synthetic assistant event. Default 500. */
  inputTokens?: number;
  /** Output tokens on the synthetic assistant event. Default 200. */
  outputTokens?: number;
  /** Cache-read tokens on the synthetic assistant event. Default 0. */
  cacheReadTokens?: number;
  /** Cache-write tokens on the synthetic assistant event. Default 0. */
  cacheWriteTokens?: number;
}

/** One session's worth of seeded data. */
export interface SeedSession {
  /** Session id. Defaults to a generated unique id. */
  sessionId?: string;
  /** First-prompt text (drives the session-list label). */
  firstPrompt?: string;
  /** Git branch recorded on the artisyn `git.repo` line. Default 'main'. */
  branch?: string;
  /** Timestamp = now - daysAgo days. Default 0 (now). Keeps data inside `ar=1w`. */
  daysAgo?: number;
  /** If set, emits an artisyn `session_stats` event with this work time. */
  autonomousWorkTimeMs?: number;
  /** Extra raw artisyn events appended after the standard lines. */
  artisynEvents?: Record<string, unknown>[];
  /** Read/Write/Edit tool calls → built into a claude assistant tool_use log. */
  toolCalls?: SeedToolCall[];
  /**
   * Raw claude NDJSON events, POSTed as type=claude verbatim. When provided this
   * takes precedence over `toolCalls` for the claude log content. Use for rich
   * turn data (skills, rules, multiple event types).
   */
  claudeEvents?: Record<string, unknown>[];
  /**
   * Sub-agent (descendant) sessions to seed under this session (the cost
   * rollup). See `SeedSubAgent` for the shape/rationale.
   */
  subAgents?: SeedSubAgent[];
}

export interface SeedOptions {
  /** Which role owns the seeded repo. Default 'primary'. */
  role?: Role;
  /** Sessions to seed. At least one is required. */
  sessions: SeedSession[];
  /** Full repo URL override. The run-scoped seeding injects the runUuid-scoped URL here. */
  repoUrl?: string;
  /** Spec slug used to build the fallback repo URL when `repoUrl` is absent. */
  specSlug?: string;
  /** API-key name. Default derived from the repo slug. */
  keyName?: string;
  /**
   * Purge each seeded session via owner DELETE /sessions/:id during cleanup.
   * Purged ids are soft-deleted and can't be re-seeded — use run-unique
   * session ids. See docs/knowledgebase/test/e2e-tests.md.
   */
  purgeSessions?: boolean;
}

export interface SeededRepo {
  repoId: number;
  repoUrl: string;
  apiKey: string;
  apiKeyId: number;
  sessionIds: string[];
  /**
   * Delete the seeded API key (owner) and repo (admin), and optionally purge
   * sessions (owner).
   */
  cleanup: () => Promise<void>;
}

interface RepoListRow {
  id: number;
  repoUrl: string;
}
interface ApiKeyRow {
  id: number;
  name: string;
}

function nowMinusDaysIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function buildArtisynLog(session: Required<Pick<SeedSession, 'sessionId'>> & SeedSession, repoUrl: string): string {
  const ts = nowMinusDaysIso(session.daysAgo ?? 0);
  const branch = session.branch ?? 'main';
  const lines: Record<string, unknown>[] = [
    { git: { repo: repoUrl, branch }, event: 'test', timestamp: ts },
    {
      event: 'prompt',
      prompt: session.firstPrompt ?? 'E2E seeded session',
      timestamp: ts,
    },
  ];
  if (session.autonomousWorkTimeMs != null) {
    lines.push({
      event: 'session_stats',
      session_stats: { autonomous_work_time_ms: session.autonomousWorkTimeMs },
      timestamp: ts,
    });
  }
  if (session.artisynEvents) lines.push(...session.artisynEvents);
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

/** Build a minimal claude NDJSON log carrying tool_use blocks for the given tool calls. */
function buildClaudeLogFromToolCalls(
  sessionId: string,
  toolCalls: SeedToolCall[],
  firstPrompt: string,
  daysAgo: number,
): string {
  const ts = nowMinusDaysIso(daysAgo);
  const userUuid = `${sessionId}-u1`;
  const asstUuid = `${sessionId}-a1`;
  const events: Record<string, unknown>[] = [
    {
      type: 'user',
      uuid: userUuid,
      parentUuid: null,
      sessionId,
      isMeta: false,
      isSidechain: false,
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: firstPrompt }] },
    },
    {
      type: 'assistant',
      uuid: asstUuid,
      parentUuid: userUuid,
      sessionId,
      isSidechain: false,
      timestamp: ts,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: toolCalls.map((tc, i) => ({
          type: 'tool_use',
          id: `${sessionId}-tool-${i}`,
          name: tc.name,
          input: { file_path: tc.filePath },
        })),
      },
    },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/** Build a single synthetic assistant event (+ its triggering user event) as the NDJSON
 * body of a sub-agent's `claude-subagent` log — the model/usage extractClaudeStats()
 * (claude-extractor.ts) reads to populate session_stats for the cost rollup. */
function buildSubAgentClaudeLog(
  sessionId: string,
  subAgent: SeedSubAgent,
  daysAgo: number,
): string {
  const ts = nowMinusDaysIso(daysAgo);
  const userUuid = `${sessionId}-u1`;
  const events: Record<string, unknown>[] = [
    {
      type: 'user',
      uuid: userUuid,
      parentUuid: null,
      sessionId,
      isMeta: false,
      isSidechain: true,
      timestamp: ts,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'E2E seeded sub-agent task' }],
      },
    },
    {
      type: 'assistant',
      uuid: `${sessionId}-a1`,
      parentUuid: userUuid,
      sessionId,
      isSidechain: true,
      timestamp: ts,
      message: {
        role: 'assistant',
        model: subAgent.model ?? 'claude-sonnet-4-6',
        usage: {
          input_tokens: subAgent.inputTokens ?? 500,
          output_tokens: subAgent.outputTokens ?? 200,
          cache_read_input_tokens: subAgent.cacheReadTokens ?? 0,
          cache_creation_input_tokens: subAgent.cacheWriteTokens ?? 0,
        },
        content: [{ type: 'text', text: 'sub-agent work done' }],
      },
    },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n');
}

async function postLog(
  request: APIRequestContext,
  sessionId: string,
  type: 'artisyn' | 'claude' | 'claude-subagent',
  apiKey: string,
  body: string,
  parentSessionId?: string,
): Promise<void> {
  const params = new URLSearchParams({ sessionId, type });
  if (parentSessionId) params.set('parentSessionId', parentSessionId);
  const resp = await request.post(`/api/v2/logs?${params.toString()}`, {
    headers: { 'content-type': 'text/plain', 'x-api-key': apiKey },
    data: body,
  });
  if (!resp.ok()) {
    throw new Error(
      `Seed: ${type} log ingest failed for ${sessionId} (${resp.status()}): ${await resp.text()}`,
    );
  }
  // A foreign-session upload is answered 201 with a warning and nothing is staged.
  const { warnings } = (await resp.json()) as { warnings?: string[] };
  const foreign = (warnings ?? []).find(
    (w) => w.includes(sessionId) && w.includes('another user'),
  );
  if (foreign) {
    throw new Error(`Seed: ${type} log ingest rejected for ${sessionId}: ${foreign}`);
  }
  // v2 only stages the upload — wait for the queue worker to store it.
  await waitForUploadQueueDrained(sessionId, type);
}

/**
 * Seed a self-owned repo (with sessions) for an e2e spec and return handles +
 * a cleanup() closure. See the file header for the full contract.
 */
export async function seedRepoWithSessions(
  request: APIRequestContext,
  opts: SeedOptions,
): Promise<SeededRepo> {
  if (!opts.sessions || opts.sessions.length === 0) {
    throw new Error('seedRepoWithSessions: at least one session is required');
  }

  const role: Role = opts.role ?? 'primary';
  const creds = ROLES[role];
  const slug = opts.specSlug ?? `seed-${crypto.randomUUID().slice(0, 8)}`;
  // Unique per run/spec/worker: E2E_REPO_PREFIX + runUuid + '/' + slug + '-w' + workerIndex.
  const repoUrl = opts.repoUrl ?? buildSeedRepoUrl(slug);
  // Worker-scoped so parallel workers running the SAME spec's beforeAll never
  // race on one shared key name (delete+create collisions → 409/500/401). Stable
  // within a worker so retries reuse (and clean up) their own key.
  const keyName = opts.keyName ?? `${E2E_API_KEY_PREFIX}${slug}-w${workerIndex()}`;

  // (a) Ensure the role user + a fresh API key.
  await ensureUser(request, creds);

  const keysResp = await request.get('/api/v1/api-keys');
  if (keysResp.ok()) {
    const existing = (await keysResp.json()) as ApiKeyRow[];
    for (const k of existing.filter((k) => k.name === keyName)) {
      await request.delete(`/api/v1/api-keys/${k.id}`);
    }
  }
  const keyResp = await request.post('/api/v1/api-keys', { data: { name: keyName } });
  if (!keyResp.ok()) {
    throw new Error(
      `Seed: API-key create failed (${keyResp.status()}): ${await keyResp.text()}`,
    );
  }
  const { key: apiKey, id: apiKeyId } = (await keyResp.json()) as {
    key: string;
    id: number;
  };

  // (b) Ingest artisyn (+ optional claude) logs per session.
  const sessionIds: string[] = [];
  for (let i = 0; i < opts.sessions.length; i++) {
    const s = opts.sessions[i];
    const sessionId = s.sessionId ?? `${slug}-s${i + 1}-${crypto.randomUUID().slice(0, 8)}`;
    sessionIds.push(sessionId);
    const resolved = { ...s, sessionId };

    await postLog(request, sessionId, 'artisyn', apiKey, buildArtisynLog(resolved, repoUrl));

    let claudeBody: string | null = null;
    if (s.claudeEvents && s.claudeEvents.length > 0) {
      claudeBody = s.claudeEvents.map((e) => JSON.stringify(e)).join('\n');
    } else if (s.toolCalls && s.toolCalls.length > 0) {
      claudeBody = buildClaudeLogFromToolCalls(
        sessionId,
        s.toolCalls,
        s.firstPrompt ?? 'E2E seeded session',
        s.daysAgo ?? 0,
      );
    }
    if (claudeBody) {
      await postLog(request, sessionId, 'claude', apiKey, claudeBody);
    }

    if (s.subAgents && s.subAgents.length > 0) {
      for (let j = 0; j < s.subAgents.length; j++) {
        const sub = s.subAgents[j];
        const subSessionId = sub.sessionId ?? `${sessionId}-sub${j + 1}`;
        await postLog(
          request,
          subSessionId,
          'claude-subagent',
          apiKey,
          buildSubAgentClaudeLog(subSessionId, sub, s.daysAgo ?? 0),
          sessionId,
        );
      }
    }
  }

  // (c) Resolve the repo id.
  const reposResp = await request.get('/api/v1/repositories');
  if (!reposResp.ok()) {
    throw new Error(
      `Seed: GET /repositories failed (${reposResp.status()}): ${await reposResp.text()}`,
    );
  }
  const repos = (await reposResp.json()) as RepoListRow[];
  const repo = repos.find((r) => r.repoUrl === repoUrl);
  if (!repo) {
    throw new Error(`Seed: repo not found after ingestion: ${repoUrl}`);
  }
  const repoId = repo.id;

  // (d) cleanup() — api-key delete via owner's own context; repo delete via
  // admin context; optional session purge via owner.
  const cleanup = async (): Promise<void> => {
    if (opts.purgeSessions) {
      for (const sid of sessionIds) {
        try {
          await request.delete(`/api/v1/sessions/${encodeURIComponent(sid)}`);
        } catch {
          /* best-effort — the repo delete below removes the session families anyway */
        }
      }
    }
    try {
      await request.delete(`/api/v1/api-keys/${apiKeyId}`);
    } catch {
      /* best-effort — the backstop sweep (sweep.ts) catches leftovers */
    }
    // EXPLICIT empty cookie jar: a file-level `test.use({ storageState })` is
    // inherited by request.newContext(), and authenticating on a context that
    // already holds a session makes Passport regenerate it — DELETEing the
    // shared storageState session out from under every later spec using that
    // role. Starting cookie-free means the login/identify below can only ever
    // create a session, never destroy one.
    const adminCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
    });
    try {
      // Mode 1 has no /auth/login (AuthModeGuard 404s it) — /auth/identify is
      // how a session is opened there. Without this branch every seeded repo
      // would leak, since cleanup would silently no-op on the 404.
      const sessionResp = isNoAuthMode()
        ? await adminCtx.post('/api/v1/auth/identify', {
            data: { email: ROLES.admin.email },
          })
        : await adminCtx.post('/api/v1/auth/login', {
            data: { email: ROLES.admin.email, password: ROLES.admin.password },
          });
      if (sessionResp.ok()) {
        await adminCtx.delete(`/api/v1/admin/repos/${repoId}`);
      }
    } finally {
      await adminCtx.dispose();
    }
  };

  return { repoId, repoUrl, apiKey, apiKeyId, sessionIds, cleanup };
}
