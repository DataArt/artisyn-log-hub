/**
 * OKF usage — the facts route (`GET /api/v2/okf-usage/facts`, FR-20; impl-plan DD-33, DD-34).
 *
 * The local KB-completeness skill asks for the facts of one of the caller's own sessions: the
 * user's prompts, per agent the KB articles it read (in first-access order), its other top reads
 * and its changes, plus the tree-wide union of changes, reads and run labels. Everything is
 * rebuilt by reparsing the stored `claude` / `claude-subagent` bodies of the tree — never from
 * `session_okf_access` — and no tool result text ever leaves the server, only paths, byte counts
 * and labels.
 *
 * Ownership (DD-33): the session is found by its `sessions.session_id` string and must have a
 * `logs` row of the API key's user; a missing session and a foreign one both get the same 404.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { analyzeBash, type BashParser } from '@loghub/bash-view';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { sessionIdsArray } from '../analytics/scoped-sessions.sql';
import { loadArtisynRootsBySessionIds } from '../change-surface/changed-paths.sql';
import {
  resolveRepoPath,
  truncateChangedPath,
} from '../change-surface/path-normalise';
import { getDescendantSessionIds } from '../session-tree.sql';
import {
  extractOkfAccess,
  toAbsolute,
  toolResultBytes,
  type OkfAccessRow,
} from './okf-access-extractor';
import {
  loadOkfSnapshot,
  resolveRootOkfSnapshotId,
  type OkfSnapshotBody,
} from './okf-snapshot';
import { filterUserPrompts } from './okf-task-context';
import type { OkfFactsResponse } from './okf-usage.types';
import { bundleOfPath } from './okf-verdict';
import { getServerBashParser } from './server-bash-parser';

/** DD-18: top non-KB reads per agent. */
export const OKF_FACTS_OTHER_READS_TOP = 20;
/** DD-18: a prompt longer than this is cut (suffix `…`). */
export const OKF_FACTS_MAX_PROMPT_CHARS = 4000;

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as AnyRecord)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function cutPrompt(text: string): string {
  return text.length > OKF_FACTS_MAX_PROMPT_CHARS
    ? `${text.slice(0, OKF_FACTS_MAX_PROMPT_CHARS)}…`
    : text;
}

/** What one node read, changed and ran — repo-relative paths, any extension. */
export interface NodeFileFacts {
  /** Path → read bytes (Read tool + `analyzeBash` reads; a Bash call's bytes split evenly). */
  reads: Map<string, number>;
  /** Written paths (Edit / MultiEdit / Write / NotebookEdit + `analyzeBash` changes). */
  changes: Set<string>;
  /** `analyzeBash` `runs` labels, first-seen order. */
  runs: string[];
}

/**
 * Walks one transcript for the facts route (DD-34): same visibility, cwd, dedupe and byte rules
 * as `extractOkfAccess`, but keeps every file read (not only `.md`) and the run labels.
 */
