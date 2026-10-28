import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import archiver from 'archiver';
import {
  and,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
} from 'drizzle-orm';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yauzl from 'yauzl';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  logRepositories,
  logs,
  repositories,
  sessionFileStats,
  sessionStats,
  sessions,
  teams,
  users,
} from '../database/schema/index';
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_IMPORT_CHUNK_SIZE,
  type ExportMetaJson,
  type SessionJson,
  isSafeZipEntryPath,
  parseJsonlToArray,
  resolveExportImportStagingDir,
  serializeArrayToJsonl,
} from './export-import-zip';
import { ExportImportJobsService } from './export-import-jobs.service';
import { getImportLimits, ImportLimitError } from './import-limits';
import { loadHarnessSnapshot } from './harness-snapshot';
import { loadOkfSnapshot } from './okf/okf-snapshot';
import {
  findForeignAuthorEmails,
  findForeignSessionIds,
  type ImportSessionInput,
  LogsService,
} from './logs.service';
import type { AuthUser, RepositoryRow } from './repositories.service';
import { RepositoriesService } from './repositories.service';
import {
  type ImportConflict,
  type ImportConflictReason,
  importConflictRaceMessage,
} from './upload-warnings';
import { TeamsService } from '../teams/teams.service';

export type ExportImportScope = 'all' | 'dateRange' | 'sessionIds';

export interface ScopeFilters {
  from?: string;
  to?: string;
  sessionIds?: string[];
}

export interface ScopeSummary {
  sessionCount: number;
  approxUncompressedBytes: number;
}

interface MatchingSessionRow {
  sessionRowId: number;
  sessionId: string;
  parentSessionId: string | null;
  workflowRunId: string | null;
  /** DD-14: non-null when a harness snapshot (DD-9) is bound to this session. */
  harnessSnapshotId: string | null;
  /** Non-null when an OKF snapshot is bound to this (root) session (DD-21). */
  okfSnapshotId: string | null;
}

/**
 * A staged import archive whose `session.json` entries fail validation (invalid
 * JSON, a bad `sessionId`/`parentSessionId`, a non-object `logs`, a non-string
 * author `userEmail`, or a `sessionId` repeated across two entries). Thrown by
 * `findImportConflicts()` at upload/confirm time, in every auth mode.
 */
export class ImportArchiveInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportArchiveInvalidError';
  }
}

/** `sessions.session_id` is `varchar(255)`. */
const MAX_SESSION_ID_LENGTH = 255;

/** What the conflict pre-check needs from one `session.json`. */
interface SessionJsonCheckInfo {
  sessionId: string;
  parentSessionId: string | null;
  /** Normalised (`trim().toLowerCase()`), distinct. */
  authorEmails: string[];
}

function isValidSessionIdValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH
  );
}

function normaliseAuthorEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Export/import job logic for one repository's sessions. New sibling to `RepositoriesService`/`LogsService`,
 * not more methods on either — this class owns the
 * scope-preview query, the export job runner (zip build), the uploaded-zip
 * meta parser, and the import job runner (zip extraction + `logs` writes).
 */
