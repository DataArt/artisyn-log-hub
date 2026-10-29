/**
 * tool-monitoring.ts — Tools/MCP tab session trees for the tool-monitoring scenarios
 * (docs/tasks/todo/2026-06-19-mcp-invocation-log-tab/impl-plan.md, Chunk 18).
 *
 * - `toolSessionTree()` builds, inline and without a golden fixture, what the hook uploads for one
 *   session whose agent calls MCP servers and runs shell commands: an `artisyn` body whose
 *   prompt_start / prompt_stop give the session its repository, and a `claude` body with one
 *   `tool_use` / `tool_result` pair per step (the transcript builder of `okf.ts` is reused). It
 *   also returns each step's `tool_use` id and times, so wrapper records can be placed inside the
 *   matching window (DD-12: `[tool_use − 2 s, tool_result + 2 s]`).
 * - `buildToolCallsLog()` writes the hook's `tool-calls` NDJSON (DD-6): one `tool_call` line per
 *   wrapped CLI call and, optionally, one `tool_wrap_status` line. `uploadToolCallsLog()` posts it
 *   as log kind `tool-calls` for the tree root.
 * - `waitForToolUsage()` polls the tab's summary route until the background rebuild drain
 *   (DD-7; every second on the stand, `TOOL_USAGE_REBUILD_INTERVAL_MS`) has processed every
 *   in-scope session and the expected number of calls is there.
 *
 * Because no golden fixture changes, the session counts other scenarios assert stay the same.
 */
import type { APIRequestContext } from '@playwright/test';
import type { Pool } from 'pg';
import { ndjson } from './ingest';
import {
  agentStepAt,
  agentToolUseId,
  agentTranscriptLines,
  postUploadsInOrder,
  type AgentToolStep,
  type OkfUpload,
} from './okf';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The working directory every tool session reports as its `git.root` (POSIX, OS-independent). */
export const TOOL_REPO_ROOT = '/work/tool-repo';

/**
 * One step of the agent, in transcript order:
 *  - `mcp`: an MCP tool call by its full name (`mcp__<server>__<operation>`);
 *  - `bash`: the Bash tool running `command`.
 * `result` is the text the agent got back; `isError` marks the result `is_error: true`.
 */
export type ToolSessionStep =
  | { mcp: string; input?: Record<string, unknown>; result: string; isError?: boolean }
  | { bash: string; result: string; isError?: boolean };

export interface ToolSessionSpec {
  sessionId: string;
  /** Git remote of the repository. */
  repoUrl: string;
  /** The user's prompt. Default `use the tools`. */
  prompt?: string;
  /** Session start. Default one day ago, so the tab's default «last 30 days» includes it. */
  at?: Date;
  steps: ToolSessionStep[];
}

/** Where step i of the transcript sits: its `tool_use` id and times. */
export interface ToolSessionStepRef {
  toolUseId: string;
  toolUseAt: Date;
  resultAt: Date;
}

export interface ToolSessionTree {
  /** In upload order: artisyn, then claude. */
  uploads: OkfUpload[];
  steps: ToolSessionStepRef[];
}

function agentStep(step: ToolSessionStep): AgentToolStep {
  if ('mcp' in step) {
    return { name: step.mcp, input: step.input ?? {}, result: step.result, isError: step.isError };
  }
  return {
    name: 'Bash',
    input: { command: step.bash, description: 'Run a monitored tool' },
    result: step.result,
    isError: step.isError,
  };
}

