// Harness snapshot (DD-1 in docs/tasks/todo/2026-10-16-sysctx-skill-source/impl-plan.md): the
// hook's self-reported skill/agent/MCP/system-context inventory, uploaded as one `harness-snapshot`
// NDJSON line (full body) plus a `harness-snapshot-ref` line on every artisyn upload of the current
// session. The server never recomputes the hook's `snapshotId` (DD-2) — it only format-validates
// it and stores/loads the body verbatim, keyed by (owning user_id, snapshot_id).
import { Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import {
  harnessSnapshots,
  sessions,
  uploadQueue,
} from '../database/schema/index';

const logger = new Logger('HarnessSnapshot');

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as AnyRecord;
  }
  return null;
}

/** DD-2: the hook's id is trusted as-is; only the format is checked. */
export const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/;

/** DD-16/DD-20: a `harness-snapshot` line whose serialized body exceeds this is rejected. */
export const HARNESS_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * DD-8/DD-16: `upload_queue.status` values that count as "a full snapshot upload for this id
 * is still in flight" — an id in one of these states is treated as known even before the
 * ingest transaction that will store its `harness_snapshots` row has run.
 */
export const PENDING_QUEUE_STATUSES = [
  'pending',
  'processing',
  'partially_uploaded',
] as const;

/**
 * `'org-synced'` (hook 2.28.0+): a skill synced from the organisation's skill store into
 * `~/.claude/skills/<org>/`; its `name` is the bare skill name.
 */
export type HarnessSnapshotSkillSource =
  | 'project'
  | 'user'
  | 'plugin'
  | 'org-synced';
/** Hook 2.28.0+ (DD-17): a harness file's git status relative to the repository root. */
export type HarnessGitStatus =
  | 'tracked'
  | 'untracked'
  | 'ignored'
  | 'outside-repo';
export type HarnessSnapshotSkillKind = 'skill' | 'workflow' | 'command';

/** DD-1: present only on a `plugin`-source skill. */
export interface HarnessSnapshotPlugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  gitCommitSha?: string;
}

export interface HarnessSnapshotSkillEntry {
  /** Plugin entries are `<pluginName>:<name>` (DD-1). */
  name: string;
  kind: HarnessSnapshotSkillKind;
  source: HarnessSnapshotSkillSource;
  description: string;
  argumentHint?: string;
  /** File text after frontmatter; a workflow's `body` is the whole `.js` text. */
  body: string;
  /** DD-3 path, shaped per the entry's `source`. */
  path: string;
  bytes: number;
  contentHash: string;
  plugin?: HarnessSnapshotPlugin;
  /**
   * Hook 2.28.0+: the file's git status relative to the session's repository root (DD-17).
   * Absent on older hooks.
   */
  gitStatus?: HarnessGitStatus;
}

export interface HarnessSnapshotAgentEntry {
  name: string;
  description: string;
  body: string;
  path: string;
  bytes: number;
  contentHash: string;
  source: 'project';
  /**
   * Hook 2.28.0+: the file's git status relative to the session's repository root (DD-17).
   * Absent on older hooks.
   */
  gitStatus?: HarnessGitStatus;
}

export interface HarnessSnapshotMcpToolEntry {
  name: string;
  schemaSizeTokens: number;
}

export interface HarnessSnapshotMcpServerEntry {
  name: string;
  command: string;
  args: string[];
  url?: string;
  configSource: 'project' | 'user';
  /** `undefined` — the probe never ran for this snapshot (a ref-only resend). */
  connected?: boolean;
  tools?: HarnessSnapshotMcpToolEntry[];
}

export interface HarnessSnapshotContextFile {
  path: string;
  bytes: number;
  contentHash: string;
  /** Rule file contents only (DD-13's `claudeMd`); other files carry no `content`. */
  content?: string;
  /**
   * Hook 2.28.0+: the file's git status relative to the session's repository root (DD-17).
   * Absent on older hooks.
   */
  gitStatus?: HarnessGitStatus;
}

