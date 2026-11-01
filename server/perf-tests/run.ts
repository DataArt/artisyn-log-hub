import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { loadConfig } from './config';
import { AuthClient } from './auth-client';
import {
  makeArtisynNdjson,
  makeHeavyClaudeNdjson,
  makeHookStatusLine,
  makeSubagentNdjson,
  makeWorkflowClaudeNdjson,
} from './data';
import { buildScenarios } from './scenarios';
import { runAllScenarios } from './runner';
import { saveResults, renderHtml, printConsoleComparison } from './reporter';
import { evaluateBudgets, loadBudgets, printBudgetReport } from './budgets';
import { IdCollector, SeedData } from './types';

const config = loadConfig();
const BASE = config.baseUrl;

const SEED_DRAIN_TIMEOUT_MS = 15000;
/** A ~5 MB claude transcript takes far longer to extract than the small seed logs. */
const HEAVY_SEED_DRAIN_TIMEOUT_MS = 120000;
/**
 * 12 sessions x ~5 MB: each body is larger than Postgres' default work_mem (4 MB), which is
 * what made the old per-line jsonb scan of the list expensive on real data. 30 x 1 MB fitted
 * in memory and let the pre-change list pass the 500 ms budget (measured 2026-11-01).
 */
const HEAVY_SESSION_COUNT = 12;
const HEAVY_CLAUDE_BYTES = 5 * 1024 * 1024;
/** Heavy sessions uploaded concurrently — bounded so the queue worker is not flooded. */
const HEAVY_SEED_CONCURRENCY = 5;
const CLEANUP_DRAIN_TIMEOUT_MS = 120000;
const DRAIN_POLL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Uploads one seed log through `POST /api/v2/logs` — the only upload route since
 * v1 was removed — and waits until the server's queue worker has stored it, so the
 * repository/session reads that follow see the data. Returns false (after a
 * warning) when the upload was refused or did not drain cleanly.
 */
async function uploadSeedLog(
  auth: AuthClient,
  params: Record<string, string>,
  body: string,
  drainTimeoutMs: number = SEED_DRAIN_TIMEOUT_MS,
): Promise<boolean> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/api/v2/logs?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...auth.apiKeyHeader },
    body,
  });
  if (!res.ok) {
    console.warn(`  Warning: seed upload ${query} failed (${res.status})`);
    return false;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const deadline = Date.now() + drainTimeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM upload_queue WHERE session_id = $1 AND log_type = $2',
        [params.sessionId, params.type],
      );
      if (
        rows.some(
          (r) =>
            r.status === 'failed' || r.status === 'rejected_foreign_session',
        )
      ) {
        console.warn(
          `  Warning: seed upload ${query} was rejected by the queue`,
        );
        return false;
      }
      if (
        !rows.some((r) => r.status === 'pending' || r.status === 'processing')
      ) {
        return true;
      }
      await sleep(DRAIN_POLL_INTERVAL_MS);
    }
    console.warn(`  Warning: seed upload ${query} did not drain in time`);
    return false;
  } finally {
    await client.end();
  }
}

async function seedTestData(
  auth: AuthClient,
  idCollector: IdCollector,
): Promise<SeedData> {
  // Submit an artisyn log so repo/session endpoints have data to return
  const sessionId = randomUUID();
  const seedRepoUrl = `https://github.com/artisyn/perf-test-repo-${randomUUID()}`;
  // Append a hook-status line so the seed repo has hook_version populated —
  // required for the repos:hooks / repos:hook-state scenarios to exercise the
  // populated-data path instead of always hitting the empty-list/404 branch.
  const ndjson = `${makeArtisynNdjson(20, seedRepoUrl)}\n${makeHookStatusLine()}`;

  const logOk = await uploadSeedLog(
    auth,
    { sessionId, type: 'artisyn' },
    ndjson,
  );
  if (!logOk) {
    console.warn('  Warning: seed log failed — repo scenarios will be skipped');
    return {};
  }

  idCollector.sessionUuids.add(sessionId);

  const reposRes = await auth.fetch('/api/v1/repositories');
  if (!reposRes.ok) return {};
  const repos = (await reposRes.json()) as Array<{
    id: number;
    repoUrl: string;
  }>;
  if (!repos.length) return {};

  const row = repos.find((r) => r.repoUrl === seedRepoUrl);
  if (!row) return {};

  const seedRepoNumericId = row.id;
  idCollector.repoIds.add(seedRepoNumericId);
  const repoId = String(row.id);

  const sessionsRes = await auth.fetch(
    `/api/v1/repositories/${repoId}/sessions`,
  );
  if (!sessionsRes.ok) return { repoId, seedRepoNumericId };

  const sessions = (await sessionsRes.json()) as Array<{ sessionId: string }>;
  const seedSessionId = sessions[0]?.sessionId;

  if (seedSessionId) {
    await seedWorkflowData(auth, idCollector, seedSessionId);
  }

  return { repoId, sessionId: seedSessionId, seedRepoNumericId };
}