@Injectable()
export class RepositoryExportImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
    private readonly exportImportJobsService: ExportImportJobsService,
    private readonly logsService: LogsService,
    private readonly teamsService: TeamsService,
    private readonly configService: ConfigService,
  ) {}

  /** `AUTH_MODE=none` — one effective user, so no ownership checks apply. */
  private isSingleUserMode(): boolean {
    return this.configService.get<string>('AUTH_MODE') === 'none';
  }

  /**
   * Session count + approximate uncompressed size for
   * one export/import scope — the fast synchronous preview request/response
   * round trip that precedes starting a background export job.
   */
  async getScopeSummary(
    user: AuthUser,
    repoId: number,
    teamId: number | undefined,
    scope: ExportImportScope,
    filters: ScopeFilters,
  ): Promise<ScopeSummary> {
    const matching = await this.resolveMatchingSessions(
      user,
      repoId,
      teamId,
      scope,
      filters,
    );

    if (matching.length === 0) {
      return { sessionCount: 0, approxUncompressedBytes: 0 };
    }

    const approxUncompressedBytes = await this.sumLogBytes(
      matching.map((m) => m.sessionRowId),
    );

    return { sessionCount: matching.length, approxUncompressedBytes };
  }

  /**
   * Builds the export zip for `jobId` in batches of `EXPORT_IMPORT_CHUNK_SIZE`
   * sessions, yielding the event loop between batches,
   * and reports progress via `ExportImportJobsService.updateProgress()` after
   * each batch. Never throws — every failure path reports `fail()` on the job
   * row instead, since the controller calls this without awaiting it.
   */
  async runExportJob(
    jobId: string,
    user: AuthUser,
    repo: RepositoryRow,
    repoId: number,
    teamId: number | undefined,
    scope: ExportImportScope,
    filters: ScopeFilters,
    description: string | undefined,
  ): Promise<void> {
    try {
      const matching = await this.resolveMatchingSessions(
        user,
        repoId,
        teamId,
        scope,
        filters,
      );
      const total = matching.length;
      await this.exportImportJobsService.updateProgress(jobId, 0, total);

      let teamName: string | undefined;
      if (teamId !== undefined) {
        const [team] = await this.db
          .select({ name: teams.name })
          .from(teams)
          .where(eq(teams.id, teamId));
        teamName = team?.name;
      }

      const approxUncompressedBytes = await this.sumLogBytes(
        matching.map((m) => m.sessionRowId),
      );

      const meta: ExportMetaJson = {
        formatVersion: EXPORT_FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        sourceHost: os.hostname(),
        sourceRepoUrl: repo.repoUrl,
        sourceRepoContext:
          teamId !== undefined
            ? { type: 'team', teamId, teamName }
            : { type: 'personal' },
        description,
        sessionCount: total,
        approxUncompressedBytes,
      };

      const stagingDir = resolveExportImportStagingDir();
      const fileName = `${jobId}.zip`;
      const filePath = path.join(stagingDir, fileName);

      await this.writeExportZip(filePath, meta, matching, jobId, total);

      await this.exportImportJobsService.complete(jobId, {
        resultFilePath: filePath,
        resultFileName: fileName,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.exportImportJobsService.fail(jobId, message);
    }
  }

  /**
   * Streams just the `meta.json` entry out of an uploaded (not yet
   * confirmed) zip via `yauzl` — never writes anything to disk, and never
   * buffers the rest of the archive. Validates
   * `formatVersion`; throws a descriptive `Error` on any
   * problem (missing `meta.json`, unparseable JSON, unsupported version) for
   * the caller to surface as a 422.
   */
  async parseUploadedZipMeta(stagedFilePath: string): Promise<ExportMetaJson> {
    const zipfile = await yauzl.openPromise(stagedFilePath, {
      lazyEntries: true,
    });
    try {
      for await (const entry of zipfile.eachEntry()) {
        if (entry.fileName !== 'meta.json') continue;

        const raw = await this.readZipEntryToString(zipfile, entry);
        let parsed: ExportMetaJson;
        try {
          parsed = JSON.parse(raw) as ExportMetaJson;
        } catch {
          throw new Error('meta.json is not valid JSON');
        }
        if (parsed.formatVersion !== EXPORT_FORMAT_VERSION) {
          throw new Error(
            `Unsupported export formatVersion: ${parsed.formatVersion}`,
          );
        }
        return parsed;
      }
    } finally {
      zipfile.close();
    }
    throw new Error('Uploaded zip is missing meta.json');
  }

  /**
   * Conflict pre-check of a staged import zip against `importerId`, run by the
   * upload and confirm handlers before any write.
   *
   * Reads only `sessions/<id>/session.json` entries (lazily, zip-slip-checked,
   * entry-size-limited exactly like `runImportJob`) and validates each one in
   * every auth mode — an invalid one, or a `sessionId` repeated across two
   * entries, throws `ImportArchiveInvalidError`. Under `AUTH_MODE=none` it
   * returns `[]` after validating, without any query. Otherwise it reports
   * every `(sessionId, reason)` pair once:
   * - `foreign-session` — the (non-deleted) session has a log of another user;
   * - `foreign-parent` — the parent session (soft-deleted ones included) has a
   *   log of another user;
   * - `foreign-author` — a `logs.claude`/`logs.artisyn` author email belongs to
   *   another registered (non-placeholder) user.
   *
   * Unsafe entry paths and import-limit errors propagate as thrown errors.
   */
  async findImportConflicts(
    stagedFilePath: string,
    importerId: number,
  ): Promise<ImportConflict[]> {
    const infos: SessionJsonCheckInfo[] = [];
    const seenSessionIds = new Set<string>();

    const zipfile = await yauzl.openPromise(stagedFilePath, {
      lazyEntries: true,
    });
    try {
      for await (const entry of zipfile.eachEntry()) {
        if (!isSafeZipEntryPath(entry.fileName)) {
          throw new Error(`Unsafe zip entry path: ${entry.fileName}`);
        }
        if (!/^sessions\/[^/]+\/session\.json$/.test(entry.fileName)) continue;

        const raw = await this.readZipEntryToString(zipfile, entry);
        const info = this.parseSessionJsonForCheck(raw, entry.fileName);
        if (seenSessionIds.has(info.sessionId)) {
          throw new ImportArchiveInvalidError(
            `Invalid import archive: sessionId ${info.sessionId} appears in more than one session.json`,
          );
        }
        seenSessionIds.add(info.sessionId);
        infos.push(info);
      }
    } finally {
      zipfile.close();
    }

    if (this.isSingleUserMode() || infos.length === 0) return [];

    const foreignSessions = new Set(
      await findForeignSessionIds(
        this.db,
        infos.map((i) => i.sessionId),
        importerId,
        { includeDeleted: false },
      ),
    );
    const parentIds = infos
      .map((i) => i.parentSessionId)
      .filter((id): id is string => id !== null);
    const foreignParents = new Set(
      parentIds.length > 0
        ? await findForeignSessionIds(this.db, parentIds, importerId, {
            includeDeleted: true,
          })
        : [],
    );
    const allEmails = infos.flatMap((i) => i.authorEmails);
    const foreignEmails = new Set(
      allEmails.length > 0
        ? await findForeignAuthorEmails(this.db, allEmails, importerId)
        : [],
    );

    const conflicts: ImportConflict[] = [];
    for (const info of infos) {
      const push = (reason: ImportConflictReason): void => {
        conflicts.push({ sessionId: info.sessionId, reason });
      };
      if (foreignSessions.has(info.sessionId)) push('foreign-session');
      if (info.authorEmails.some((email) => foreignEmails.has(email))) {
        push('foreign-author');
      }
      if (
        info.parentSessionId !== null &&
        foreignParents.has(info.parentSessionId)
      ) {
        push('foreign-parent');
      }
    }
    return conflicts;
  }

  /**
   * Validates one raw `session.json` for `findImportConflicts()` and extracts
   * what the pre-check needs. Throws `ImportArchiveInvalidError` on invalid
   * JSON, a `sessionId` that is not a non-empty string of at most 255
   * characters, a `parentSessionId` that is neither null nor such a string, a
   * non-object `logs`, or a present `logs.claude`/`logs.artisyn` whose
   * `userEmail` is not a string. Author emails come back normalised.
   */
  private parseSessionJsonForCheck(
    raw: string,
    entryName: string,
  ): SessionJsonCheckInfo {
    const invalid = (reason: string): ImportArchiveInvalidError =>
      new ImportArchiveInvalidError(
        `Invalid import archive: ${entryName} ${reason}`,
      );

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid('is not valid JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw invalid('is not a JSON object');
    }
    const json = parsed as Record<string, unknown>;

    const sessionId = json['sessionId'];
    if (!isValidSessionIdValue(sessionId)) {
      throw invalid(
        `has an invalid sessionId (must be a non-empty string of at most ${MAX_SESSION_ID_LENGTH} characters)`,
      );
    }
    const parentRaw = json['parentSessionId'] ?? null;
    let parentSessionId: string | null = null;
    if (parentRaw !== null) {
      if (!isValidSessionIdValue(parentRaw)) {
        throw invalid(
          `has an invalid parentSessionId (must be null or a non-empty string of at most ${MAX_SESSION_ID_LENGTH} characters)`,
        );
      }
      parentSessionId = parentRaw;
    }
    const logsRaw = json['logs'];
    if (
      typeof logsRaw !== 'object' ||
      logsRaw === null ||
      Array.isArray(logsRaw)
    ) {
      throw invalid('has no logs object');
    }
    const logsObj = logsRaw as Record<string, unknown>;

    const emails = new Set<string>();
    for (const logType of ['claude', 'artisyn'] as const) {
      const entry = logsObj[logType];
      if (entry === undefined || entry === null) continue;
      const email =
        typeof entry === 'object'
          ? (entry as Record<string, unknown>)['userEmail']
          : undefined;
      if (typeof email !== 'string') {
        throw invalid(`has a non-string logs.${logType}.userEmail`);
      }
      emails.add(normaliseAuthorEmail(email));
    }

    return {
      sessionId,
      parentSessionId,
      authorEmails: [...emails],
    };
  }

  /**
   * Extracts and writes every session in an already-confirmed import job's
   * staged zip. Sessions are grouped and written
   * one at a time as their three files (`session.json`, `claude.jsonl`,
   * `artisyn.jsonl`) are encountered — `runExportJob` always appends them
   * together in that order, so at most one session's data is held in memory
   * at a time, never the whole archive. Every entry path is zip-slip-checked
   * before it is ever read; the whole job aborts with an
   * error status on the first unsafe entry or unsupported `formatVersion`.
   * Never throws — every failure path reports `fail()` on the job row
   * instead, since the controller calls this without awaiting it.
   */
  async runImportJob(
    jobId: string,
    stagedFilePath: string,
    targetRepoUrl: string,
    targetUserId: number,
    teamId?: number,
  ): Promise<void> {
    let processed = 0;
    let currentSessionId: string | null = null;
    let currentMeta: SessionJson | null = null;
    let currentClaudeLines: object[] | null = null;
    let currentArtisynLines: object[] | null = null;
    const processedAuthorIds = new Set<number>();

    const flushCurrent = async (): Promise<void> => {
      if (currentSessionId === null) return;
      if (currentMeta === null) {
        // session.json was never seen for this folder — nothing to import.
        currentSessionId = null;
        currentClaudeLines = null;
        currentArtisynLines = null;
        return;
      }

      await this.importOneSession(
        currentMeta,
        currentClaudeLines,
        currentArtisynLines,
        targetRepoUrl,
        targetUserId,
        teamId,
        processedAuthorIds,
      );

      processed += 1;
      currentSessionId = null;
      currentMeta = null;
      currentClaudeLines = null;
      currentArtisynLines = null;

      if (processed % EXPORT_IMPORT_CHUNK_SIZE === 0) {
        await this.exportImportJobsService.updateProgress(jobId, processed);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    try {
      const zipfile = await yauzl.openPromise(stagedFilePath, {
        lazyEntries: true,
      });
      try {
        for await (const entry of zipfile.eachEntry()) {
          // Zip-slip guard — checked for every entry
          // before it is ever read.
          if (!isSafeZipEntryPath(entry.fileName)) {
            throw new Error(`Unsafe zip entry path: ${entry.fileName}`);
          }
          if (entry.fileName.endsWith('/')) continue; // directory marker

          if (entry.fileName === 'meta.json') {
            // Re-validated here defensively — parseUploadedZipMeta already
            // checked this at upload time, but a confirm request could in
            // theory race a stale/corrupted staged file.
            const raw = await this.readZipEntryToString(zipfile, entry);
            const meta = JSON.parse(raw) as ExportMetaJson;
            if (meta.formatVersion !== EXPORT_FORMAT_VERSION) {
              throw new Error(
                `Unsupported export formatVersion: ${meta.formatVersion}`,
              );
            }
            continue;
          }

          const match =
            /^sessions\/([^/]+)\/(session\.json|claude\.jsonl|artisyn\.jsonl)$/.exec(
              entry.fileName,
            );
          if (!match) continue; // ignore unknown entries

          const [, sessionId, kind] = match;

          if (sessionId !== currentSessionId) {
            await flushCurrent();
            currentSessionId = sessionId;
          }

          const raw = await this.readZipEntryToString(zipfile, entry);
          if (kind === 'session.json') {
            currentMeta = JSON.parse(raw) as SessionJson;
          } else if (kind === 'claude.jsonl') {
            currentClaudeLines = parseJsonlToArray(raw);
          } else if (kind === 'artisyn.jsonl') {
            currentArtisynLines = parseJsonlToArray(raw);
          }
        }
        await flushCurrent();
      } finally {
        zipfile.close();
      }

      await this.exportImportJobsService.updateProgress(jobId, processed);
      await this.exportImportJobsService.complete(jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.exportImportJobsService.fail(jobId, message);
    } finally {
      try {
        await fs.promises.unlink(stagedFilePath);
      } catch {
        // Best-effort: a leftover staged file is at worst disk cruft — the
        // job row (already done/error) is the source of truth for whether
        // the import ran, and the cleanup sweep never revisits an
        // `import`-kind row's file path.
      }
    }
  }

  /**
   * Writes one archived session through `LogsService.importSession()` — one
   * transaction for all its logs (claude, then artisyn; only those present).
   *
   * - `AUTH_MODE=none`: no author resolution, no placeholder users, no team
   *   membership; every log is attributed to the importer and every existing
   *   log of the session is reassigned to them (`reassignToImporter`).
   * - Otherwise: an existing session the importer already owns keeps the
   *   importer as the owner of every log (no author resolution). Any other
   *   session resolves each author by normalised email (creating a placeholder
   *   user when unknown), and resolved authors join the import team only
   *   after the write succeeded.
   *
   * `foreign-session` (the session changed hands after the pre-check) throws
   * the race message, which `runImportJob` turns into a job error — sessions
   * already written stay. `deleted` is a silent skip.
   */
  private async importOneSession(
    meta: SessionJson,
    claudeLines: object[] | null,
    artisynLines: object[] | null,
    targetRepoUrl: string,
    targetUserId: number,
    teamId?: number,
    processedAuthorIds?: Set<number>,
  ): Promise<void> {
    const present: Array<{
      logType: 'claude' | 'artisyn';
      lines: object[];
      userEmail: string;
    }> = [];
    if (claudeLines && meta.logs.claude) {
      present.push({
        logType: 'claude',
        lines: claudeLines,
        userEmail: meta.logs.claude.userEmail,
      });
    }
    if (artisynLines && meta.logs.artisyn) {
      present.push({
        logType: 'artisyn',
        lines: artisynLines,
        userEmail: meta.logs.artisyn.userEmail,
      });
    }

    const singleUser = this.isSingleUserMode();
    // Authors resolved from the archive — only they are added to the team.
    const resolvedAuthorIds: number[] = [];
    const inputLogs: ImportSessionInput['logs'] = [];
    const ownedByImporter =
      !singleUser &&
      (await this.logsService.getSessionOwnerId(meta.sessionId)) ===
        targetUserId;
    for (const log of present) {
      let resolvedUserId = targetUserId;
      if (!singleUser && !ownedByImporter) {
        resolvedUserId =
          await this.logsService.resolveOrCreatePlaceholderUserByEmail(
            log.userEmail.trim().toLowerCase(),
          );
        resolvedAuthorIds.push(resolvedUserId);
      }
      inputLogs.push({
        logType: log.logType,
        lines: log.lines,
        resolvedUserId,
      });
    }

    const result = await this.logsService.importSession({
      sessionId: meta.sessionId,
      parentSessionId: meta.parentSessionId ?? null,
      workflowRunId: meta.workflowRunId ?? null,
      firstPrompt: meta.firstPrompt ?? null,
      gitBranch: meta.gitBranch ?? null,
      startTime: meta.startTime ?? null,
      endTime: meta.endTime ?? null,
      logs: inputLogs,
      targetRepoUrl,
      targetUserId,
      reassignToImporter: singleUser,
    });

    if (result.status === 'foreign-session') {
      throw new Error(importConflictRaceMessage(meta.sessionId));
    }
    if (result.status !== 'ok') return; // `deleted` — silent skip

    for (const authorId of resolvedAuthorIds) {
      await this.addAuthorAsTeamMemberOnce(
        teamId,
        processedAuthorIds,
        authorId,
      );
    }
  }

  private async addAuthorAsTeamMemberOnce(
    teamId: number | undefined,
    processedAuthorIds: Set<number> | undefined,
    resolvedUserId: number,
  ): Promise<void> {
    if (
      teamId === undefined ||
      processedAuthorIds === undefined ||
      processedAuthorIds.has(resolvedUserId)
    ) {
      return;
    }
    await this.teamsService.addMemberIfRealUser(teamId, resolvedUserId);
    processedAuthorIds.add(resolvedUserId);
  }

  private async readZipEntryToString(
    zipfile: yauzl.ZipFile,
    entry: yauzl.Entry,
  ): Promise<string> {
    // Bounded by IMPORT_MAX_ENTRY_BYTES: an entry is buffered into a
    // single string, so it must stay well below the V8 max string length.
    const { maxEntryBytes } = getImportLimits();
    const stream = await zipfile.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxEntryBytes) {
          settled = true;
          stream.destroy();
          reject(
            ImportLimitError.exceeded('maxEntryBytes', size, maxEntryBytes),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      stream.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
    return Buffer.concat(chunks, size).toString('utf8');
  }

  private async writeExportZip(
    filePath: string,
    meta: ExportMetaJson,
    matching: MatchingSessionRow[],
    jobId: string,
    total: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(filePath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      output.on('close', settleResolve);
      output.on('error', settleReject);
      archive.on('error', settleReject);
      archive.pipe(output);

      archive.append(JSON.stringify(meta, null, 2), { name: 'meta.json' });

      void (async () => {
        try {
          let processed = 0;
          for (let i = 0; i < matching.length; i += EXPORT_IMPORT_CHUNK_SIZE) {
            const chunk = matching.slice(i, i + EXPORT_IMPORT_CHUNK_SIZE);
            await this.appendSessionChunk(archive, chunk);
            processed += chunk.length;
            await this.exportImportJobsService.updateProgress(
              jobId,
              processed,
              total,
            );
            await new Promise<void>((r) => setImmediate(r));
          }
          await archive.finalize();
        } catch (err) {
          settleReject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  }

  private async appendSessionChunk(
    archive: archiver.Archiver,
    chunk: MatchingSessionRow[],
  ): Promise<void> {
    const chunkRowIds = chunk.map((c) => c.sessionRowId);

    const logRows = await this.db
      .select({
        sessionRowId: logs.sessionId,
        logType: logs.logType,
        body: logs.body,
        userId: logs.userId,
        userEmail: users.email,
        firstPrompt: logs.firstPrompt,
        startTime: logs.startTime,
        endTime: logs.endTime,
        updatedAt: logs.updatedAt,
        gitBranch: logs.gitBranch,
      })
      .from(logs)
      .innerJoin(users, eq(users.id, logs.userId))
      .where(
        and(
          inArray(logs.sessionId, chunkRowIds),
          inArray(logs.logType, ['claude', 'artisyn']),
        ),
      );

    const statsRows = await this.db
      .select()
      .from(sessionStats)
      .where(
        and(
          inArray(sessionStats.sessionId, chunkRowIds),
          // Excludes an OTEL-only session_stats row (no transcript ever
          // uploaded for it) from the export — repository export/import is out of
          // scope for telemetry_cost (it stays NULL until OTEL data is re-ingested
          // after import), and such a row has no transcript-derived data worth
          // exporting either.
          exists(
            this.db
              .select({ id: logs.id })
              .from(logs)
              .where(
                and(
                  eq(logs.sessionId, sessionStats.sessionId),
                  inArray(logs.logType, ['claude', 'claude-subagent']),
                ),
              ),
          ),
        ),
      );

    const fileStatsRows = await this.db
      .select()
      .from(sessionFileStats)
      .where(inArray(sessionFileStats.sessionId, chunkRowIds));

    const logsBySession = new Map<number, typeof logRows>();
    for (const row of logRows) {
      const list = logsBySession.get(row.sessionRowId) ?? [];
      list.push(row);
      logsBySession.set(row.sessionRowId, list);
    }

    for (const session of chunk) {
      const sessionLogs = logsBySession.get(session.sessionRowId) ?? [];
      const claudeLog = sessionLogs.find((l) => l.logType === 'claude');
      const artisynLog = sessionLogs.find((l) => l.logType === 'artisyn');

      const statsRow = statsRows.find(
        (s) => s.sessionId === session.sessionRowId,
      );
      const sessionFileStatsRows = fileStatsRows.filter(
        (f) => f.sessionId === session.sessionRowId,
      );

      const stats: Record<string, unknown> | null = statsRow
        ? {
            model: statsRow.model,
            inputTokens: statsRow.inputTokens,
            outputTokens: statsRow.outputTokens,
            cacheReadTokens: statsRow.cacheReadTokens,
            cacheWriteTokens: statsRow.cacheWriteTokens,
            // Cache-write TTL split (subsets of cacheWriteTokens).
            cacheWrite5mTokens: statsRow.cacheWrite5mTokens,
            cacheWrite1hTokens: statsRow.cacheWrite1hTokens,
            // Billable server-tool usage and fast-mode subsets of the
            // input/output totals above.
            webSearchRequests: statsRow.webSearchRequests,
            inputTokensFast: statsRow.inputTokensFast,
            outputTokensFast: statsRow.outputTokensFast,
            workTimeMs: statsRow.workTimeMs,
            filesEditedWritten: statsRow.filesEditedWritten,
            linesChanged: statsRow.linesChanged,
            imageCount: statsRow.imageCount,
            imageTotalBytes: statsRow.imageTotalBytes,
            mcpCallsTotal: statsRow.mcpCallsTotal,
            mcpCallsByServer: statsRow.mcpCallsByServer,
            // productivity/usage counters. Import re-derives every session_stats value
            // through extractClaudeStats() on the imported body, so these are carried for
            // completeness and inspectability rather than being read back on import.
            linesAdded: statsRow.linesAdded,
            linesRemoved: statsRow.linesRemoved,
            commitCount: statsRow.commitCount,
            prCount: statsRow.prCount,
            turnCount: statsRow.turnCount,
            diffLinesCoveredCalls: statsRow.diffLinesCoveredCalls,
            diffLinesTotalCalls: statsRow.diffLinesTotalCalls,
            tokenByServiceTier: statsRow.tokenByServiceTier,
            fileStats: sessionFileStatsRows.map((f) => ({
              categoryName: f.categoryName,
              fileCount: f.fileCount,
              byteCount: f.byteCount,
            })),
          }
        : null;

      const sessionJson: SessionJson = {
        sessionId: session.sessionId,
        parentSessionId: session.parentSessionId,
        workflowRunId: session.workflowRunId,
        firstPrompt: artisynLog?.firstPrompt ?? null,
        startTime: (
          artisynLog?.startTime ??
          artisynLog?.updatedAt ??
          new Date(0)
        ).toISOString(),
        endTime: (
          artisynLog?.endTime ??
          artisynLog?.updatedAt ??
          new Date(0)
        ).toISOString(),
        gitBranch: artisynLog?.gitBranch ?? null,
        okfSnapshotId: session.okfSnapshotId,
        stats,
        logs: {
          ...(claudeLog ? { claude: { userEmail: claudeLog.userEmail } } : {}),
          ...(artisynLog
            ? { artisyn: { userEmail: artisynLog.userEmail } }
            : {}),
        },
      };

      const baseDir = `sessions/${session.sessionId}`;
      archive.append(JSON.stringify(sessionJson, null, 2), {
        name: `${baseDir}/session.json`,
      });
      if (claudeLog) {
        archive.append(serializeArrayToJsonl(claudeLog.body as unknown[]), {
          name: `${baseDir}/claude.jsonl`,
        });
      }
      if (artisynLog) {
        const artisynBodyLines = artisynLog.body as unknown[];
        const snapshotLines = await this.buildExportHarnessSnapshotLines(
          session.harnessSnapshotId,
          artisynLog.userId,
          artisynBodyLines,
        );
        const okfSnapshotLines = await this.buildExportOkfSnapshotLines(
          session.okfSnapshotId,
          artisynLog.userId,
          artisynBodyLines,
        );
        archive.append(
          serializeArrayToJsonl([
            ...snapshotLines,
            ...okfSnapshotLines,
            ...artisynBodyLines,
          ]),
          { name: `${baseDir}/artisyn.jsonl` },
        );
      }
    }
  }

  /**
   * DD-14: prepends the session's stored harness snapshot to its exported `artisyn.jsonl` —
   * a full `harness-snapshot` line built from the `harness_snapshots` table row, keyed by
   * the artisyn log's owner (not necessarily the exporting user: a team export covers every
   * member's sessions). This makes the archive self-sufficient even though the live body
   * usually carries only the ref-only line, since the full snapshot is sent just once (to
   * whichever upload first saw an unknown id). A `harness-snapshot-ref` line is added only
   * when the body doesn't already carry one — most artisyn uploads do (DD-7) — so
   * re-importing it never doubles the ref up. Returns `[]` when the session has no bound
   * snapshot, or the row no longer exists (DD-21's accepted race).
   */
  private async buildExportHarnessSnapshotLines(
    harnessSnapshotId: string | null,
    ownerUserId: number,
    bodyLines: unknown[],
  ): Promise<object[]> {
    if (harnessSnapshotId === null) return [];
    const body = await loadHarnessSnapshot(
      this.db,
      ownerUserId,
      harnessSnapshotId,
    );
    if (body === null) return [];

    const lines: object[] = [{ type: 'harness-snapshot', ...body }];
    const hasRef = bodyLines.some(
      (line) =>
        (line as { type?: unknown } | null)?.type === 'harness-snapshot-ref',
    );
    if (!hasRef) {
      lines.push({
        type: 'harness-snapshot-ref',
        snapshotId: harnessSnapshotId,
      });
    }
    return lines;
  }

  /**
   * OKF counterpart of {@link buildExportHarnessSnapshotLines} (DD-21, DD-42 of
   * docs/tasks/todo/2026-10-27-okf-usage-tab/impl-plan.md): prepends the bound OKF snapshot to
   * the exported `artisyn.jsonl` as a full `okf-snapshot` line from the `okf_snapshots` row of
   * the artisyn log's owner, plus an `okf-snapshot-ref` line, so import rebinds the session to
   * the same id. Import binds the FIRST valid ref (or full line) it sees, so each line is
   * skipped only when the body's first line of that type already names the bound id — a
   * re-exported, re-imported body never grows. Returns `[]` when the session has no bound OKF
   * snapshot or the row no longer exists. Older Log Hub versions skip both unknown line types.
   */
  private async buildExportOkfSnapshotLines(
    okfSnapshotId: string | null,
    ownerUserId: number,
    bodyLines: unknown[],
  ): Promise<object[]> {
    if (okfSnapshotId === null) return [];
    const body = await loadOkfSnapshot(this.db, ownerUserId, okfSnapshotId);
    if (body === null) return [];

    const firstIdOfType = (type: string): unknown => {
      const line = bodyLines.find(
        (l) => (l as { type?: unknown } | null)?.type === type,
      ) as { okfSnapshotId?: unknown } | undefined;
      return line?.okfSnapshotId;
    };

    const lines: object[] = [];
    if (firstIdOfType('okf-snapshot') !== okfSnapshotId) {
      lines.push({ type: 'okf-snapshot', ...body });
    }
    if (firstIdOfType('okf-snapshot-ref') !== okfSnapshotId) {
      lines.push({ type: 'okf-snapshot-ref', okfSnapshotId });
    }
    return lines;
  }

  private async sumLogBytes(sessionRowIds: number[]): Promise<number> {
    if (sessionRowIds.length === 0) return 0;
    const [row] = await this.db
      .select({
        approxUncompressedBytes: sql<number>`COALESCE(SUM(octet_length(${logs.body}::text)), 0)`,
      })
      .from(logs)
      .where(
        and(
          inArray(logs.sessionId, sessionRowIds),
          inArray(logs.logType, ['claude', 'artisyn']),
        ),
      );
    return Number(row?.approxUncompressedBytes ?? 0);
  }

  private async resolveMatchingSessions(
    user: AuthUser,
    repoId: number,
    teamId: number | undefined,
    scope: ExportImportScope,
    filters: ScopeFilters,
  ): Promise<MatchingSessionRow[]> {
    const { repoCondition } =
      await this.repositoriesService.buildSessionListConditions(
        user,
        repoId,
        teamId,
        undefined,
      );

    // This is one of the two owner-only export surfaces: it is
    // `assertRepoOwnerOrTeamOwner`-gated (see `repository-export-import.controller.ts:266`)
    // and therefore deliberately does NOT take `buildSessionListConditions`' per-caller
    // `ownerCondition`. The one access-mode rule that does reach it is the
    // disclosure-acknowledgement gate — a member who has not acknowledged the disclosure is
    // invisible to the team owner, exports included. `null` (a `transparent` team, or
    // the personal view) emits no user predicate at all.
    const visibleUserIds =
      teamId === undefined
        ? null
        : await this.repositoriesService.resolveExportVisibleUserIds(teamId);
    const visibilityCondition =
      visibleUserIds === null
        ? undefined
        : visibleUserIds.length === 0
          ? sql`false`
          : inArray(logs.userId, visibleUserIds);

    const scopeCondition = this.buildScopeCondition(scope, filters);

    return this.db
      .selectDistinct({
        sessionRowId: sessions.id,
        sessionId: sessions.sessionId,
        parentSessionId: sessions.parentSessionId,
        workflowRunId: sessions.workflowRunId,
        harnessSnapshotId: sessions.harnessSnapshotId,
        okfSnapshotId: sessions.okfSnapshotId,
      })
      .from(sessions)
      .innerJoin(logs, eq(logs.sessionId, sessions.id))
      .innerJoin(logRepositories, eq(logRepositories.logId, logs.id))
      .innerJoin(repositories, eq(repositories.id, logRepositories.repoId))
      .where(
        and(
          repoCondition,
          eq(logs.logType, 'artisyn'),
          isNotNull(logs.firstPrompt),
          eq(sessions.deleted, false),
          exists(
            this.db
              .select({ id: logs.id })
              .from(logs)
              .where(
                and(
                  eq(logs.sessionId, sessions.id),
                  eq(logs.logType, 'claude'),
                ),
              ),
          ),
          visibilityCondition,
          scopeCondition,
        ),
      )
      .orderBy(sessions.id);
  }

  private buildScopeCondition(scope: ExportImportScope, filters: ScopeFilters) {
    if (scope === 'dateRange') {
      if (!filters.from || !filters.to) {
        throw new BadRequestException(
          'from and to are required for the dateRange scope',
        );
      }
      // Overlap test: the session's artisyn log window intersects [from, to].
      return and(
        lte(logs.startTime, new Date(filters.to)),
        gte(logs.endTime, new Date(filters.from)),
      );
    }
    if (scope === 'sessionIds') {
      if (!filters.sessionIds || filters.sessionIds.length === 0) {
        throw new BadRequestException(
          'sessionIds is required for the sessionIds scope',
        );
      }
      return inArray(sessions.sessionId, filters.sessionIds);
    }
    return undefined;
  }
}
