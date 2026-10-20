import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { loadConfig } from './config';
import { AuthClient } from './auth-client';
import {
  makeArtisynNdjson,
  makeHookStatusLine,
  makeSubagentNdjson,
  makeWorkflowClaudeNdjson,
} from './data';
import { buildScenarios } from './scenarios';
import { runAllScenarios } from './runner';
import { saveResults, renderHtml, printConsoleComparison } from './reporter';
import { IdCollector, SeedData } from './types';

const config = loadConfig();
const BASE = config.baseUrl;

const SEED_DRAIN_TIMEOUT_MS = 15000;
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
    const deadline = Date.now() + SEED_DRAIN_TIMEOUT_MS;
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
      const drainDeadline = Date.now() + CLEANUP_DRAIN_TIMEOUT_MS;
      while (Date.now() < drainDeadline) {
        const inFlight = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM upload_queue
           WHERE session_id = ANY($1::text[]) AND status IN ('pending', 'processing')`,
          [uuids],
        );
        if (Number(inFlight.rows[0].n) === 0) break;
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

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL env var is required for DB cleanup');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Artisyn Log Hub — API Performance Tests');
  console.log(`  Base URL    : ${config.baseUrl}`);
  console.log(`  Iterations  : ${config.iterations}`);
  console.log(`  Warmup      : ${config.warmupIterations}`);
  console.log(`  Output      : tmp/perftests/`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const auth = new AuthClient();
  const idCollector: IdCollector = {
    sessionUuids: new Set<string>(),
    repoIds: new Set<number>(),
    userWasCreated: false,
  };

  try {
    console.log('▶ Auth setup');
    await auth.setup(idCollector);
    console.log(`  User: ${config.testUser.email}  (id: ${auth.userId})`);

    console.log('\n▶ Seeding test data');
    const seedData = await seedTestData(auth, idCollector);
    if (seedData.repoId) {
      console.log(`  Repo: ${seedData.repoId}`);
      console.log(`  Session: ${seedData.sessionId ?? '(none found)'}`);
    } else {
      console.log('  No repo data available');
    }

    console.log('\n▶ Running scenarios\n');
    const scenarios = buildScenarios(seedData, idCollector, auth.authMode);
    const results = await runAllScenarios(scenarios, auth, {
      iterations: config.iterations,
      warmupIterations: config.warmupIterations,
      parallelRunsPerScenario: config.parallelRunsPerScenario,
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
    try {
      await cleanupDb(idCollector, auth.userId);
    } catch (err) {
      console.error('  Error during DB cleanup:', err);
    }
  }
}

main().catch((err) => {
  console.error(
    '\nFatal error:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
