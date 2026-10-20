import { Inject, Injectable } from '@nestjs/common';
import { CLAUDE_CODE_TOOL } from '../../ai-tool-versions/ai-tool-versions.constants';
import { AiToolVersionsService } from '../../ai-tool-versions/ai-tool-versions.service';
import type { AiToolVersionHistoryEntry } from '../../ai-tool-versions/ai-tool-versions.types';
import { pickReleaseVersionsAt } from '../../ai-tool-versions/release-at';
import { compareVersions, parseVersion } from '../../common/semver';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import {
  loadScopedRootSessions,
  type AnalyticsScope,
  type ScopedRootSession,
} from './scoped-sessions.sql';
import type {
  ClaudeVersionUsageResponse,
  ClaudeVersionUsageRow,
} from './usage-analytics.types';

/**
 * Pure builder behind the Claude Code version usage report.
 *
 * A root session is *checked* when its Claude Code version parses and the release history
 * has an entry in effect at the session's start. A checked session is *outdated* when its
 * version is below the `stable` release current at that moment. Rows are one per user; users
 * with no checked session are dropped. Users with outdated sessions sort first, then by email.
 *
 * `history` must be ordered `effectiveFrom` ascending (as `AiToolVersionsService.loadHistory`
 * returns it).
 */
export function buildClaudeVersionUsageRows(
  roots: readonly ScopedRootSession[],
  history: readonly AiToolVersionHistoryEntry[],
): ClaudeVersionUsageRow[] {
  const byUser = new Map<number, ClaudeVersionUsageRow>();

  for (const root of roots) {
    const version = root.claudeVersion;
    if (typeof version !== 'string' || parseVersion(version) === null) {
      continue;
    }
    const ref = pickReleaseVersionsAt(history, root.startTime);
    if (ref === null) continue;

    let row = byUser.get(root.userId);
    if (!row) {
      row = {
        userId: root.userId,
        userEmail: root.userEmail,
        sessionsChecked: 0,
        outdatedSessions: 0,
      };
      byUser.set(root.userId, row);
    }
    row.sessionsChecked += 1;
    if (compareVersions(version, ref.stable) < 0) {
      row.outdatedSessions += 1;
    }
  }

  return [...byUser.values()].sort((a, b) => {
    const aOutdated = a.outdatedSessions > 0 ? 0 : 1;
    const bOutdated = b.outdatedSessions > 0 ? 0 : 1;
    if (aOutdated !== bOutdated) return aOutdated - bOutdated;
    if (a.userEmail !== b.userEmail) return a.userEmail < b.userEmail ? -1 : 1;
    return a.userId - b.userId;
  });
}

/**
 * Claude Code version usage report: per user, how many in-scope root sessions ran a Claude
 * Code version older than the `stable` npm release current when the session started.
 * Shared by `analytics/claude-versions` and its `reports/claude-versions` twin.
 */
@Injectable()
export class ClaudeVersionUsageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly aiToolVersionsService: AiToolVersionsService,
  ) {}

  async build(
    repoIds: number[],
    scope: AnalyticsScope,
  ): Promise<ClaudeVersionUsageResponse> {
    const roots = await loadScopedRootSessions(this.db, repoIds, scope);
    if (roots.length === 0) return { rows: [] };
    const history =
      await this.aiToolVersionsService.loadHistory(CLAUDE_CODE_TOOL);
    return { rows: buildClaudeVersionUsageRows(roots, history) };
  }
}
