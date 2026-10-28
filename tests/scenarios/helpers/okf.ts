/**
 * okf.ts — OKF (knowledge base) session trees for the OKF usage scenarios
 * (docs/tasks/todo/2026-10-27-okf-usage-tab/impl-plan.md, DD-36).
 *
 * `okfSessionTree()` builds, inline and without a golden fixture, what the hook uploads for one
 * session tree that reads a repository's KB:
 *   - an `artisyn` body with the `okf-snapshot-ref` line, the full `okf-snapshot` line (unless the
 *     snapshot is sent ref-only or the session stands for an old hook without OKF support), and
 *     the prompt_start / prompt_stop pair that gives the session its repository, branch and
 *     `git.root`;
 *   - a `claude` body for the main agent and one `claude-subagent` body per sub-agent, whose
 *     tool calls (Read, Grep over a folder, Edit) are what the server's OKF extraction turns into
 *     `session_okf_access` rows. Each Read's `tool_result` is `bytes` long, so the read bytes are
 *     exactly what the scenario says.
 *
 * `uploadOkfSessionTree()` posts them in hook order (artisyn first, so the repo roots are known
 * when the transcripts land) through `POST /api/v2/logs` and waits until the queue is idle.
 * Because no golden fixture changes, the gs-01…gs-09 session counts other scenarios assert stay
 * the same.
 */
import { createHash } from 'crypto';
import type { APIRequestContext } from '@playwright/test';
import type { Pool } from 'pg';
import { ndjson } from './ingest';
import { waitForQueueIdle } from './queue';

const DAY_MS = 24 * 60 * 60 * 1000;
const MODEL = 'claude-sonnet-4-6';
const USAGE = { input_tokens: 40, output_tokens: 10 };

/** The working directory every OKF session reports as its `git.root` (POSIX, OS-independent). */
export const OKF_REPO_ROOT = '/work/okf-repo';

/** One file of a snapshot bundle (repo-relative path). */
export interface OkfSnapshotFileSpec {
  path: string;
  /** UTF-8 bytes on disk. Default 1000. */
  size?: number;
  /** Gitignored. Default false. */
  ignored?: boolean;
}

/** One bundle: its root folder and its files (its `index.md` is added when missing). */
export interface OkfBundleSpec {
  root: string;
  /** Gitignored `index.md` → the whole bundle is ignored. Default false. */
  ignored?: boolean;
  files: Array<string | OkfSnapshotFileSpec>;
}

/** What the snapshot the hook detected looks like. */
export interface OkfSnapshotSpec {
  bundles: OkfBundleSpec[];
}

/**
 * One tool call of an agent, in transcript order:
 *  - `read`: the Read tool on a repo-relative file, its result `bytes` long (default 1000);
 *  - `grep`: the Grep tool over a repo-relative folder (or file), result `bytes` long (default 100);
 *  - `edit`: the Edit tool on a repo-relative file.
 */
export type OkfAction =
  | { read: string; bytes?: number }
  | { grep: string; bytes?: number }
  | { edit: string };

export interface OkfSubAgentSpec {
  /** String session id of the sub-agent (the hook's `agent-<id>`). */
  agentId: string;
  /** The task the parent gave it — its first user message. */
  task: string;
  actions: OkfAction[];
}

export interface OkfSessionTreeSpec {
  sessionId: string;
  /** Git remote of the repository. */
  repoUrl: string;
  /** Default `main`. */
  branch?: string;
  /** The user's prompt. Default `read the KB`. */
  prompt?: string;
  /** Session start. Default one day ago, so "last 30 days" ranges include it. */
  at?: Date;
  /** Main-agent tool calls, in order. */
  actions?: OkfAction[];
  subAgents?: OkfSubAgentSpec[];
  /**
   * The KB snapshot the hook sent. `null` = an old hook without OKF support: no OKF line at
   * all, the session stays unbound (`okf_snapshot_id` null).
   */
  snapshot: OkfSnapshotSpec | null;
  /**
   * `false`: the hook already knew the id, so this upload carries only the `okf-snapshot-ref`
   * line (the snapshot must already be stored for the same user). Default true (full line too).
   */
  sendFull?: boolean;
}