export function collectNodeFileFacts(
  entries: readonly object[],
  roots: readonly string[],
  parser: BashParser | null,
  isSubagentLog: boolean,
): NodeFileFacts {
  const facts: NodeFileFacts = {
    reads: new Map(),
    changes: new Set(),
    runs: [],
  };
  const visible = entries.filter(
    (line) => isSubagentLog || (line as AnyRecord)['isSidechain'] !== true,
  );

  const resultBytes = new Map<string, number>();
  for (const line of visible) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'user') continue;
    const content = asRecord(rec['message'])?.['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_result') continue;
      const id = asString(b['tool_use_id']);
      if (id === null || resultBytes.has(id)) continue;
      resultBytes.set(id, toolResultBytes(b['content']));
    }
  }

  const resolve = (
    p: string | null,
    ...bases: (string | null)[]
  ): string | null => {
    if (p === null || roots.length === 0) return null;
    const abs = toAbsolute(p, ...bases);
    if (abs === null) return null;
    const rel = resolveRepoPath(abs, roots);
    return rel === null || rel === '' ? null : truncateChangedPath(rel);
  };
  const runsSeen = new Set<string>();
  const seenIds = new Set<string>();
  let cwd: string | null = null;

  for (const line of visible) {
    const rec = line as AnyRecord;
    const lineCwd = asString(rec['cwd']);
    if (lineCwd !== null && lineCwd !== '') cwd = lineCwd;
    if (rec['type'] !== 'assistant') continue;
    const content = asRecord(rec['message'])?.['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_use') continue;
      const id = asString(b['id']);
      if (id !== null) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      const name = asString(b['name']);
      const input = asRecord(b['input']);
      if (name === null || input === null) continue;
      const bytes = id === null ? 0 : (resultBytes.get(id) ?? 0);

      switch (name) {
        case 'Read': {
          const rel = resolve(asString(input['file_path']), cwd);
          if (rel !== null) {
            facts.reads.set(rel, (facts.reads.get(rel) ?? 0) + bytes);
          }
          break;
        }
        case 'Edit':
        case 'MultiEdit':
        case 'Write':
        case 'NotebookEdit': {
          const raw =
            name === 'NotebookEdit'
              ? asString(input['notebook_path'])
              : asString(input['file_path']);
          const rel = resolve(raw, cwd);
          if (rel !== null) facts.changes.add(rel);
          break;
        }
        case 'Bash': {
          if (parser === null) break;
          const command = asString(input['command']);
          if (command === null || command.trim() === '') break;
          let analysis: ReturnType<typeof analyzeBash>;
          try {
            analysis = analyzeBash(parser, command);
          } catch {
            break;
          }
          for (const label of analysis.runs) {
            if (!runsSeen.has(label)) {
              runsSeen.add(label);
              facts.runs.push(label);
            }
          }
          const reads = [
            ...new Set(
              analysis.reads
                .map((p) => resolve(p, analysis.workDir, cwd))
                .filter((p): p is string => p !== null),
            ),
          ];
          const share = reads.length > 0 ? Math.floor(bytes / reads.length) : 0;
          const remainder = bytes - share * reads.length;
          reads.forEach((rel, i) => {
            const add = share + (i === 0 ? remainder : 0);
            facts.reads.set(rel, (facts.reads.get(rel) ?? 0) + add);
          });
          for (const p of analysis.changes) {
            const rel = resolve(p, analysis.workDir, cwd);
            if (rel !== null) facts.changes.add(rel);
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return facts;
}

interface FactsNode {
  id: number;
  sessionId: string;
  parentSessionId: string | null;
  startTime: number | null;
  lines: object[];
  isSubagent: boolean;
}

@Injectable()
export class OkfFactsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * The facts of the caller's own session tree (DD-34). Throws `NotFoundException` for a
   * missing session and for a session the caller does not own alike (DD-33).
   */
  async getFacts(
    sessionIdString: string,
    userId: number,
  ): Promise<OkfFactsResponse> {
    const ownedResult = await this.db.execute(sql`
      SELECT s.id
      FROM sessions s
      WHERE s.session_id = ${sessionIdString}
        AND s.deleted = false
        AND EXISTS (
          SELECT 1 FROM logs l WHERE l.session_id = s.id AND l.user_id = ${userId}
        )
      ORDER BY s.id
      LIMIT 1
    `);
    const owned = ownedResult.rows[0] as { id: string | number } | undefined;
    if (owned === undefined) throw new NotFoundException();
    const rootId = Number(owned.id);

    const descendants =
      (await getDescendantSessionIds(this.db, [rootId])).get(rootId) ?? [];
    const nodeIds = [rootId, ...descendants];

    const [nodes, rootsBySessionId, snapshot, startedAt, parser] =
      await Promise.all([
        this.loadNodes(nodeIds),
        loadArtisynRootsBySessionIds(this.db, nodeIds),
        this.loadSnapshot(rootId, userId),
        this.loadStartedAt(rootId),
        getServerBashParser(),
      ]);
    const repoRootsOf = (id: number): string[] =>
      rootsBySessionId.get(id) ?? rootsBySessionId.get(rootId) ?? [];
    const bundles = snapshot?.bundles ?? null;
    const sizeOf = new Map<string, number>();
    for (const b of bundles ?? []) {
      for (const f of b.files) sizeOf.set(f.path, f.size);
    }
    const isKbPath = (path: string): boolean =>
      bundles === null
        ? path.toLowerCase().endsWith('.md')
        : bundleOfPath(path, bundles) !== null;

    const rootNode = nodes.find((n) => n.id === rootId);
    const prompts = rootNode
      ? filterUserPrompts(rootNode.lines, {
          isSubagentLog: rootNode.isSubagent,
        }).map(cutPrompt)
      : [];

    const treeChanges = new Set<string>();
    const treeReads = new Set<string>();
    const treeRuns: string[] = [];
    const runsSeen = new Set<string>();

    const agents: OkfFactsResponse['agents'] = nodes.map((node) => {
      const roots = repoRootsOf(node.id);
      const access: OkfAccessRow[] = extractOkfAccess(
        node.lines,
        roots,
        parser,
        { isSubagentLog: node.isSubagent },
      );
      const fileFacts = collectNodeFileFacts(
        node.lines,
        roots,
        parser,
        node.isSubagent,
      );

      const kb = new Map<
        string,
        { bytes: number; calls: number; ownEditBytes: number; seq: number }
      >();
      for (const r of access) {
        if (r.op !== 'read' && r.op !== 'grep') continue;
        if (r.pathKey.endsWith('/') || !isKbPath(r.pathKey)) continue;
        const e = kb.get(r.pathKey) ?? {
          bytes: 0,
          calls: 0,
          ownEditBytes: 0,
          seq: r.seq,
        };
        e.bytes += r.bytes;
        e.calls += r.calls;
        if (r.afterOwnEdit) e.ownEditBytes += r.bytes;
        e.seq = Math.min(e.seq, r.seq);
        kb.set(r.pathKey, e);
      }
      const kbReads = [...kb.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))
        .map(([path, e]) => ({
          path,
          bytes: e.bytes,
          calls: e.calls,
          ownEditBytes: e.ownEditBytes,
          size: sizeOf.get(path) ?? null,
        }));
      const kbSeq = [...kb.entries()]
        .sort((a, b) => a[1].seq - b[1].seq || a[0].localeCompare(b[0]))
        .map(([path]) => path);

      const otherReadsTop = [...fileFacts.reads.entries()]
        .filter(([path]) => !isKbPath(path))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, OKF_FACTS_OTHER_READS_TOP)
        .map(([path, bytes]) => ({ path, bytes }));

      const changes = [...fileFacts.changes].sort();
      for (const c of changes) treeChanges.add(c);
      for (const p of fileFacts.reads.keys()) treeReads.add(p);
      for (const p of kb.keys()) treeReads.add(p);
      for (const label of fileFacts.runs) {
        if (!runsSeen.has(label)) {
          runsSeen.add(label);
          treeRuns.push(label);
        }
      }

      const prompt =
        node.id === rootId
          ? prompts.join('\n\n')
          : cutPrompt(this.firstTaskText(node));

      return {
        id: node.sessionId,
        parentId: node.parentSessionId,
        prompt,
        kbReads,
        kbSeq,
        otherReadsTop,
        changes,
      };
    });

    return {
      sessionId: sessionIdString,
      startedAt,
      prompts,
      agents,
      tree: {
        changes: [...treeChanges].sort(),
        reads: [...treeReads].sort(),
        runs: treeRuns,
      },
    };
  }

  /** A sub-agent's first user message through `cleanTaskText` (`''` when none survives). */
  private firstTaskText(node: FactsNode): string {
    const first = filterUserPrompts(node.lines, {
      isSubagentLog: node.isSubagent,
    })[0];
    return first ?? '';
  }

  /** Tree nodes with their transcript lines; root first, then by start time. */
  private async loadNodes(nodeIds: number[]): Promise<FactsNode[]> {
    const result = await this.db.execute(sql`
      SELECT
        s.id,
        s.session_id,
        s.parent_session_id,
        l.log_type,
        l.start_time,
        l.body
      FROM sessions s
      LEFT JOIN logs l
        ON l.session_id = s.id
       AND l.log_type IN ('claude', 'claude-subagent')
      WHERE s.id = ANY(${sessionIdsArray(nodeIds)})
      ORDER BY s.id, l.id
    `);
    const byId = new Map<number, FactsNode>();
    for (const r of result.rows as unknown as {
      id: string | number;
      session_id: string;
      parent_session_id: string | null;
      log_type: string | null;
      start_time: string | Date | null;
      body: unknown;
    }[]) {
      const id = Number(r.id);
      const node = byId.get(id) ?? {
        id,
        sessionId: r.session_id,
        parentSessionId: r.parent_session_id,
        startTime: null,
        lines: [],
        isSubagent: false,
      };
      if (r.log_type === 'claude-subagent') node.isSubagent = true;
      if (r.start_time !== null) {
        const ms = new Date(r.start_time).getTime();
        if (
          !Number.isNaN(ms) &&
          (node.startTime === null || ms < node.startTime)
        ) {
          node.startTime = ms;
        }
      }
      if (Array.isArray(r.body)) {
        for (const line of r.body as unknown[]) {
          if (typeof line === 'object' && line !== null) node.lines.push(line);
        }
      }
      byId.set(id, node);
    }
    const rootId = nodeIds[0];
    return [...byId.values()].sort(
      (a, b) =>
        Number(b.id === rootId) - Number(a.id === rootId) ||
        (a.startTime ?? Infinity) - (b.startTime ?? Infinity) ||
        a.id - b.id,
    );
  }

  private async loadSnapshot(
    rootId: number,
    userId: number,
  ): Promise<OkfSnapshotBody | null> {
    const snapshotId = await resolveRootOkfSnapshotId(this.db, rootId);
    if (snapshotId === null) return null;
    const body = await loadOkfSnapshot(this.db, userId, snapshotId);
    return body !== null && Array.isArray(body.bundles) ? body : null;
  }

  /** Root `logs.start_time` (ISO), the earliest of its logs; `null` when unknown. */
  private async loadStartedAt(rootId: number): Promise<string | null> {
    const result = await this.db.execute(sql`
      SELECT MIN(l.start_time) AS start_time FROM logs l WHERE l.session_id = ${rootId}
    `);
    const row = result.rows[0] as
      | { start_time: string | Date | null }
      | undefined;
    if (row?.start_time === null || row?.start_time === undefined) return null;
    const d =
      row.start_time instanceof Date
        ? row.start_time
        : new Date(row.start_time);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
}
