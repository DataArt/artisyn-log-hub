import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { descendantSessionsCte, topAncestorIdsSql } from '../session-tree.sql';
import { ToolMonitorConfigService } from './tool-monitor-config.service';
import {
  TOOL_USAGE_EXTRACTOR_VERSION,
  resolveToolUsageRebuildBatch,
  resolveToolUsageRebuildIntervalMs,
} from './tool-usage.constants';
import { rewriteTreeToolUsage } from './tool-usage-writer';

const TICK_INTERVAL_NAME = 'tool-usage-rebuild-tick';

/**
 * Background drain of the `session_tool_usage` rebuilds (impl-plan DD-7). Ingest, import and the
 * stats recompute only mark a tree stale (`sessions.tool_usage_version = NULL`); this service
 * rebuilds the stale trees. Two triggers, one drain:
 *
 * - a `SchedulerRegistry` interval every `TOOL_USAGE_REBUILD_INTERVAL_MS` (default 15 000);
 * - {@link notify}, the post-commit nudge from ingest. A nudge that arrives while a pass is
 *   running schedules one more pass right after it.
 *
 * Each pass:
 * 1. claims up to `TOOL_USAGE_REBUILD_BATCH` (default 20) non-deleted pending sessions with
 *    `FOR UPDATE SKIP LOCKED`, resolves their tree roots and sets `tool_usage_version` to
 *    `TOOL_USAGE_EXTRACTOR_VERSION` on every node of those trees (`SKIP LOCKED` again, so the
 *    claim never waits on an ingest) — BEFORE reading anything, so an upload that commits during
 *    the rebuild sets NULL again and the tree is re-run;
 * 2. rebuilds each tree in its own transaction, serialised per tree by an advisory lock. A tree
 *    that fails is logged and keeps its version, so a poison tree cannot loop forever.
 *
 * Safe across a cluster: the claim uses `SKIP LOCKED` and the rebuild the per-tree lock.
 */
@Injectable()
export class ToolUsageRebuildService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ToolUsageRebuildService.name);
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private stopped = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ToolMonitorConfigService,
  ) {}

  onModuleInit(): void {
    const interval = setInterval(() => {
      if (this.inFlight !== null) return;
      this.start();
    }, resolveToolUsageRebuildIntervalMs());
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /**
   * Post-commit nudge: drains now, or right after the running pass. Never throws and never
   * blocks the caller.
   */
  notify(): void {
    if (this.stopped) return;
    if (this.inFlight !== null) {
      this.rerunRequested = true;
      return;
    }
    this.start();
  }

  private start(): void {
    if (this.stopped) return;
    const run = this.runPasses()
      .catch((err: unknown) => this.logFailure('Tool usage drain failed', err))
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
  }

  private async runPasses(): Promise<void> {
    do {
      this.rerunRequested = false;
      await this.drainOnce();
    } while (this.rerunRequested && !this.stopped);
  }

  /** One pass (steps above). Returns the number of trees rebuilt. */
  async drainOnce(): Promise<number> {
    const roots = await this.claimTrees(resolveToolUsageRebuildBatch());
    let rebuilt = 0;
    for (const rootId of roots) {
      if (this.stopped) break;
      try {
        await this.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${'tool-usage-tree:' + rootId}, 0))`,
          );
          await rewriteTreeToolUsage(tx, rootId, (userId, repoUrl) =>
            this.configService.resolveMonitoredTools(userId, repoUrl),
          );
        });
        rebuilt++;
      } catch (err: unknown) {
        this.logFailure(`Tool usage rebuild of session ${rootId} failed`, err);
      }
    }
    if (rebuilt > 0) {
      this.logger.log(`Rebuilt tool usage of ${rebuilt} session tree(s)`);
    }
    return rebuilt;
  }

  /**
   * Claims up to `batch` pending sessions, sets the extractor version on every node of their
   * trees and returns the tree roots (step 1).
   */
  private async claimTrees(batch: number): Promise<number[]> {
    return this.db.transaction(async (tx) => {
      const claimed = (
        await tx.execute(sql`
          SELECT id FROM sessions
          WHERE tool_usage_version IS NULL AND NOT deleted
          ORDER BY id
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED
        `)
      ).rows as { id: number | string }[];
      if (claimed.length === 0) return [];
      const claimedIds = claimed.map((r) => Number(r.id));
      const claimedArr = sql`${`{${claimedIds.join(',')}}`}::bigint[]`;

      const rootRows = (
        await tx.execute(sql`
          WITH RECURSIVE ${topAncestorIdsSql(claimedArr)}
          SELECT DISTINCT top_id FROM top_ancestors ORDER BY top_id
        `)
      ).rows as { top_id: number | string }[];
      const rootIds = rootRows.map((r) => Number(r.top_id));
      const rootArr = sql`${`{${rootIds.join(',')}}`}::bigint[]`;

      await tx.execute(sql`
        WITH RECURSIVE ${descendantSessionsCte(rootArr)}
        UPDATE sessions SET tool_usage_version = ${TOOL_USAGE_EXTRACTOR_VERSION}
        WHERE id IN (
          SELECT id FROM sessions
          WHERE id IN (
            SELECT unnest(${claimedArr}) UNION SELECT id FROM descendant_sessions
          )
          FOR UPDATE SKIP LOCKED
        )
      `);
      return rootIds;
    });
  }

  private logFailure(message: string, err: unknown): void {
    this.logger.error(
      `${message}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
}