/** One upload of the tree, exactly as the hook would send it. */
export interface OkfUpload {
  params: Record<string, string>;
  body: string;
}

export interface OkfSessionTree {
  /** In upload order: artisyn, claude, then every claude-subagent. */
  uploads: OkfUpload[];
  /** The DD-14 id of the snapshot, or null when `snapshot` is null. */
  okfSnapshotId: string | null;
  /** The snapshot body as stored in `okf_snapshots.body` (null without a snapshot). */
  snapshotBody: OkfSnapshotBody | null;
}

export interface OkfSnapshotBody {
  type: 'okf-snapshot';
  okfSnapshotId: string;
  schemaVersion: 1;
  bundles: Array<{
    root: string;
    index: string;
    ignored: boolean;
    files: Array<{ path: string; ignored: boolean; size: number; hash: string }>;
  }>;
}

/** The DD-13 body of `spec`, with the DD-14 id (sorted bundles and files, never mtime). */
export function okfSnapshotBody(spec: OkfSnapshotSpec): OkfSnapshotBody {
  const bundles = spec.bundles
    .map((b) => {
      const index = `${b.root}/index.md`;
      const files = b.files.map((f) => (typeof f === 'string' ? { path: f } : f));
      if (!files.some((f) => f.path === index)) files.push({ path: index });
      return {
        root: b.root,
        index,
        ignored: b.ignored ?? false,
        files: files
          .map((f) => ({
            path: f.path,
            ignored: f.path === index ? (b.ignored ?? f.ignored ?? false) : (f.ignored ?? false),
            size: f.size ?? 1000,
            hash: createHash('sha256').update(`okf-scenario:${f.path}:${f.size ?? 1000}`).digest('hex'),
          }))
          .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)),
      };
    })
    .sort((x, y) => (x.root < y.root ? -1 : x.root > y.root ? 1 : 0));
  const okfSnapshotId = createHash('sha256').update(JSON.stringify(bundles)).digest('hex');
  return { type: 'okf-snapshot', okfSnapshotId, schemaVersion: 1, bundles };
}

const abs = (rel: string): string => `${OKF_REPO_ROOT}/${rel.replace(/\/+$/, '')}`;

/** The user / assistant / tool-result lines of one agent's transcript. */
function agentLines(
  sessionId: string,
  idPrefix: string,
  prompt: string,
  actions: readonly OkfAction[],
  start: Date,
  sidechain: boolean,
): object[] {
  const common = { sessionId, cwd: OKF_REPO_ROOT, ...(sidechain ? { isSidechain: true } : {}) };
  const at = (s: number) => new Date(start.getTime() + s * 1000).toISOString();
  const lines: object[] = [
    { type: 'user', uuid: `${idPrefix}-u0`, timestamp: at(0), ...common, message: { role: 'user', content: prompt } },
  ];
  let parent = `${idPrefix}-u0`;
  actions.forEach((action, i) => {
    const toolId = `toolu_${idPrefix}_${i}`;
    let toolUse: object;
    let result: string;
    if ('read' in action) {
      toolUse = { type: 'tool_use', id: toolId, name: 'Read', input: { file_path: abs(action.read) } };
      result = 'r'.repeat(action.bytes ?? 1000);
    } else if ('grep' in action) {
      toolUse = { type: 'tool_use', id: toolId, name: 'Grep', input: { pattern: 'TODO', path: abs(action.grep) } };
      result = 'g'.repeat(action.bytes ?? 100);
    } else {
      toolUse = {
        type: 'tool_use',
        id: toolId,
        name: 'Edit',
        input: { file_path: abs(action.edit), old_string: 'old', new_string: 'new' },
      };
      result = 'The file has been updated.';
    }
    const a = `${idPrefix}-a${i}`;
    const r = `${idPrefix}-r${i}`;
    lines.push(
      {
        type: 'assistant',
        uuid: a,
        parentUuid: parent,
        timestamp: at(10 + i * 10),
        ...common,
        message: { id: `msg_${idPrefix}_${i}`, role: 'assistant', model: MODEL, usage: USAGE, content: [toolUse] },
      },
      {
        type: 'user',
        uuid: r,
        parentUuid: a,
        timestamp: at(11 + i * 10),
        ...common,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result }] },
      },
    );
    parent = r;
  });
  lines.push({
    type: 'assistant',
    uuid: `${idPrefix}-done`,
    parentUuid: parent,
    timestamp: at(20 + actions.length * 10),
    ...common,
    message: {
      id: `msg_${idPrefix}_done`,
      role: 'assistant',
      model: MODEL,
      usage: USAGE,
      content: [{ type: 'text', text: 'Done.' }],
    },
  });
  return lines;
}