// Uploads a claude log carrying a completed Workflow tool_use, plus two nested
// claude-subagent sessions (one direct workflow agent, one of its own Task-tool
// sub-agents), onto the seed session — so repos:session-logs exercises the real
// extractWorkflows()/descendant-BFS path (server/src/logs/repositories.controller.ts
// getSessionLogs()) instead of running it over a session with no claude log at all.
async function seedWorkflowData(
  auth: AuthClient,
  idCollector: IdCollector,
  sessionId: string,
): Promise<void> {
  const wfId = `wf_${randomUUID().slice(0, 12)}`;

  const claudeOk = await uploadSeedLog(
    auth,
    { sessionId, type: 'claude' },
    makeWorkflowClaudeNdjson(wfId),
  );
  if (!claudeOk) {
    console.warn(
      '  Warning: seed claude/workflow log failed — session-logs workflow linkage will be empty',
    );
    return;
  }

  const agentA = `agent-${randomUUID()}`;
  const agentAOk = await uploadSeedLog(
    auth,
    {
      sessionId: agentA,
      type: 'claude-subagent',
      parentSessionId: sessionId,
      workflowRunId: wfId,
    },
    makeSubagentNdjson(),
  );
  if (agentAOk) idCollector.sessionUuids.add(agentA);

  const agentB = `agent-${randomUUID()}`;
  const agentBOk = await uploadSeedLog(
    auth,
    { sessionId: agentB, type: 'claude-subagent', parentSessionId: agentA },
    makeSubagentNdjson(),
  );
  if (agentBOk) idCollector.sessionUuids.add(agentB);
}

/**
 * Seeds a separate repository with `HEAVY_SESSION_COUNT` (12) sessions, each with an artisyn log and a
 * ~5 MB claude transcript (every 5th also with a Workflow tool_use and one claude-subagent
 * child) — the realistic shape the session list is slow on, measured by repos:sessions-heavy.
 *
 * Any failed upload throws: a budgeted scenario must never "pass" because its data (or the
 * scenario itself) silently did not exist.
 */
async function seedHeavyData(
  auth: AuthClient,
  idCollector: IdCollector,
): Promise<{ repoId: string; sessionId: string }> {
  const repoUrl = `https://github.com/artisyn/perf-heavy-repo-${randomUUID()}`;
  // The session the per-session *-heavy scenarios open: index 0 has the Workflow call and a sub-agent.
  let detailSessionId = '';
  const plainBody = makeHeavyClaudeNdjson({
    targetBytes: HEAVY_CLAUDE_BYTES,
    withWorkflow: false,
  });
  const workflowBody = makeHeavyClaudeNdjson({
    targetBytes: HEAVY_CLAUDE_BYTES,
    withWorkflow: true,
  });

  const upload = async (
    params: Record<string, string>,
    body: string,
  ): Promise<void> => {
    const ok = await uploadSeedLog(
      auth,
      params,
      body,
      HEAVY_SEED_DRAIN_TIMEOUT_MS,
    );
    if (!ok) {
      throw new Error(
        `Heavy seed upload failed (${params.type} for session ${params.sessionId})`,
      );
    }
  };

  const seedOne = async (index: number): Promise<void> => {
    const sessionId = randomUUID();
    idCollector.sessionUuids.add(sessionId);
    if (index === 0) detailSessionId = sessionId;
    await upload(
      { sessionId, type: 'artisyn' },
      makeArtisynNdjson(20, repoUrl),
    );
    const withWorkflow = index % 5 === 0;
    await upload(
      { sessionId, type: 'claude' },
      withWorkflow ? workflowBody : plainBody,
    );
    if (withWorkflow) {
      const agentId = `agent-${randomUUID()}`;
      idCollector.sessionUuids.add(agentId);
      await upload(
        {
          sessionId: agentId,
          type: 'claude-subagent',
          parentSessionId: sessionId,
        },
        makeSubagentNdjson(),
      );
    }
  };

  const t0 = Date.now();
  for (let i = 0; i < HEAVY_SESSION_COUNT; i += HEAVY_SEED_CONCURRENCY) {
    const batch: Promise<void>[] = [];
    for (
      let j = i;
      j < Math.min(i + HEAVY_SEED_CONCURRENCY, HEAVY_SESSION_COUNT);
      j++
    ) {
      batch.push(seedOne(j));
    }
    await Promise.all(batch);
  }

  const reposRes = await auth.fetch('/api/v1/repositories');
  if (!reposRes.ok) {
    throw new Error(
      `Heavy seed: listing repositories failed (${reposRes.status})`,
    );
  }
  const repos = (await reposRes.json()) as Array<{
    id: number;
    repoUrl: string;
  }>;
  const row = repos.find((r) => r.repoUrl === repoUrl);
  if (!row) {
    throw new Error(`Heavy seed: repository ${repoUrl} not found after upload`);
  }
  idCollector.repoIds.add(row.id);
  console.log(
    `  Heavy repo: ${row.id} (${HEAVY_SESSION_COUNT} sessions, ~${Math.round(plainBody.length / 1024)} KB transcripts, ${Date.now() - t0} ms)`,
  );
  return { repoId: String(row.id), sessionId: detailSessionId };
}

