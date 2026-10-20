/**
 * prompt-session.ts — the smallest session a hook upload can carry: one artisyn log with a
 * single `prompt_start` (or `turns` of them; so the session gets a `firstPrompt`, a repository and a branch) and one
 * claude log with the matching user turn and a short assistant answer. Sent through
 * `POST /api/v2/logs` with `X-API-Key` (impl-plan DD SC3), the way the hook does.
 *
 * For scenarios that care about who sees which session, not about numbers: every session gets
 * its own prompt text, so a visibility check is a plain "is this prompt in the response".
 * Sessions that must match exact cost or token numbers use the golden fixtures (`golden.ts`).
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { Pool } from 'pg';
import { waitForQueueIdle } from './queue';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PromptSession {
  /** String session id the hook would send. */
  sessionId: string;
  /** First (and only) prompt — becomes `firstPrompt`. */
  prompt: string;
  /** Git remote of the repository the session belongs to. */
  repoUrl: string;
  /** Default `main`. */
  branch?: string;
  /** Prompt time. Default: one day ago, so "last 30 days" ranges and the session list include it. */
  at?: Date;
  /**
   * Number of prompt turns (default 1). Turn n > 1 is the prompt `<prompt> (turn n)`, two minutes
   * after the previous one; every turn adds one `prompt_start`/`prompt_stop` pair and one
   * user/assistant pair, so a longer upload of the same session has strictly more lines.
   */
  turns?: number;
  /**
   * Hook context pairs (`{ key: value }`) carried on the first `prompt_start`, the way the hook
   * reports CLAUDE.md and other context: they become the session's and repository's contexts.
   */
  context?: Record<string, string>;
  /**
   * Repo-relative paths the first turn reads with the `Read` tool (e.g. `docs/guide.md`): an
   * assistant `tool_use` per path under the session's working directory plus its
   * `tool_result`, so `session_file_stats` gets one file per path in the category the config
   * picks. The working directory is sent as `git.root` so paths classify repo-relative.
   * Without `reads` the logs are unchanged.
   */
  reads?: string[];
}

/** Working directory a session with `reads` reports as its git root. */
const READS_ROOT = '/work/scn-repo';

/** The two NDJSON bodies of a {@link PromptSession}: `artisyn` and `claude`. */
export function promptSessionBodies(s: PromptSession): { artisyn: string; claude: string } {
  const first = s.at ?? new Date(Date.now() - DAY_MS);
  const reads = s.reads ?? [];
  const git = {
    repo: s.repoUrl,
    branch: s.branch ?? 'main',
    ...(reads.length > 0 ? { root: READS_ROOT } : {}),
  };
  const artisyn: object[] = [];
  const claude: object[] = [];
  for (let n = 1; n <= (s.turns ?? 1); n += 1) {
    const at = new Date(first.getTime() + (n - 1) * 120_000);
    const stop = new Date(at.getTime() + 60_000);
    const prompt = n === 1 ? s.prompt : `${s.prompt} (turn ${n})`;
    artisyn.push(
      {
        event: 'prompt_start',
        timestamp: at.toISOString(),
        session_id: s.sessionId,
        prompt,
        git,
        ...(n === 1 && s.context ? { context: s.context } : {}),
      },
      { event: 'prompt_stop', timestamp: stop.toISOString(), session_id: s.sessionId },
    );
    claude.push({
      type: 'user',
      uuid: `${s.sessionId}-u${n}`,
      ...(n > 1 ? { parentUuid: `${s.sessionId}-a${n - 1}` } : {}),
      sessionId: s.sessionId,
      timestamp: at.toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    });
    let answerParent = `${s.sessionId}-u${n}`;
    if (n === 1 && reads.length > 0) {
      const readAt = new Date(at.getTime() + 20_000).toISOString();
      const toolIds = reads.map((_, i) => `${s.sessionId}-read${i}`);
      claude.push(
        {
          type: 'assistant',
          uuid: `${s.sessionId}-ar`,
          parentUuid: answerParent,
          sessionId: s.sessionId,
          timestamp: readAt,
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 5 },
            content: reads.map((path, i) => ({
              type: 'tool_use',
              id: toolIds[i],
              name: 'Read',
              input: { file_path: `${READS_ROOT}/${path}` },
            })),
          },
        },
        {
          type: 'user',
          uuid: `${s.sessionId}-ur`,
          parentUuid: `${s.sessionId}-ar`,
          sessionId: s.sessionId,
          timestamp: readAt,
          message: {
            role: 'user',
            content: reads.map((path, i) => ({
              type: 'tool_result',
              tool_use_id: toolIds[i],
              content: `contents of ${path}`,
            })),
          },
        },
      );
      answerParent = `${s.sessionId}-ur`;
    }
    claude.push(
      {
        type: 'assistant',
        uuid: `${s.sessionId}-a${n}`,
        parentUuid: answerParent,
        sessionId: s.sessionId,
        timestamp: stop.toISOString(),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
    );
  }
  return { artisyn: toNdjson(artisyn), claude: toNdjson(claude) };
}

