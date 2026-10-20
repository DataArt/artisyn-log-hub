import { Inject, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import type {
  HookNonUploadableLog,
  HookRecommendation,
} from '../database/schema/index';
import { logRepositories, logs, repositories } from '../database/schema/index';
import { compareSemver } from '../common/semver';
import { isBundledRuntime, resolveStaticDir } from '../common/static-dir';

export interface HookRepositorySummary {
  id: number;
  repoUrl: string;
  hookVersion: string;
  outdated: boolean;
  issueCount: number;
}

export interface HookStateDetail {
  repoUrl: string;
  hookVersion: string;
  latestVersion: string | null;
  outdated: boolean;
  lastActivity: string | null;
  logTail: string[];
  nonUploadableLogs: HookNonUploadableLog[];
  recommendations: HookRecommendation[];
  errors: string[];
}

// Matches the hook.log severity markers the hook writes for its own error/warning lines.
const ERROR_LINE_PATTERN = /\[error\]|\[fail\]|\[warn\]/i;

// dev: server/src/logs -> server/src/public/static.
// ncc bundle: dist/ -> dist/public/static (a fixed '..' overshoots — see resolveStaticDir).
const STATIC_DIR = resolveStaticDir(__dirname);

// True only for the interactive dev server (`nest start --watch`, unbundled, not a jest run —
// Jest sets NODE_ENV=test by default). Excludes the real ncc/Docker deployment, where
// `latest-hook-version.json`'s "observed in the wild" baseline must keep its own authority.
const DEV_SERVER =
  process.env.NODE_ENV !== 'test' && !isBundledRuntime(__dirname);

@Injectable()
export class HookStateService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Reads the "latest known hook version" baseline. This is recorded by the installer
   * download controller (server/src/installer) whenever it observes a valid `?v=` query
   * param on a tgz download. Falls back to installer-version.json — which mirrors the
   * plugin version bundled into the installer tarball (.artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json,
   * generated from hook/.claude/telemetry_tool/version.json at build time) at server boot —
   * if the dedicated file doesn't exist yet (e.g. first deploy after this feature ships,
   * before any tgz download has recorded a `?v=`). Never throws; returns null if neither
   * file yields a usable version.
   *
   * On the interactive dev server (`DEV_SERVER`), the "observed in the wild" baseline is
   * skipped entirely and installer-version.json is always authoritative. This repo dogfoods
   * its own hook directly from `.artisyn/marketplace` rather than via a tgz download, so that
   * baseline never organically advances locally — without this, the Hook State panel would
   * keep reporting a stale "Latest version" indefinitely after every local hook bump.
   */
  readLatestHookVersion(): Promise<string | null> {
    // Sync fs reads (no real await needed), wrapped in a Promise to match the async contract
    // callers (listHookRepositories/getHookState) expect and future implementations may need.
    const fromInstaller = this.readVersionFile(
      join(STATIC_DIR, 'installer-version.json'),
    );
    if (DEV_SERVER) return Promise.resolve(fromInstaller);

    const fromLatest = this.readVersionFile(
      join(STATIC_DIR, 'latest-hook-version.json'),
    );
    if (fromLatest !== null) return Promise.resolve(fromLatest);

    return Promise.resolve(fromInstaller);
  }

  private readVersionFile(path: string): string | null {
    try {
      const raw = fs.readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === 'string' && parsed.version !== ''
        ? parsed.version
        : null;
    } catch {
      return null;
    }
  }

  async listHookRepositories(userId: number): Promise<HookRepositorySummary[]> {
    // Ownership check mirrors RepositoriesController.listMyRepositories: repos linked (via
    // log_repositories) to any artisyn log this user submitted.
    const ownedRepoIds = await this.db
      .selectDistinct({ id: repositories.id })
      .from(repositories)
      .innerJoin(logRepositories, eq(logRepositories.repoId, repositories.id))
      .innerJoin(logs, eq(logs.id, logRepositories.logId))
      .where(and(eq(logs.userId, userId), isNotNull(repositories.hookVersion)));

    if (ownedRepoIds.length === 0) return [];

    const repoRows = await this.db
      .select({
        id: repositories.id,
        repoUrl: repositories.repoUrl,
        hookVersion: repositories.hookVersion,
        hookLogTail: repositories.hookLogTail,
        hookRecommendations: repositories.hookRecommendations,
      })
      .from(repositories)
      .where(
        inArray(
          repositories.id,
          ownedRepoIds.map((r) => r.id),
        ),
      )
      .orderBy(asc(repositories.repoUrl));

    const latestVersion = await this.readLatestHookVersion();

    return repoRows.map((repo) => {
      const hookVersion = repo.hookVersion as string; // filtered isNotNull above
      const outdated =
        latestVersion !== null
          ? compareSemver(hookVersion, latestVersion) < 0
          : false;

      return {
        id: repo.id,
        repoUrl: repo.repoUrl,
        hookVersion,
        outdated,
        issueCount: this.computeIssueCount(
          outdated,
          repo.hookLogTail ?? [],
          repo.hookRecommendations ?? [],
        ),
      };
    });
  }

  async getHookState(repoId: number): Promise<HookStateDetail | null> {
    const [repo] = await this.db
      .select({
        repoUrl: repositories.repoUrl,
        hookVersion: repositories.hookVersion,
        hookLastActivity: repositories.hookLastActivity,
        hookLogTail: repositories.hookLogTail,
        hookNonUploadableLogs: repositories.hookNonUploadableLogs,
        hookRecommendations: repositories.hookRecommendations,
      })
      .from(repositories)
      .where(eq(repositories.id, repoId));

    if (!repo || repo.hookVersion === null) return null;

    const latestVersion = await this.readLatestHookVersion();
    const outdated =
      latestVersion !== null
        ? compareSemver(repo.hookVersion, latestVersion) < 0
        : false;

    // Defensive re-slice — the hook already caps this at 50 lines before upload, but don't
    // trust that blindly server-side.
    const logTail = (repo.hookLogTail ?? []).slice(-50);
    const errors = logTail.filter((line) => ERROR_LINE_PATTERN.test(line));

    return {
      repoUrl: repo.repoUrl,
      hookVersion: repo.hookVersion,
      latestVersion,
      outdated,
      lastActivity: repo.hookLastActivity
        ? repo.hookLastActivity.toISOString()
        : null,
      logTail,
      nonUploadableLogs: repo.hookNonUploadableLogs ?? [],
      recommendations: repo.hookRecommendations ?? [],
      errors,
    };
  }

  /**
   * issueCount formula (plan: "outdated + misconfig-error present + any recommendations"):
   *   +1 if the repo's hook version is outdated vs. the latest known baseline
   *   +1 if hook_log_tail contains at least one [error]/[fail]/[warn] marker line
   *      (counted once regardless of how many matching lines exist)
   *   + recommendations.length (each active recommendation — e.g. timeout-on-upload — is
   *     counted individually, since each represents a distinct actionable issue)
   */
  private computeIssueCount(
    outdated: boolean,
    logTail: string[],
    recommendations: HookRecommendation[],
  ): number {
    const hasErrorLine = logTail.some((line) => ERROR_LINE_PATTERN.test(line));
    return (outdated ? 1 : 0) + (hasErrorLine ? 1 : 0) + recommendations.length;
  }
}
