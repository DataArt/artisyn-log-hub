import {
  TRANSCRIPT_QUERY_SOURCE_PREFIX,
  TRANSCRIPT_QUERY_SOURCES,
} from '../otel-cost.sql';

/**
 * The `query_source` dictionary (DD-21, FR-17): what each Claude Code `query_source` is and
 * whether its calls are hidden (never recorded in a transcript). A code constant — a new Claude
 * Code source shows up under its raw name with `known: false` (the UI's "new" chip) until it is
 * added here.
 *
 * Invariant (asserted by an `otel-facts.md` row): the visible names equal
 * `TRANSCRIPT_QUERY_SOURCES`, so the dictionary and the `utilityCostsCte` fallback agree. The
 * `agent:<name>` sub-agent threads are matched by prefix and are visible.
 */
export interface OtelQuerySourceEntry {
  name: string;
  description: string;
  hidden: boolean;
}

export const OTEL_QUERY_SOURCE_DICTIONARY: readonly OtelQuerySourceEntry[] = [
  {
    name: 'repl_main_thread',
    description: 'Main conversation thread (interactive)',
    hidden: false,
  },
  {
    name: 'sdk',
    description: 'claude -p main thread',
    hidden: false,
  },
  {
    name: 'prompt_suggestion',
    description:
      'Grey "next prompt" suggestion after each answer — sends the session context to the session model',
    hidden: true,
  },
  {
    name: 'agent_summary',
    description:
      'Background agent status line (3–5 words), re-sends the agent transcript every ~30 s',
    hidden: true,
  },
  {
    name: 'generate_session_title',
    description: 'Session title generation',
    hidden: true,
  },
  {
    name: 'web_search_tool',
    description: 'WebSearch tool server call',
    hidden: true,
  },
  {
    name: 'web_fetch_apply',
    description: 'WebFetch: applies the prompt to the fetched page',
    hidden: true,
  },
  { name: 'compact', description: 'Conversation compaction', hidden: true },
  { name: 'side_question', description: '/btw side question', hidden: true },
  {
    name: 'hook_prompt',
    description: 'Prompt-type hook evaluation',
    hidden: true,
  },
  { name: 'hook_agent', description: 'Agent-type hook', hidden: true },
  {
    name: 'auto_mode',
    description: 'Auto mode permission classifier',
    hidden: true,
  },
  {
    name: 'extract_memories',
    description: 'Automatic memory extraction',
    hidden: true,
  },
  {
    name: 'away_summary',
    description: 'Summary of what happened while you were away',
    hidden: true,
  },
];

const BY_NAME = new Map(OTEL_QUERY_SOURCE_DICTIONARY.map((e) => [e.name, e]));

/** Names the dictionary marks visible — must equal `TRANSCRIPT_QUERY_SOURCES` (DD-21). */
export const OTEL_VISIBLE_QUERY_SOURCES: readonly string[] =
  OTEL_QUERY_SOURCE_DICTIONARY.filter((e) => !e.hidden).map((e) => e.name);

export interface OtelQuerySourceLookup {
  description: string | null;
  hidden: boolean;
  known: boolean;
}

/**
 * Look up one `query_source`. `agent:<name>` is a known, visible sub-agent thread. An unseen
 * name is `known: false` and `hidden` unless it is a transcript source — the same rule
 * `classifyOtelCall`'s fallback applies.
 */
export function lookupQuerySource(name: string): OtelQuerySourceLookup {
  const entry = BY_NAME.get(name);
  if (entry) {
    return {
      description: entry.description,
      hidden: entry.hidden,
      known: true,
    };
  }
  if (name.startsWith(TRANSCRIPT_QUERY_SOURCE_PREFIX)) {
    return {
      description: `Sub-agent thread (${name.slice(TRANSCRIPT_QUERY_SOURCE_PREFIX.length)})`,
      hidden: false,
      known: true,
    };
  }
  return {
    description: null,
    hidden: !TRANSCRIPT_QUERY_SOURCES.includes(name),
    known: false,
  };
}