async function cleanupDb(
  collector: IdCollector,
  userId: string | null,
): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (collector.sessionUuids.size > 0) {
      const uuids = [...collector.sessionUuids];
      // The log scenarios only stage uploads (v2); let the queue worker finish them
      // first, or it would re-create sessions after this cleanup.
      const countInFlight = async (statuses: string[]): Promise<number> => {
        const res = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM upload_queue
           WHERE session_id = ANY($1::text[]) AND status::text = ANY($2::text[])`,
          [uuids, statuses],
        );
        return Number(res.rows[0].n);
      };
      const drainDeadline = Date.now() + CLEANUP_DRAIN_TIMEOUT_MS;
      while (Date.now() < drainDeadline) {
        if ((await countInFlight(['pending', 'processing'])) === 0) break;
        await sleep(DRAIN_POLL_INTERVAL_MS);
      }
      // A backlog the worker did not finish in time: drop what it has not started, then wait for
      // the rows it is processing right now. Deleting a 'processing' row does not stop the worker,
      // and the logs it writes afterwards would block the sessions DELETE below (logs FK).
      const dropped = await client.query(
        `DELETE FROM upload_queue WHERE session_id = ANY($1::text[]) AND status = 'pending'`,
        [uuids],
      );
      if ((dropped.rowCount ?? 0) > 0) {
        console.log(
          `  DB cleanup: queue not drained in ${CLEANUP_DRAIN_TIMEOUT_MS} ms — dropped ${dropped.rowCount} pending uploads`,
        );
      }
      const processingDeadline = Date.now() + CLEANUP_DRAIN_TIMEOUT_MS;
      while (Date.now() < processingDeadline) {
        if ((await countInFlight(['processing'])) === 0) break;
        await sleep(DRAIN_POLL_INTERVAL_MS);
      }
      const queueDel = await client.query(
        'DELETE FROM upload_queue WHERE session_id = ANY($1::text[])',
        [uuids],
      );
      console.log(
        `  DB cleanup: deleted ${queueDel.rowCount} upload_queue rows`,
      );
      const logsDel = await client.query(
        'DELETE FROM logs WHERE session_id IN (SELECT id FROM sessions WHERE session_id = ANY($1::text[]))',
        [uuids],
      );
      console.log(`  DB cleanup: deleted ${logsDel.rowCount} log rows`);
      const sessDel = await client.query(
        'DELETE FROM sessions WHERE session_id = ANY($1::text[])',
        [uuids],
      );
      console.log(`  DB cleanup: deleted ${sessDel.rowCount} session rows`);
    }

    if (collector.repoIds.size > 0) {
      const ids = [...collector.repoIds];
      const repoDel = await client.query(
        'DELETE FROM repositories WHERE id = ANY($1::int[])',
        [ids],
      );
      console.log(`  DB cleanup: deleted ${repoDel.rowCount} repository rows`);
    }

    if (collector.userWasCreated && userId) {
      const userDel = await client.query('DELETE FROM users WHERE id = $1', [
        parseInt(userId, 10),
      ]);
      console.log(`  DB cleanup: deleted ${userDel.rowCount} user rows`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Read-only target mode: resolves the seed data from an existing repository instead of seeding.
 * With `PERF_REPO_ID` the repo's session list must be readable and non-empty for `PERF_EMAIL`
 * (repos are private to their owner), or the run aborts — a scenario set measuring nothing but
 * 403/404s is worse than no run. Without it only the repo-independent scenarios run.
 */
async function resolveReadOnlyTarget(auth: AuthClient): Promise<SeedData> {
  const repoId = config.repoId;
  if (!repoId) {
    console.log(
      '  Read-only mode without PERF_REPO_ID — repo/session scenarios skipped',
    );
    return {};
  }
  const res = await auth.fetch(`/api/v1/repositories/${repoId}/sessions`);
  if (!res.ok) {
    throw new Error(
      `Target repo ${repoId}: GET /api/v1/repositories/${repoId}/sessions returned ${res.status} for PERF_EMAIL ${config.testUser.email} — check PERF_REPO_ID and that this user owns the repo`,
    );
  }
  const sessions = (await res.json()) as Array<{
    sessionId: string;
    startTime?: string | null;
  }>;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error(
      `Target repo ${repoId} has no sessions visible to PERF_EMAIL ${config.testUser.email} — check PERF_REPO_ID and that this user owns the repo`,
    );
  }
  const startMs = (s: { startTime?: string | null }): number => {
    const t = s.startTime ? Date.parse(s.startTime) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  const latest = sessions.reduce((best, s) =>
    startMs(s) > startMs(best) ? s : best,
  );
  console.log(`  Repo: ${repoId} (${sessions.length} sessions)`);
  console.log(`  Session: ${latest.sessionId} (latest startTime)`);
  return { repoId, sessionId: latest.sessionId };
}

async function main(): Promise<void> {
  // The DB is touched only to drain seed uploads and to clean up — neither happens read-only.
  if (!config.readOnly && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL env var is required for DB cleanup');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Artisyn Log Hub — API Performance Tests');
  console.log(`  Base URL    : ${config.baseUrl}`);
  console.log(`  Iterations  : ${config.iterations}`);
  console.log(`  Warmup      : ${config.warmupIterations}`);
  console.log(`  Output      : ${config.outputDir}`);
  if (config.readOnly) {
    console.log(
      `  Mode        : read-only (target repo ${config.repoId ?? 'none'})`,
    );
    console.log(`  User        : ${config.testUser.email}`);
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  const auth = new AuthClient();
  const idCollector: IdCollector = {
    sessionUuids: new Set<string>(),
    repoIds: new Set<number>(),
    userWasCreated: false,
  };

  let budgetsFailed = false;
  try {
    console.log('▶ Auth setup');
    await auth.setup(idCollector, { readOnly: config.readOnly });
    console.log(`  User: ${config.testUser.email}  (id: ${auth.userId})`);

    let seedData: SeedData;
    if (config.readOnly) {
      // No seed, no API key, no writing scenario: the only mutating request this run sends is
      // the login/identify in auth.setup() (plus auth:login under a password mode).
      console.log('\n▶ Resolving read-only target (no seeding)');
      seedData = await resolveReadOnlyTarget(auth);
      console.log(
        '  Skipping repos:sessions-heavy — read-only mode never writes the heavy seed',
      );
    } else {
      console.log('\n▶ Seeding test data');
      seedData = await seedTestData(auth, idCollector);
      if (seedData.repoId) {
        console.log(`  Repo: ${seedData.repoId}`);
        console.log(`  Session: ${seedData.sessionId ?? '(none found)'}`);
      } else {
        console.log('  No repo data available');
      }

      console.log('\n▶ Seeding heavy session-list data');
      const heavy = await seedHeavyData(auth, idCollector);
      seedData.heavyRepoId = heavy.repoId;
      seedData.heavySessionId = heavy.sessionId;
    }

    console.log('\n▶ Running scenarios\n');
    const scenarios = buildScenarios(seedData, idCollector, auth.authMode);
    const results = await runAllScenarios(scenarios, auth, {
      iterations: config.iterations,
      warmupIterations: config.warmupIterations,
      parallelRunsPerScenario: config.parallelRunsPerScenario,
      requestTimeoutMs: config.requestTimeoutMs,
    });

    const meta = {
      timestamp: new Date().toISOString(),
      baseUrl: config.baseUrl,
      iterations: config.iterations,
      warmupIterations: config.warmupIterations,
      scenarioCount: results.length,
    };

    console.log('\n▶ Saving reports');
    const { report, baseline } = saveResults(config.outputDir, results, meta);
    renderHtml(report, baseline, config.outputDir);

    printConsoleComparison(report, baseline);

    const verdicts = evaluateBudgets(results, loadBudgets());
    printBudgetReport(verdicts);
    budgetsFailed = verdicts.some((v) => v.status === 'fail');

    const totalErrors = results.reduce((s, r) => s + r.errors, 0);
    console.log(
      `\n✓ Done — ${results.length} scenarios, ${totalErrors} total errors\n`,
    );
  } finally {
    console.log('\n▶ Cleanup');
    try {
      await auth.teardown();
    } catch (err) {
      console.error('  Error during auth teardown:', err);
    }
    if (config.readOnly) {
      console.log('  Read-only mode — nothing was written, no DB cleanup');
    } else {
      try {
        await cleanupDb(idCollector, auth.userId);
      } catch (err) {
        console.error('  Error during DB cleanup:', err);
      }
    }
  }

  // Set only after cleanup so a broken budget never skips it.
  if (budgetsFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(
    '\nFatal error:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
