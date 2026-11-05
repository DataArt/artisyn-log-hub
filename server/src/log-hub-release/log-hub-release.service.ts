import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { readBuildOrigin, type BuildOrigin } from '../common/build-info';
import { compareSemver, isValidSemver } from '../common/semver';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import * as schema from '../database/schema';
import {
  ATTEMPT_EVERY_HOURS,
  FETCH_TIMEOUT_MS,
  LOG_HUB_RELEASES_LATEST_URL,
  RELEASE_TAG_RE,
  RELEASE_URL_PREFIX,
} from './log-hub-release.constants';
import type {
  LogHubReleaseState,
  RunCheckResult,
} from './log-hub-release.types';

const ROW_ID = 1;

interface ValidatedRelease {
  tag: string;
  url: string;
}

/**
 * Checks GitHub for the latest Log Hub release and tells admins when a newer one exists.
 *
 * Only an *eligible* deployment checks: an official release build (`build.origin.json`
 * with `officialRelease: true`) with a strict `X.Y.Z` version. `runCheck` is safe to call
 * from every cluster worker at once: a conditional UPDATE on
 * `log_hub_release_check.last_attempt_at` lets exactly one worker per 24 h call GitHub,
 * whatever the outcome; every other worker returns `'skipped'`.
 *
 * "Update available" is computed at read time (`getState`) against the running version,
 * so an upgraded server stops reporting it at once, even with an old stored row.
 */
@Injectable()
export class LogHubReleaseService {
  private readonly logger = new Logger(LogHubReleaseService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** True for an official release build with a strict `X.Y.Z` version. */
  isEligible(origin: BuildOrigin | null): origin is BuildOrigin {
    return (
      origin !== null &&
      origin.officialRelease === true &&
      isValidSemver(origin.version)
    );
  }

  /**
   * Seeds the single row, claims the attempt, and — only when the claim succeeds — fetches
   * the latest release and stores it. Any failure logs one warning and leaves the stored
   * values untouched. Does nothing (`'skipped'`) on a non-eligible deployment.
   */
  async runCheck(): Promise<RunCheckResult> {
    const origin = readBuildOrigin();
    if (!this.isEligible(origin)) return 'skipped';

    await this.db.execute(
      sql`INSERT INTO log_hub_release_check (id) VALUES (${ROW_ID}) ON CONFLICT (id) DO NOTHING`,
    );
    const claimed = await this.claim();
    if (!claimed) return 'skipped';

    let release: ValidatedRelease;
    try {
      const response = await fetch(LOG_HUB_RELEASES_LATEST_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `artisyn-log-hub/${origin.version}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(
          `Log Hub release check failed: HTTP ${response.status} from ${LOG_HUB_RELEASES_LATEST_URL}`,
        );
        return 'failed';
      }
      const json: unknown = await response.json();
      const validated = this.validate(json);
      if (!validated) {
        this.logger.warn(
          `Log Hub release check failed: unexpected payload from ${LOG_HUB_RELEASES_LATEST_URL}`,
        );
        return 'failed';
      }
      release = validated;
    } catch (err) {
      this.logger.warn(
        `Log Hub release check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'failed';
    }

    try {
      await this.db
        .update(schema.logHubReleaseCheck)
        .set({
          latestTag: release.tag,
          releaseUrl: release.url,
          fetchedAt: sql`now()`,
        })
        .where(eq(schema.logHubReleaseCheck.id, ROW_ID));
    } catch (err) {
      this.logger.warn(
        `Log Hub release check failed to persist: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'failed';
    }
    return 'fetched';
  }

  /**
   * Response of `GET /api/v1/admin/log-hub-release`. A pure read (one PK lookup); never
   * inserts or updates, and is not affected by `LOG_HUB_RELEASE_CHECK_ENABLED`.
   */
  async getState(): Promise<LogHubReleaseState> {
    const origin = readBuildOrigin();
    if (!this.isEligible(origin)) {
      return {
        updateAvailable: false,
        currentVersion: null,
        latestVersion: null,
        releaseUrl: null,
      };
    }

    const [row] = await this.db
      .select({
        latestTag: schema.logHubReleaseCheck.latestTag,
        releaseUrl: schema.logHubReleaseCheck.releaseUrl,
      })
      .from(schema.logHubReleaseCheck)
      .where(eq(schema.logHubReleaseCheck.id, ROW_ID))
      .limit(1);

    const latestTag = row?.latestTag ?? null;
    const releaseUrl = row?.releaseUrl ?? null;
    const updateAvailable =
      latestTag !== null &&
      RELEASE_TAG_RE.test(latestTag) &&
      releaseUrl !== null &&
      releaseUrl.startsWith(RELEASE_URL_PREFIX) &&
      compareSemver(latestTag.slice(1), origin.version) > 0;

    return {
      updateAvailable,
      currentVersion: origin.version,
      latestVersion: updateAvailable ? latestTag.slice(1) : null,
      releaseUrl: updateAvailable ? releaseUrl : null,
    };
  }

  /** Accepts only a strict `vX.Y.Z` tag and an `html_url` on the Log Hub releases page. */
  private validate(json: unknown): ValidatedRelease | null {
    if (typeof json !== 'object' || json === null) return null;
    const tag = 'tag_name' in json ? json.tag_name : undefined;
    const url = 'html_url' in json ? json.html_url : undefined;
    if (typeof tag !== 'string' || !RELEASE_TAG_RE.test(tag)) return null;
    if (typeof url !== 'string' || !url.startsWith(RELEASE_URL_PREFIX)) {
      return null;
    }
    return { tag, url };
  }

  /**
   * Cluster claim: stamps `last_attempt_at = now()` only when no worker attempted within
   * the last `ATTEMPT_EVERY_HOURS`, regardless of that attempt's outcome. Returns true when
   * this worker won the claim.
   */
  private async claim(): Promise<boolean> {
    const result = await this.db.execute<{ id: number }>(sql`
      UPDATE log_hub_release_check SET last_attempt_at = now()
       WHERE id = ${ROW_ID}
         AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(hours => ${ATTEMPT_EVERY_HOURS}))
      RETURNING id
    `);
    return (result.rows[0] ?? null) !== null;
  }
}