/** The uploads of one OKF session tree (DD-36). */
export function okfSessionTree(spec: OkfSessionTreeSpec): OkfSessionTree {
  const start = spec.at ?? new Date(Date.now() - DAY_MS);
  const prompt = spec.prompt ?? 'read the KB';
  const git = { repo: spec.repoUrl, branch: spec.branch ?? 'main', root: OKF_REPO_ROOT, worktreeRoot: OKF_REPO_ROOT };
  const snapshot = spec.snapshot === null ? null : okfSnapshotBody(spec.snapshot);
  const sendFull = spec.sendFull ?? true;

  const okfLines: object[] =
    snapshot === null
      ? []
      : [
          { type: 'okf-snapshot-ref', okfSnapshotId: snapshot.okfSnapshotId },
          ...(sendFull ? [snapshot] : []),
        ];
  const subAgents = spec.subAgents ?? [];
  const endAt = new Date(start.getTime() + (60 + subAgents.length * 60 + (spec.actions?.length ?? 0) * 10) * 1000);
  const artisyn = ndjson([
    ...okfLines,
    { event: 'prompt_start', timestamp: start.toISOString(), session_id: spec.sessionId, prompt, git },
    { event: 'prompt_stop', timestamp: endAt.toISOString(), session_id: spec.sessionId },
  ]);
  const artisynParams: Record<string, string> = { sessionId: spec.sessionId, type: 'artisyn' };
  if (snapshot !== null) {
    artisynParams.okfSnapshotId = snapshot.okfSnapshotId;
    if (sendFull) artisynParams.okfSnapshotFull = '1';
  }

  const uploads: OkfUpload[] = [
    { params: artisynParams, body: artisyn },
    {
      params: { sessionId: spec.sessionId, type: 'claude' },
      body: ndjson(agentLines(spec.sessionId, spec.sessionId, prompt, spec.actions ?? [], start, false)),
    },
  ];
  subAgents.forEach((agent, i) => {
    const agentStart = new Date(start.getTime() + (30 + i * 60) * 1000);
    uploads.push({
      params: { sessionId: agent.agentId, type: 'claude-subagent', parentSessionId: spec.sessionId },
      body: ndjson(agentLines(spec.sessionId, agent.agentId, agent.task, agent.actions, agentStart, true)),
    });
  });
  return { uploads, okfSnapshotId: snapshot?.okfSnapshotId ?? null, snapshotBody: snapshot };
}

/**
 * Uploads the tree with `apiKey` in hook order, throws on any non-201, then waits until the key
 * owner's queue is idle so the session, its OKF rows and its snapshot binding are queryable.
 */
export async function uploadOkfSessionTree(
  api: APIRequestContext,
  apiKey: string,
  spec: OkfSessionTreeSpec,
  queue: { db: Pool; userId: number },
): Promise<OkfSessionTree> {
  const tree = okfSessionTree(spec);
  for (const u of tree.uploads) {
    const res = await api.post('/api/v2/logs', {
      params: u.params,
      headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': apiKey },
      data: u.body,
    });
    if (res.status() !== 201) {
      throw new Error(`Uploading ${u.params.type} of ${u.params.sessionId} failed (${res.status()}): ${await res.text()}`);
    }
    // Hook order: the artisyn log (repo, roots, snapshot binding) is processed first.
    await waitForQueueIdle(queue.db, queue.userId);
  }
  return tree;
}