function toNdjson(rows: object[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Posts one log of the session with whatever credentials `headers` carry (an `X-API-Key`, or
 * nothing when `api` holds a session cookie) and returns the raw response — for scenarios that
 * assert on the status of a refused upload.
 */
export function postSessionLog(
  api: APIRequestContext,
  s: PromptSession,
  type: 'artisyn' | 'claude',
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  const body = promptSessionBodies(s)[type];
  return api.post('/api/v2/logs', {
    params: { sessionId: s.sessionId, type },
    headers: { 'Content-Type': 'application/x-ndjson', ...headers },
    data: body,
  });
}

/**
 * Uploads both logs of the session with `apiKey`, throws on any non-201, then waits until the
 * key owner's upload queue is idle so the session is queryable.
 */
export async function uploadPromptSession(
  api: APIRequestContext,
  apiKey: string,
  s: PromptSession,
  queue: { db: Pool; userId: number },
): Promise<void> {
  for (const type of ['artisyn', 'claude'] as const) {
    const res = await postSessionLog(api, s, type, { 'X-API-Key': apiKey });
    if (res.status() !== 201) {
      throw new Error(`Uploading ${type} log of ${s.sessionId} failed (${res.status()}): ${await res.text()}`);
    }
  }
  await waitForQueueIdle(queue.db, queue.userId);
}

/**
 * Uploads one sub-agent transcript under `parentSessionId` the way the hook does
 * (`type=claude-subagent` with `parentSessionId`): one user/assistant pair whose assistant line
 * carries `usage`, so the agent adds tokens and cost to the parent's tree. Waits for the queue.
 */
export async function uploadSubagent(
  api: APIRequestContext,
  apiKey: string,
  agent: { sessionId: string; parentSessionId: string; prompt: string; at?: Date },
  queue: { db: Pool; userId: number },
): Promise<void> {
  const at = agent.at ?? new Date(Date.now() - DAY_MS + 30_000);
  const stop = new Date(at.getTime() + 20_000);
  const body = toNdjson([
    {
      type: 'user',
      uuid: `${agent.sessionId}-u1`,
      sessionId: agent.sessionId,
      isSidechain: true,
      timestamp: at.toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: agent.prompt }] },
    },
    {
      type: 'assistant',
      uuid: `${agent.sessionId}-a1`,
      parentUuid: `${agent.sessionId}-u1`,
      sessionId: agent.sessionId,
      isSidechain: true,
      timestamp: stop.toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 400, output_tokens: 200 },
        content: [{ type: 'text', text: 'Agent done.' }],
      },
    },
  ]);
  const res = await api.post('/api/v2/logs', {
    params: { sessionId: agent.sessionId, type: 'claude-subagent', parentSessionId: agent.parentSessionId },
    headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': apiKey },
    data: body,
  });
  if (res.status() !== 201) {
    throw new Error(`Uploading sub-agent ${agent.sessionId} failed (${res.status()}): ${await res.text()}`);
  }
  await waitForQueueIdle(queue.db, queue.userId);
}

/** `startDate`/`endDate` (YYYY-MM-DD) spanning a few days around `at` — for analytics and report routes. */
export function rangeAround(at: Date = new Date(Date.now() - DAY_MS)): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return `startDate=${day(new Date(at.getTime() - 3 * DAY_MS))}&endDate=${day(new Date(at.getTime() + 2 * DAY_MS))}`;
}

/** `repositories.id` of the caller's own repository with `repoUrl` (via `GET /api/v1/repositories`). */
export async function ownRepoId(api: APIRequestContext, repoUrl: string): Promise<number> {
  const res = await api.get('/api/v1/repositories');
  if (!res.ok()) throw new Error(`GET /api/v1/repositories failed (${res.status()})`);
  const repos = (await res.json()) as Array<{ id: number; repoUrl: string }>;
  const repo = repos.find((r) => r.repoUrl === repoUrl);
  if (!repo) {
    throw new Error(`No own repository ${repoUrl}; have: ${repos.map((r) => r.repoUrl).join(', ') || 'none'}`);
  }
  return repo.id;
}