export interface HarnessSnapshotSystemContext {
  totalBytes: number;
  files: HarnessSnapshotContextFile[];
}

/**
 * DD-1's `harness-snapshot` event body, minus its `type` discriminant — what
 * {@link extractHarnessSnapshot} returns and what `harness_snapshots.body` stores verbatim.
 * Mirrors the hook's JSDoc `@typedef HarnessSnapshot` (`harness-snapshot.js`, DD-18) and the
 * client's `HarnessSnapshot` (`client/src/viewer/api.ts`). Kept in sync by convention — the
 * three packages are isolated (see `client.md`), so nothing imports across them.
 */
export interface HarnessSnapshotBody {
  snapshotId: string;
  schemaVersion: number;
  /** Capability flag — explicitly NOT part of the DD-2 id. */
  perToolDetailSupported: boolean;
  skills: HarnessSnapshotSkillEntry[];
  agents: HarnessSnapshotAgentEntry[];
  mcpServers: HarnessSnapshotMcpServerEntry[];
  systemContext: HarnessSnapshotSystemContext | null;
}

/**
 * Extracts and validates the first `harness-snapshot` line of an artisyn upload (DD-20). An
 * upload can carry more than one candidate line only if a prior chunk resent it; the first
 * one that validates wins, and every rejected line is logged rather than silently dropped —
 * the upload is still processed otherwise unchanged (DD-20's last rule).
 */
export function extractHarnessSnapshot(
  lines: object[],
): HarnessSnapshotBody | null {
  for (const line of lines) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'harness-snapshot') continue;

    const snapshotId = rec['snapshotId'];
    if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_RE.test(snapshotId)) {
      logger.warn(
        `harness-snapshot line rejected: snapshotId is not a 64-char hex string`,
      );
      continue;
    }

    if (rec['schemaVersion'] !== 1) {
      logger.warn(
        `harness-snapshot line rejected (snapshotId ${snapshotId.slice(0, 12)}): unsupported schemaVersion ${JSON.stringify(rec['schemaVersion'])}`,
      );
      continue;
    }

    if (
      !Array.isArray(rec['skills']) ||
      !Array.isArray(rec['agents']) ||
      !Array.isArray(rec['mcpServers'])
    ) {
      logger.warn(
        `harness-snapshot line rejected (snapshotId ${snapshotId.slice(0, 12)}): skills/agents/mcpServers must be arrays`,
      );
      continue;
    }

    const rawSystemContext = rec['systemContext'];
    if (rawSystemContext !== null && asRecord(rawSystemContext) === null) {
      logger.warn(
        `harness-snapshot line rejected (snapshotId ${snapshotId.slice(0, 12)}): systemContext must be an object or null`,
      );
      continue;
    }

    const body: AnyRecord = { ...rec };
    delete body['type'];
    const serializedBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (serializedBytes > HARNESS_SNAPSHOT_MAX_BYTES) {
      logger.warn(
        `harness-snapshot line rejected (snapshotId ${snapshotId.slice(0, 12)}): body is ${serializedBytes} bytes, over the ${HARNESS_SNAPSHOT_MAX_BYTES} limit`,
      );
      continue;
    }

    return body as unknown as HarnessSnapshotBody;
  }
  return null;
}

/** Extracts the first valid `harness-snapshot-ref` id of an artisyn upload (DD-1). */
export function extractHarnessSnapshotRef(lines: object[]): string | null {
  for (const line of lines) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'harness-snapshot-ref') continue;
    const snapshotId = rec['snapshotId'];
    if (typeof snapshotId === 'string' && SNAPSHOT_ID_RE.test(snapshotId)) {
      return snapshotId;
    }
  }
  return null;
}

/**
 * Stores one hook-reported snapshot verbatim, scoped to its uploading owner (DD-9 step 1).
 * `ON CONFLICT (user_id, snapshot_id) DO NOTHING` — the id is content-derived and immutable, so
 * the same owner uploading it again is a no-op, never a body overwrite. Returns whether a row
 * was actually inserted (caller uses this only for logging; binding doesn't depend on it).
 */
