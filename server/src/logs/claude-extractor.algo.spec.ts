/**
 * Table test for docs/knowledgebase/algorithms/work-time.md: each row's event list becomes a
 * transcript and runs through `extractClaudeStats`, the real entry point of `computeWorkTime`.
 * Rows marked `"only": "hook"` pin the hook twin's side of a difference and are skipped here.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { extractClaudeStats } from './claude-extractor';

interface WorkTimeEvent {
  user?: string | number;
  assistant?: true;
  t: number;
  ts?: unknown;
  meta?: unknown;
  subagentResult?: true;
  agentId?: unknown;
  text?: string;
  content?: unknown;
  sidechain?: unknown;
  noMessage?: true;
  rawMessage?: unknown;
  toolUseResult?: unknown;
}

const START_MS = Date.parse('2026-10-01T10:00:00.000Z');

/** One transcript line per doc event, shaped like a Claude Code `.jsonl` record. */
function toLine(event: WorkTimeEvent, index: number): object {
  const timestamp =
    'ts' in event
      ? event.ts
      : new Date(START_MS + event.t * 1000).toISOString();
  if (event.assistant) {
    return {
      type: 'assistant',
      uuid: `a-${index}`,
      timestamp,
      isSidechain: 'sidechain' in event ? event.sidechain : false,
      message: { id: `msg-${index}`, model: 'claude-opus-5', content: [] },
    };
  }
  const subagent =
    'toolUseResult' in event
      ? { toolUseResult: event.toolUseResult }
      : 'agentId' in event || event.subagentResult
        ? {
            toolUseResult: {
              agentId: 'agentId' in event ? event.agentId : 'agent-1',
            },
          }
        : {};
  return {
    type: 'user',
    uuid: `u-${index}`,
    timestamp,
    promptId: event.user,
    isSidechain: 'sidechain' in event ? event.sidechain : false,
    ...('meta' in event ? { isMeta: event.meta } : {}),
    ...subagent,
    ...(event.noMessage
      ? {}
      : 'rawMessage' in event
        ? { message: event.rawMessage }
        : {
            message: {
              role: 'user',
              content:
                'content' in event
                  ? event.content
                  : (event.text ?? 'do the task'),
            },
          }),
  };
}

const rows = loadExamples<
  { events: WorkTimeEvent[]; subagentLog?: boolean },
  { workTimeMs: number }
>('work-time').filter((row) => row.only !== 'hook');

it.each(rows)('$id', ({ input, expected }) => {
  const stats = extractClaudeStats(
    input.events.map(toLine),
    '',
    input.subagentLog === true,
  );
  expect({ workTimeMs: stats.workTimeMs }).toEqual(expected);
});
