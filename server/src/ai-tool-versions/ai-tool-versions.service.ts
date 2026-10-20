import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import * as schema from '../database/schema';
import {
  AI_TOOLS,
  FETCH_TIMEOUT_MS,
  RETRY_AFTER_HOURS,
  STALE_AFTER_HOURS,
} from './ai-tool-versions.constants';
import type {
  AiToolVersionHistoryEntry,
  AiToolVersionsResponse,
  ReleaseVersions,
} from './ai-tool-versions.types';
import { parseDistTags } from './dist-tags';

export type RunCheckResult = 'fetched' | 'skipped' | 'failed';

/**
 * Tracks the npm release versions (`stable`, `latest`) of AI tools such as Claude Code.
 *
 * `runCheck` is safe to call from every cluster worker at once: a conditional UPDATE on
 * `ai_tool_version.last_attempt_at` lets exactly one worker per stale/retry window call
 * npm; every other worker returns `'skipped'`.
 */
@Injectable()
export class AiToolVersionsService {
  private readonly logger = new Logger(AiToolVersionsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Seeds the tool's row, claims the fetch, and — only when the claim succeeds — fetches
   * the dist-tags and persists them. `distTagsUrl` defaults to the tool's configured URL
   * in `AI_TOOLS`; with no URL the check is skipped before touching the DB.
   */
  async runCheck(
    toolName: string,
    distTagsUrl: string | undefined = AI_TOOLS[toolName]?.distTagsUrl,
  ): Promise<RunCheckResult> {
    if (!distTagsUrl) {
      this.logger.warn(
        `No dist-tags URL configured for AI tool "${toolName}"; skipping version check`,
      );
      return 'skipped';
    }

    await this.db.execute(
      sql`INSERT INTO ai_tool_version (tool_name) VALUES (${toolName}) ON CONFLICT (tool_name) DO NOTHING`,
    );

    const claimed = await this.claim(toolName);
    if (!claimed) return 'skipped';

    let versions: ReleaseVersions;
    try {
      const response = await fetch(distTagsUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.error(
          `AI tool version check for "${toolName}" failed: HTTP ${response.status} from ${distTagsUrl}`,
        );
        return 'failed';
      }
      const json: unknown = await response.json();
      const parsed = parseDistTags(json);
      if (!parsed) {
        this.logger.error(
          `AI tool version check for "${toolName}" failed: unexpected dist-tags payload from ${distTagsUrl}`,
        );
        return 'failed';
      }
      versions = parsed;
    } catch (err) {
      this.logger.error(
        `AI tool version check for "${toolName}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      return 'failed';
    }

    try {
      await this.persist(toolName, versions);
    } catch (err) {
      this.logger.error(
        `AI tool version check for "${toolName}" failed to persist: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      return 'failed';
    }
    return 'fetched';
  }

  /** Full release history of a tool, ordered `effective_from ASC, id ASC`. */
  async loadHistory(toolName: string): Promise<AiToolVersionHistoryEntry[]> {
    const rows = await this.db
      .select({
        versionMap: schema.aiToolVersionHistory.versionMap,
        effectiveFrom: schema.aiToolVersionHistory.effectiveFrom,
      })
      .from(schema.aiToolVersionHistory)
      .where(eq(schema.aiToolVersionHistory.toolName, toolName))
      .orderBy(
        asc(schema.aiToolVersionHistory.effectiveFrom),
        asc(schema.aiToolVersionHistory.id),
      );
    return rows.map((row) => ({
      versions: {
        latest: row.versionMap.latest,
        stable: row.versionMap.stable,
      },
      effectiveFrom: row.effectiveFrom.toISOString(),
    }));
  }

  /** Response of `GET /api/v1/ai-tool-versions/:toolName`. */
  async getHistory(toolName: string): Promise<AiToolVersionsResponse> {
    const [current] = await this.db
      .select({ fetchedAt: schema.aiToolVersion.fetchedAt })
      .from(schema.aiToolVersion)
      .where(eq(schema.aiToolVersion.toolName, toolName))
      .limit(1);
    const history = await this.loadHistory(toolName);
    return {
      toolName,
      fetchedAt: current?.fetchedAt ? current.fetchedAt.toISOString() : null,
      history,
    };
  }

  /**
   * Cluster claim: stamps `last_attempt_at = now()` only when the last success is stale
   * and no other worker attempted within the retry window. Returns true when this worker
   * won the claim.
   */
  private async claim(toolName: string): Promise<boolean> {
    const result = await this.db.execute<{ tool_name: string }>(sql`
      UPDATE ai_tool_version SET last_attempt_at = now()
       WHERE tool_name = ${toolName}
         AND (fetched_at IS NULL OR fetched_at < now() - make_interval(hours => ${STALE_AFTER_HOURS}))
         AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(hours => ${RETRY_AFTER_HOURS}))
      RETURNING tool_name
    `);
    return (result.rows[0] ?? null) !== null;
  }

  /**
   * Stores the fetched map on the tool's row and appends a history entry when the map
   * differs from the newest one. One `fetchedAt` is used for both timestamps.
   */
  private async persist(
    toolName: string,
    versions: ReleaseVersions,
  ): Promise<void> {
    const fetchedAt = new Date();
    const versionMap = { stable: versions.stable, latest: versions.latest };
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.aiToolVersion)
        .set({ versionMap, fetchedAt })
        .where(eq(schema.aiToolVersion.toolName, toolName));

      const [newest] = await tx
        .select({ versionMap: schema.aiToolVersionHistory.versionMap })
        .from(schema.aiToolVersionHistory)
        .where(eq(schema.aiToolVersionHistory.toolName, toolName))
        .orderBy(
          desc(schema.aiToolVersionHistory.effectiveFrom),
          desc(schema.aiToolVersionHistory.id),
        )
        .limit(1);

      const changed =
        !newest ||
        newest.versionMap.stable !== versionMap.stable ||
        newest.versionMap.latest !== versionMap.latest;
      if (changed) {
        await tx.insert(schema.aiToolVersionHistory).values({
          toolName,
          versionMap,
          effectiveFrom: fetchedAt,
        });
      }
    });
  }
}
