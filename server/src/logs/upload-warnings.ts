/**
 * User-facing message texts shared between producers and their tests.
 *
 * - Hook-facing warning texts returned in the `warnings` array of `POST /api/v2/logs`,
 *   shared by the v2 controller (synchronous pre-check), the queue worker
 *   (`rejected_foreign_session` rows) and the tests.
 * - Zip-import conflict texts and types, shared by the import service (pre-check and
 *   job write path), the import controller (409 body) and the tests.
 *
 * Kept in one module so every producer uses the exact same wording.
 */

/**
 * Upload rejected because the session already belongs to another user
 * (open-source readiness). Nothing from the upload was stored.
 */
export const FOREIGN_SESSION_WARNING = (sessionId: string): string =>
  `Upload for session ${sessionId} was rejected: the session belongs to another user. The data was not stored.`;

/**
 * Why one archived session blocks a zip import:
 * - `foreign-session` — the session exists (not deleted) and has data of another user;
 * - `foreign-author` — a log author email belongs to another registered user;
 * - `foreign-parent` — the parent session (deleted or not) has data of another user.
 */
export type ImportConflictReason =
  | 'foreign-session'
  | 'foreign-author'
  | 'foreign-parent';

/** One `(sessionId, reason)` pair reported in the 409 `conflicts` array. */
export type ImportConflict = {
  sessionId: string;
  reason: ImportConflictReason;
};

/** How many distinct session ids `importConflictMessage` lists before "and N more". */
export const IMPORT_CONFLICT_MESSAGE_MAX_IDS = 5;

/**
 * Message of a blocked import. Counts and lists distinct session ids only — the reasons
 * travel in `conflicts`, and owners or emails are never included.
 */
export const importConflictMessage = (conflicts: ImportConflict[]): string => {
  const ids = [...new Set(conflicts.map((c) => c.sessionId))];
  const n = ids.length;
  const shown = ids.slice(0, IMPORT_CONFLICT_MESSAGE_MAX_IDS).join(', ');
  const more =
    n > IMPORT_CONFLICT_MESSAGE_MAX_IDS
      ? ` and ${n - IMPORT_CONFLICT_MESSAGE_MAX_IDS} more`
      : '';
  return `Import blocked: ${n} session(s) in this archive conflict with another user's data: ${shown}${more}. Nothing was imported.`;
};

/**
 * Job error when a session became foreign between the pre-check and the write.
 * Sessions written before it stay.
 */
export const importConflictRaceMessage = (sessionId: string): string =>
  `Import stopped: session ${sessionId} now belongs to another user. Sessions imported before it were kept.`;
