import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ErrorLogEntry, ErrorLogsResponse } from './error-logs.types';

/**
 * Both caps bound conceptually different things (files scanned vs. entries
 * returned) that happen to share a value — named separately rather than
 * reusing one constant.
 */
export const MAX_FILES_TO_SCAN = 30;
export const MAX_ENTRIES = 30;

/**
 * Matches rotated app-log filenames written by
 * `computeAppLogFileName()` (server/src/common/app-logger.ts), e.g.
 * `app-2026-01-01.log` or `app-2026-01-01-i0.log`. Capture group 1 is
 * the embedded day tag, used to sort candidates without touching the
 * filesystem again.
 */
export const FILE_NAME_PATTERN = /^app-(\d{4}-\d{2}-\d{2})(?:-i\d+)?\.log$/;

/**
 * Matches one fixed-width logback line produced by `formatLogbackLine()`
 * (server/src/common/logback-formatter.ts):
 * `YYYY-MM-DD HH:MM:SS.mmm LEVEL --- [context             ] : message  key=val`.
 * Capture groups: 1=time (23 chars), 2=level (5 chars), 3=context (20 chars),
 * 4=rest (message + optional trailing metadata).
 */
export const LINE_PATTERN = /^(.{23}) (.{5}) --- \[(.{20})\] : (.*)$/;

/** A run of two or more spaces — the separator `formatLogbackLine()` always
 * inserts between the message and its first `key=val` metadata pair. */
const DETAILS_SEPARATOR = / {2,}/;

interface ParsedLogEntry {
  timestamp: Date;
  source: string;
  message: string;
  details: string | null;
}

@Injectable()
export class ErrorLogsService {
  getErrorLogs(): ErrorLogsResponse {
    const logsDir = path.resolve('logs');

    // Fresh checkout before the first log line is written — same condition
    // SystemInfoService.getDiskUsage() already guards against:
    // report an empty result rather than throwing.
    if (!fs.existsSync(logsDir)) {
      return { entries: [] };
    }

    const files = this.listErrorLogFiles(logsDir);

    const merged: ParsedLogEntry[] = [];
    for (const file of files) {
      merged.push(...this.parseFile(path.join(logsDir, file)));
    }

    merged.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const entries: ErrorLogEntry[] = merged
      .slice(0, MAX_ENTRIES)
      .map((entry) => ({
        timestamp: entry.timestamp.toISOString(),
        source: entry.source,
        message: entry.message,
        details: entry.details,
      }));

    return { entries };
  }

  /**
   * Lists candidate log filenames from `logsDir`, sorted by embedded day
   * tag descending, capped to `MAX_FILES_TO_SCAN`.
   * Directory listing (rather than walking backward day-by-day) is
   * required so filenames from other cluster workers are discovered too —
   * `computeInstanceSuffix()` only ever knows this process's own suffix.
   */
  private listErrorLogFiles(logsDir: string): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(logsDir);
    } catch {
      return [];
    }

    const tagged = names
      .map((name) => {
        const match = FILE_NAME_PATTERN.exec(name);
        return match ? { name, dayTag: match[1] } : null;
      })
      .filter(
        (entry): entry is { name: string; dayTag: string } => entry !== null,
      );

    tagged.sort((a, b) =>
      a.dayTag < b.dayTag ? 1 : a.dayTag > b.dayTag ? -1 : 0,
    );

    return tagged.slice(0, MAX_FILES_TO_SCAN).map((entry) => entry.name);
  }

  /**
   * Parses a single log file into its ERROR entries.
   * Missing/renamed files (e.g. rotated away mid-scan) are skipped rather
   * than failing the whole request.
   */
  private parseFile(fullPath: string): ParsedLogEntry[] {
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      return [];
    }

    const entries: ParsedLogEntry[] = [];
    let currentEntry: ParsedLogEntry | null = null;

    for (const line of content.split('\n')) {
      const match = LINE_PATTERN.exec(line);

      if (match) {
        const [, time, level, context, rest] = match;
        if (level.trim() === 'ERROR') {
          const { message, details } = this.splitMessageDetails(rest);
          const entry: ParsedLogEntry = {
            timestamp: this.parseLogTimestamp(time),
            source: context.trim(),
            message,
            details,
          };
          entries.push(entry);
          currentEntry = entry;
        } else {
          // A new, non-ERROR record starts here — the previous entry's
          // continuation window is over.
          currentEntry = null;
        }
      } else if (line.trim() !== '' && currentEntry) {
        currentEntry.details = currentEntry.details
          ? `${currentEntry.details}\n${line}`
          : line;
      }
      // Non-matching blank lines, and non-matching lines with no entry in
      // progress, are skipped.
    }

    return entries;
  }

  /**
   * Splits a matched line's trailing `rest` group at the first double-space
   * run into `message` / `details`.
   */
  private splitMessageDetails(rest: string): {
    message: string;
    details: string | null;
  } {
    const match = DETAILS_SEPARATOR.exec(rest);
    if (!match) {
      return { message: rest, details: null };
    }
    return {
      message: rest.slice(0, match.index),
      details: rest.slice(match.index + match[0].length),
    };
  }

  /**
   * Parses `formatTimestamp()`'s local-time string (`YYYY-MM-DD
   * HH:MM:SS.mmm`) back into a `Date` via local-time field construction —
   * the same convention it was originally written with, not UTC parsing.
   */
  private parseLogTimestamp(time: string): Date {
    const match =
      /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(time);
    if (!match) return new Date(NaN);

    const [, year, month, day, hour, minute, second, millis] = match;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millis),
    );
  }
}