export async function storeHarnessSnapshot(
  tx: DrizzleDb,
  userId: number,
  body: HarnessSnapshotBody,
): Promise<boolean> {
  const inserted = await tx
    .insert(harnessSnapshots)
    .values({ userId, snapshotId: body.snapshotId, body })
    .onConflictDoNothing({
      target: [harnessSnapshots.userId, harnessSnapshots.snapshotId],
    })
    .returning({ id: harnessSnapshots.id });
  return inserted.length > 0;
}

/**
 * Binds a session to a snapshot id the first time one is known for it (DD-9 step 2). The
 * `harness_snapshot_id IS NULL` guard is a COALESCE: once a session is bound, it stays bound to
 * that id even if a later upload of the same session carries a different ref (DD-9, DD-21).
 */
export async function bindSessionSnapshot(
  tx: DrizzleDb,
  sessionRowId: number,
  snapshotId: string,
): Promise<boolean> {
  const bound = await tx
    .update(sessions)
    .set({ harnessSnapshotId: snapshotId })
    .where(
      and(
        eq(sessions.id, sessionRowId),
        sql`${sessions.harnessSnapshotId} IS NULL`,
      ),
    )
    .returning({ id: sessions.id });
  return bound.length > 0;
}

/** Loads a stored snapshot's body for (owning user, snapshot id), or `null` if not found. */
export async function loadHarnessSnapshot(
  db: DrizzleDb,
  userId: number,
  snapshotId: string,
): Promise<HarnessSnapshotBody | null> {
  const [row] = await db
    .select({ body: harnessSnapshots.body })
    .from(harnessSnapshots)
    .where(
      and(
        eq(harnessSnapshots.userId, userId),
        eq(harnessSnapshots.snapshotId, snapshotId),
      ),
    )
    .limit(1);
  return (row?.body as HarnessSnapshotBody | undefined) ?? null;
}

/**
 * DD-8's "known" check: true when either a `harness_snapshots` row already exists for this
 * owner, or an in-flight `upload_queue` row (status in {@link PENDING_QUEUE_STATUSES}) already
 * carries this id as its `snapshotFull=1` upload — the latter covers the id being "on its way"
 * even before the ingest transaction that will store the row has run. The accepted race left by
 * this check (a purge deleting the row in between) is DD-21.
 */
export async function isHarnessSnapshotKnown(
  db: DrizzleDb,
  userId: number,
  snapshotId: string,
): Promise<boolean> {
  const [storedRow] = await db
    .select({ id: harnessSnapshots.id })
    .from(harnessSnapshots)
    .where(
      and(
        eq(harnessSnapshots.userId, userId),
        eq(harnessSnapshots.snapshotId, snapshotId),
      ),
    )
    .limit(1);
  if (storedRow) return true;

  const [queuedRow] = await db
    .select({ id: uploadQueue.id })
    .from(uploadQueue)
    .where(
      and(
        eq(uploadQueue.userId, userId),
        eq(uploadQueue.harnessSnapshotId, snapshotId),
        inArray(uploadQueue.status, [...PENDING_QUEUE_STATUSES]),
      ),
    )
    .limit(1);
  return queuedRow !== undefined;
}

/**
 * DD-11 step h: deletes every `harness_snapshots` row no session references any more, across
 * all owners. The orphan test matches by snapshot id alone, with no owner join — conservative,
 * since a row still referenced by any session (even one belonging to another owner, which
 * cannot actually happen given how ids are bound) survives.
 */
export async function deleteOrphanHarnessSnapshots(
  tx: DrizzleDb,
): Promise<void> {
  await tx.execute(
    sql`DELETE FROM harness_snapshots hs
        WHERE NOT EXISTS (
          SELECT 1 FROM sessions s WHERE s.harness_snapshot_id = hs.snapshot_id
        )`,
  );
}