/** The uploads of one tool session (artisyn + claude), plus where each step sits. */
export function toolSessionTree(spec: ToolSessionSpec): ToolSessionTree {
  const start = spec.at ?? new Date(Date.now() - DAY_MS);
  const prompt = spec.prompt ?? 'use the tools';
  const endAt = new Date(start.getTime() + (60 + spec.steps.length * 10) * 1000);
  const git = { repo: spec.repoUrl, branch: 'main', root: TOOL_REPO_ROOT, worktreeRoot: TOOL_REPO_ROOT };
  const artisyn = ndjson([
    { event: 'prompt_start', timestamp: start.toISOString(), session_id: spec.sessionId, prompt, git },
    { event: 'prompt_stop', timestamp: endAt.toISOString(), session_id: spec.sessionId },
  ]);
  const claude = ndjson(
    agentTranscriptLines(
      { sessionId: spec.sessionId, idPrefix: spec.sessionId, prompt, start, sidechain: false, cwd: TOOL_REPO_ROOT },
      spec.steps.map(agentStep),
    ),
  );
  return {
    uploads: [
      { params: { sessionId: spec.sessionId, type: 'artisyn' }, body: artisyn },
      { params: { sessionId: spec.sessionId, type: 'claude' }, body: claude },
    ],
    steps: spec.steps.map((_, i) => {
      const at = agentStepAt(start, i);
      return { toolUseId: agentToolUseId(spec.sessionId, i), toolUseAt: at.toolUse, resultAt: at.result };
    }),
  };
}

/** Uploads the tree in hook order and waits for the queue (see `postUploadsInOrder`). */
export async function uploadToolSessionTree(
  api: APIRequestContext,
  apiKey: string,
  spec: ToolSessionSpec,
  queue: { db: Pool; userId: number },
): Promise<ToolSessionTree> {
  const tree = toolSessionTree(spec);
  await postUploadsInOrder(api, apiKey, tree.uploads, queue);
  return tree;
}

/** One wrapped CLI call, as the hook's wrapper recorded it. */
export interface WrapperCallSpec {
  callId: string;
  /** The root session id the wrapper ran under. */
  sessionId: string;
  tool: string;
  args: string[];
  startedAt: Date;
  /** Default 150 ms. Ignored when `exitCode` is null (no exit record: killed). */
  durationMs?: number;
  /** null = the call never wrote its exit record. */
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  stdin?: string;
  /** The consumer closed stdout early (`| head -1`). Default false. */
  consumerClosed?: boolean;
  /** Default false. */
  truncated?: boolean;
  /** Default `full`; `meta` sends no text. */
  capture?: 'full' | 'meta';
  /** Default `bash`. */
  shell?: 'bash' | 'powershell';
  /** Default `TOOL_REPO_ROOT`. */
  cwd?: string;
  /** Default `/usr/local/bin/<tool>`. */
  real?: string;
}

/** The hook's wrapper status line (DD-6 `tool_wrap_status`). */
export interface WrapStatusSpec {
  hookVersion: string;
  os: string;
  at: Date;
  /** Default `{ ok: true, reason: null }`. */
  preflight?: { ok: boolean; reason: string | null };
  /** Default `{ global: false, tools: [] }`. */
  breaker?: { global: boolean; tools: string[] };
}

const utf8Bytes = (text: string | undefined): number => (text === undefined ? 0 : Buffer.byteLength(text, 'utf8'));

/** The `tool-calls` NDJSON body (DD-6): one `tool_call` line per call, then the status line. */
export function buildToolCallsLog(calls: readonly WrapperCallSpec[], status?: WrapStatusSpec): string {
  const lines: object[] = calls.map((c) => {
    const capture = c.capture ?? 'full';
    const finished = c.exitCode !== null;
    const durationMs = finished ? (c.durationMs ?? 150) : null;
    const text =
      capture === 'full'
        ? {
            ...(c.stdin !== undefined ? { stdin: c.stdin } : {}),
            ...(c.stdout !== undefined ? { stdout: c.stdout } : {}),
            ...(c.stderr !== undefined ? { stderr: c.stderr } : {}),
          }
        : {};
    return {
      type: 'tool_call',
      schema: 1,
      callId: c.callId,
      sessionId: c.sessionId,
      tool: c.tool,
      args: c.args,
      real: c.real ?? `/usr/local/bin/${c.tool}`,
      cwd: c.cwd ?? TOOL_REPO_ROOT,
      shell: c.shell ?? 'bash',
      startedAt: c.startedAt.toISOString(),
      endedAt: durationMs === null ? null : new Date(c.startedAt.getTime() + durationMs).toISOString(),
      exitCode: c.exitCode,
      durationMs,
      bytes: { stdin: utf8Bytes(c.stdin), stdout: utf8Bytes(c.stdout), stderr: utf8Bytes(c.stderr) },
      consumerClosed: c.consumerClosed ?? false,
      truncated: c.truncated ?? false,
      capture,
      ...text,
      encoding: 'utf8',
    };
  });
  if (status) {
    lines.push({
      type: 'tool_wrap_status',
      schema: 1,
      hookVersion: status.hookVersion,
      os: status.os,
      preflight: { ...(status.preflight ?? { ok: true, reason: null }), shells: { bash: true, powershell: false } },
      breaker: status.breaker ?? { global: false, tools: [] },
      at: status.at.toISOString(),
    });
  }
  return ndjson(lines);
}

