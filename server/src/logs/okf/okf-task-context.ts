/**
 * OKF usage — task context filter (FR-20; impl-plan DD-28, DD-41).
 *
 * Turns user-role transcript traffic into the user's actual task text: drops system traffic
 * (task notifications, local command output, bash output, system reminders), CLI utility slash
 * commands (`<command-name>` first, e.g. `/clear`) and meta / tool-result entries; keeps a real
 * slash command (`<command-message>` first) as `/<name> <args>`. The slash-command shape rule is the
 * one `docs/knowledgebase/harness-usage-tab.md` documents (whichever tag comes first decides).
 * Pinned by `docs/knowledgebase/algorithms/okf-task-context.md`. Pure: no DB, no I/O.
 */

/** A prompt starting with one of these is system traffic, not the task. */
const DROPPED_PREFIXES = [
  '<task-notification>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<bash-stdout>',
  '<system-reminder>',
] as const;

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/**
 * `<pasted_content …>` / `</pasted_content>` wrapper tags (the inner text is kept). The opening
 * tag may carry attributes or be cut off at the very end of a truncated prompt.
 */
const PASTED_CONTENT_TAG_RE =
  /<pasted_content\b[^>]*(?:>|$)|<\/pasted_content>/g;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Replaces system-reminder blocks and pasted-content wrapper tags by a space. */
function stripMarkup(text: string): string {
  return text
    .replace(SYSTEM_REMINDER_RE, ' ')
    .replace(PASTED_CONTENT_TAG_RE, ' ');
}

/**
 * Cleans one user prompt (DD-41). Returns the task text, or `null` when the prompt is dropped
 * (system traffic, a CLI utility command, or nothing left after cleaning).
 */
export function cleanTaskText(raw: string): string | null {
  const trimmed = raw.trimStart();
  if (DROPPED_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  // `<command-name>` first = CLI utility (`/clear`, `/model`, ...) — not a task.
  if (trimmed.startsWith('<command-name>')) return null;

  if (trimmed.startsWith('<command-message>')) {
    const name = collapseWhitespace(
      COMMAND_NAME_RE.exec(trimmed)?.[1] ?? '',
    ).replace(/^\/+/, '');
    if (name === '') return null;
    const args = collapseWhitespace(
      stripMarkup(COMMAND_ARGS_RE.exec(trimmed)?.[1] ?? ''),
    );
    return args === '' ? `/${name}` : `/${name} ${args}`;
  }

  const text = collapseWhitespace(stripMarkup(raw));
  return text === '' ? null : text;
}

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as AnyRecord)
    : null;
}

export interface FilterUserPromptsOptions {
  /**
   * `true` for a `claude-subagent` log, whose every line is a sidechain line. In a root log,
   * `isSidechain` lines belong to a sub-agent and are skipped.
   */
  isSubagentLog?: boolean;
}

/**
 * The user's prompts of one transcript, in order (DD-41): string-content `user` entries that are
 * not tool results and not `isMeta`, each through {@link cleanTaskText}; dropped ones are omitted.
 */
export function filterUserPrompts(
  entries: readonly unknown[],
  options: FilterUserPromptsOptions = {},
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const rec = asRecord(entry);
    if (rec === null || rec['type'] !== 'user') continue;
    if (rec['isMeta'] === true) continue;
    if (!options.isSubagentLog && rec['isSidechain'] === true) continue;
    if (rec['toolUseResult'] !== undefined && rec['toolUseResult'] !== null)
      continue;
    const content = asRecord(rec['message'])?.['content'];
    if (typeof content !== 'string') continue;
    const cleaned = cleanTaskText(content);
    if (cleaned !== null) out.push(cleaned);
  }
  return out;
}
