/**
 * Pure planner behind `LogRetentionService`: given the files in `logs/` and today's day tag,
 * returns which ones to delete. Rules and examples:
 * docs/knowledgebase/algorithms/log-retention.md.
 */

export interface LogFileInfo {
  name: string;
  size: number;
}

export interface LogRetentionPolicy {
  /** Days of `app-*.log` to keep, today included; 0 = no age limit. */
  appDays: number;
  /** Days of `sql-*.log` to keep, today included; 0 = no age limit. */
  sqlDays: number;
  /** Cap on the total size of all `app-*`/`sql-*` logs; 0 = no size limit. */
  maxTotalBytes: number;
}

export const DEFAULT_LOG_RETENTION_DAYS = 5;
export const DEFAULT_SQL_LOG_RETENTION_DAYS = 3;
export const DEFAULT_LOG_RETENTION_MAX_MB = 100;
export const DEFAULT_LOG_RETENTION_CHECK_INTERVAL_MS = 3_600_000;

const LOG_FILE_PATTERN = /^(app|sql)-(\d{4})-(\d{2})-(\d{2})(?:-i\d+)?\.log$/;
const DAY_MS = 86_400_000;

interface ParsedLogFile extends LogFileInfo {
  kind: 'app' | 'sql';
  dayTag: string;
  ageDays: number;
}

function dayNumber(year: string, month: string, day: string): number {
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / DAY_MS;
}

/** Non-negative integer from an env value; anything else falls back to `fallback`. */
export function parseRetentionEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function readLogRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): LogRetentionPolicy {
  return {
    appDays: parseRetentionEnv(
      env.LOG_RETENTION_DAYS,
      DEFAULT_LOG_RETENTION_DAYS,
    ),
    sqlDays: parseRetentionEnv(
      env.SQL_LOG_RETENTION_DAYS,
      DEFAULT_SQL_LOG_RETENTION_DAYS,
    ),
    maxTotalBytes:
      parseRetentionEnv(
        env.LOG_RETENTION_MAX_MB,
        DEFAULT_LOG_RETENTION_MAX_MB,
      ) *
      1024 *
      1024,
  };
}

/**
 * Returns the names to delete, in deletion order. `today` is the loggers' local day tag
 * (`YYYY-MM-DD`, see `computeDayTag()`). Files that are not `app-`/`sql-` day logs are never
 * deleted and do not count towards the size cap; today's files (still being written) are
 * never deleted.
 */
export function planLogCleanup(
  files: readonly LogFileInfo[],
  today: string,
  policy: LogRetentionPolicy,
): string[] {
  const todayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!todayMatch) throw new Error(`Invalid day tag: ${today}`);
  const todayNumber = dayNumber(todayMatch[1], todayMatch[2], todayMatch[3]);

  const parsed: ParsedLogFile[] = [];
  for (const file of files) {
    const m = LOG_FILE_PATTERN.exec(file.name);
    if (!m) continue;
    parsed.push({
      ...file,
      kind: m[1] as 'app' | 'sql',
      dayTag: `${m[2]}-${m[3]}-${m[4]}`,
      ageDays: todayNumber - dayNumber(m[2], m[3], m[4]),
    });
  }

  const toDelete: string[] = [];
  const kept: ParsedLogFile[] = [];
  for (const file of parsed) {
    const days = file.kind === 'app' ? policy.appDays : policy.sqlDays;
    if (days > 0 && file.ageDays >= days) {
      toDelete.push(file.name);
    } else {
      kept.push(file);
    }
  }
  toDelete.sort();

  if (policy.maxTotalBytes > 0) {
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    const candidates = kept
      .filter((file) => file.ageDays > 0)
      .sort(
        (a, b) =>
          a.dayTag.localeCompare(b.dayTag) ||
          (a.kind === b.kind ? 0 : a.kind === 'sql' ? -1 : 1) ||
          a.name.localeCompare(b.name),
      );
    for (const file of candidates) {
      if (total <= policy.maxTotalBytes) break;
      toDelete.push(file.name);
      total -= file.size;
    }
  }

  return toDelete;
}