/** Posts a `tool-calls` log for the tree root `sessionId`, throws on a non-201, waits for the queue. */
export async function uploadToolCallsLog(
  api: APIRequestContext,
  apiKey: string,
  sessionId: string,
  body: string,
  queue: { db: Pool; userId: number },
): Promise<void> {
  await postUploadsInOrder(api, apiKey, [{ params: { sessionId, type: 'tool-calls' }, body }], queue);
}

/** Figures of a set of calls in the summary route (`Agg`). */
export interface ToolUsageAgg {
  calls: number;
  errors: number;
  killed: number;
  noResult: number;
  empty: number;
  retried: number;
  openedFile: number;
  avgDurationMs: number | null;
  inBytes: number;
  outBytes: number;
}

/** `GET …/tool-monitoring/summary`. */
export interface ToolUsageSummary {
  range: { from: string; to: string };
  pendingSessions: number;
  totals: ToolUsageAgg;
  groups: { mcp: { tools: number } & ToolUsageAgg; cli: { tools: number } & ToolUsageAgg };
  tools: Array<
    ToolUsageAgg & {
      channel: 'mcp' | 'cli';
      tool: string;
      lastUsedAt: string | null;
      operations: Array<ToolUsageAgg & { operation: string; lastUsedAt: string | null }>;
    }
  >;
  neverCalled: string[];
}

/** `GET …/tool-monitoring/summary` of `repoId` (personal view, or the team view of `teamId`). */
export async function fetchToolSummary(
  api: APIRequestContext,
  repoId: number,
  teamId?: number,
): Promise<{ status: number; body: ToolUsageSummary | null }> {
  const res = await api.get(`/api/v1/repositories/${repoId}/tool-monitoring/summary`, {
    params: teamId === undefined ? {} : { teamId },
  });
  return { status: res.status(), body: res.ok() ? ((await res.json()) as ToolUsageSummary) : null };
}

/**
 * Polls the summary until no in-scope session is pending a rebuild and at least `minCalls`
 * calls are counted; returns that summary. Throws with the last one after `timeoutMs`.
 */
export async function waitForToolUsage(
  api: APIRequestContext,
  repoId: number,
  { minCalls, teamId, timeoutMs = 30_000 }: { minCalls: number; teamId?: number; timeoutMs?: number },
): Promise<ToolUsageSummary> {
  const deadline = Date.now() + timeoutMs;
  let last: ToolUsageSummary | null = null;
  for (;;) {
    const { status, body } = await fetchToolSummary(api, repoId, teamId);
    if (status !== 200 || body === null) throw new Error(`GET tool-monitoring/summary of repo ${repoId} failed (${status})`);
    last = body;
    if (body.pendingSessions === 0 && body.totals.calls >= minCalls) return body;
    if (Date.now() > deadline) {
      throw new Error(
        `tool usage of repo ${repoId} not rebuilt in ${timeoutMs} ms: pending ${last.pendingSessions}, calls ${last.totals.calls} (want ≥ ${minCalls})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
