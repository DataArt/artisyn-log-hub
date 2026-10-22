/**
 * Table test for docs/knowledgebase/algorithms/tool-call-sections.md.
 *
 * Each row's calls become a log — one assistant line with a `tool_use` block per call and, when
 * `endTs` is given, a user line with its `tool_result` — and its permission events become artisyn
 * lines. The test runs the real pipeline: `extractRawToolCalls` → `buildToolResultIndex` →
 * `buildAllToolCalls`, then `extractPermissionEvents` → `attributePermissionEvents`.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  attributePermissionEvents,
  buildAllToolCalls,
  buildToolResultIndex,
  extractPermissionEvents,
  extractRawToolCalls,
} from './tool-calls';
import type {
  AssistantEvent,
  TelemetryEvent,
  ToolSection,
  UserEvent,
} from './types';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface CallRow {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ts: number;
  endTs?: number;
}

interface PermRow {
  kind: 'request' | 'denied';
  tool_name: string;
  /** Absent = no `tool_input` key on the line (same as `null`). */
  tool_input?: unknown;
  ts: number;
  /** `null` / `''` model what the hook writes when the payload has no id; a number is malformed. */
  tool_use_id?: string | number | null;
}

type Flag = 'requested' | 'denied';

interface SectionsExpected {
  sections: Record<string, ToolSection>;
  flags: Record<string, Flag[]>;
  unattributed: number;
}

const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');
const at = (ms: number): string => new Date(BASE_MS + ms).toISOString();

const rows = loader.loadExamples<
  { calls: CallRow[]; perms?: PermRow[] },
  SectionsExpected
>('tool-call-sections');

function toEvents(calls: CallRow[], perms: PermRow[]): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  calls.forEach((call, i) => {
    const assistant: AssistantEvent = {
      type: 'assistant',
      uuid: `a-${i}`,
      timestamp: at(call.ts),
      message: {
        content: [
          { type: 'tool_use', id: call.id, name: call.name, input: call.input },
        ],
      },
    };
    events.push(assistant);
    if (call.endTs !== undefined) {
      const result: UserEvent = {
        type: 'user',
        uuid: `u-${i}`,
        timestamp: at(call.endTs),
        message: {
          content: [
            { type: 'tool_result', tool_use_id: call.id, content: 'ok' },
          ],
        },
      };
      events.push(result);
    }
  });
  perms.forEach((perm, i) => {
    const artisyn = {
      type: 'artisyn',
      uuid: `p-${i}`,
      hook_event_name:
        perm.kind === 'request' ? 'PermissionRequest' : 'PermissionDenied',
      tool_name: perm.tool_name,
      ...('tool_input' in perm ? { tool_input: perm.tool_input } : {}),
      timestamp: at(perm.ts),
      ...(perm.tool_use_id !== undefined
        ? { tool_use_id: perm.tool_use_id }
        : {}),
    };
    events.push(artisyn);
  });
  return events;
}

it.each(rows)('$id', ({ input, expected }) => {
  const events = toEvents(input.calls, input.perms ?? []);
  const calls = buildAllToolCalls(
    extractRawToolCalls(events),
    buildToolResultIndex(events),
  );
  const { unattributed } = attributePermissionEvents(
    extractPermissionEvents(events),
    calls,
  );

  const sections: Record<string, ToolSection> = {};
  const flags: Record<string, Flag[]> = {};
  for (const call of calls) {
    const id = call.id ?? '';
    sections[id] = call.section;
    const set: Flag[] = [];
    if (call.permissionRequested) set.push('requested');
    if (call.permissionDenied) set.push('denied');
    if (set.length > 0) flags[id] = set;
  }
  expect({ sections, flags, unattributed }).toEqual(expected);
});
