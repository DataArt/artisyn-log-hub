import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { RebuildGovernor } from '../../common/load-governor/rebuild-governor';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { logs, sessionStats } from '../../database/schema/index';
import { loadArtisynRootsBySessionIds } from '../change-surface/changed-paths.sql';
import { countShellInvocations } from '../claude-extractor';
import { topAncestorIdsSql } from '../session-tree.sql';
import { rebuildOkfAccessForNodes } from './okf-access-writer';
import {
  OKF_EXTRACT_VERSION,
  SHELL_FIGURES_BACKFILL_BATCH,
  SHELL_FIGURES_BACKFILL_INTERVAL_MS,
  SHELL_FIGURES_BACKFILL_TICK,
} from './okf-constants';

/**
 * Shell-figures backfill (impl-plan DD-19 of 2026-11-22-bash-tab-powershell, FR-15).
 *
 * OKF extractor v5 counts PowerShell calls — commit / PR counts and OKF accesses. Rows of a node
 * without a PowerShell call are identical under v4 and v5, so only nodes that have a
 * `session_tool_stats` row for `PowerShell` and a marker below {@link OKF_EXTRACT_VERSION} are
 * re-extracted; every other node is never touched.
 *
 * A pass runs on module init and then every {@link SHELL_FIGURES_BACKFILL_INTERVAL_MS} for the
 * process lifetime (a pass that finds nothing costs one query over `sessions`). Each pass is
 * **one transaction**: it claims up to {@link SHELL_FIGURES_BACKFILL_BATCH} sessions with
 * `FOR UPDATE OF s SKIP LOCKED` (safe across a cluster), recounts each node's commit / PR figures
 * into `session_stats`, rebuilds its OKF access rows and stamps the claimed sessions with the
 * current version, so a crash mid-pass rolls the claim back. A node whose processing throws is
 * logged (its savepoint rolled back) and still stamped, so a poison node cannot loop forever.
 */
@Injectable()
export class ShellFiguresBackfillService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ShellFiguresBackfillService.name);
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly governor: RebuildGovernor,
  ) {}

  onModuleInit(): void {
    this.start();
    const interval = setInterval(() => {
      if (this.inFlight !== null) return;
      this.start();
    }, SHELL_FIGURES_BACKFILL_INTERVAL_MS);
    this.schedulerRegistry.addInterval(SHELL_FIGURES_BACKFILL_TICK, interval);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (
      this.schedulerRegistry.doesExist('interval', SHELL_FIGURES_BACKFILL_TICK)
    ) {
      this.schedulerRegistry.deleteInterval(SHELL_FIGURES_BACKFILL_TICK);
    }
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  private start(): void {
    if (this.stopped) return;
    const run = this.runPass()
      .then((processed) => {
        if (processed > 0) {
          this.logger.log(
            `Re-extracted shell figures of ${processed} session(s)`,
          );
        }
      })
      .catch((err: unknown) =>
        this.logFailure('Shell-figures backfill pass failed', err),
      )
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
  }

  /** One pass (see the class comment). Returns the number of claimed sessions. */
  async runPass(): Promise<number> {
    // One pass (one claimed batch) is the unit of work paced by the governor (DD-15 of
    // 2026-11-23-session-logs-streaming); it admits before the claim transaction opens.
    await this.governor.admit();
    if (this.stopped) return 0;
    const processed = await this.claimAndProcess();
    if (processed === 0) this.governor.reportIdle();
    return processed;
  }

  private async claimAndProcess(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const claimed = (
        await tx.execute(sql`
          SELECT s.id FROM sessions s
          WHERE NOT s.deleted
            AND COALESCE(s.okf_extract_version, 0) < ${OKF_EXTRACT_VERSION}
            AND EXISTS (
              SELECT 1 FROM session_tool_stats t
              WHERE t.session_id = s.id AND t.tool_name = 'PowerShell'
            )
          LIMIT ${SHELL_FIGURES_BACKFILL_BATCH}
          FOR UPDATE OF s SKIP LOCKED
        `)
      ).rows as { id: number | string }[];
      if (claimed.length === 0) return 0;
      const claimedIds = claimed.map((r) => Number(r.id));
      const claimedArr = sql`${`{${claimedIds.join(',')}}`}::bigint[]`;

      const treeRootRows = (
        await tx.execute(sql`
          WITH RECURSIVE ${topAncestorIdsSql(claimedArr)}
          SELECT id, top_id FROM top_ancestors
        `)
      ).rows as { id: number | string; top_id: number | string }[];
      const treeRootOf = new Map<number, number>(
        treeRootRows.map((r) => [Number(r.id), Number(r.top_id)]),
      );
      const roots = await loadArtisynRootsBySessionIds(tx, [
        ...claimedIds,
        ...treeRootOf.values(),
      ]);
      const rootsOf = (node: number): readonly string[] => {
        const treeRoot = treeRootOf.get(node) ?? node;
        return roots.get(node) ?? roots.get(treeRoot) ?? [];
      };

      for (const node of claimedIds) {
        if (this.stopped) break;
        try {
          // A savepoint per node: a failed statement would otherwise abort the pass transaction.
          await tx.transaction(async (sp) => {
            await this.reextractNode(sp, node, rootsOf);
          });
        } catch (err: unknown) {
          this.logFailure(
            `Shell-figures backfill of session ${node} failed`,
            err,
          );
        }
      }

      // The OKF writer also stamps a rebuilt node; this covers nodes that failed or had no body.
      await tx.execute(sql`
        UPDATE sessions SET okf_extract_version = ${OKF_EXTRACT_VERSION}
        WHERE id = ANY(${claimedArr})
      `);
      return claimedIds.length;
    });
  }

  /** Recounts one node's commit / PR figures and rebuilds its OKF access rows. */
  private async reextractNode(
    db: DrizzleDb,
    node: number,
    rootsOf: (node: number) => readonly string[],
  ): Promise<void> {
    const bodyRows = await db
      .select({
        sessionId: logs.sessionId,
        logType: logs.logType,
        body: logs.body,
      })
      .from(logs)
      .where(
        and(
          eq(logs.sessionId, node),
          inArray(logs.logType, ['claude', 'claude-subagent']),
        ),
      )
      .orderBy(asc(logs.id));

    let commits = 0;
    let prs = 0;
    for (const row of bodyRows) {
      if (!Array.isArray(row.body)) continue;
      const lines = (row.body as unknown[]).filter(
        (line): line is object => typeof line === 'object' && line !== null,
      );
      const counts = countShellInvocations(
        lines,
        row.logType === 'claude-subagent',
      );
      commits += counts.commits;
      prs += counts.prs;
    }

    await db
      .update(sessionStats)
      .set({ commitCount: commits, prCount: prs })
      .where(eq(sessionStats.sessionId, node));
    await rebuildOkfAccessForNodes(db, bodyRows, rootsOf);
  }

  private logFailure(message: string, err: unknown): void {
    this.logger.error(
      `${message}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
}
