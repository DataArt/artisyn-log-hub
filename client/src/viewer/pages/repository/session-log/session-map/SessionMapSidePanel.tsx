/**
 * Session Map side panel (session-map DD-20): metric rows of the selected card (main, a workflow
 * column or an agent), the family / failed chips, and the call log up to the time position.
 * Clicking a log row moves the time position to the call; `⤢` opens `ToolCallDetailModal` with the
 * props `SubAgentDetail` passes.
 */
import { Maximize2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ModelPricingMap } from '../../../../../models/pricing';
import { formatDuration, formatTokens } from '../../../../lib/format';
import { resolveCharsPerToken, stripAgentPrefix } from '../log-parser';
import { ToolCallDetailModal } from '../ToolCallDetailModal';
import type {
  FileAccess,
  ParsedSession,
  SubAgentNode,
  ToolCallDetail,
} from '../types';
import type { MapCallEvent, SessionMapModel } from './session-map-model';
import {
  FAILED_COLOR,
  FAMILIES,
  PANEL_W,
  type ToolFamilyId,
} from './session-map.constants';
import {
  formatClockSeconds,
  formatMapUsd,
  formatShare,
} from './session-map-format';

/** Rows of the call log rendered at most (the newest are kept). */
const CALL_LOG_LIMIT = 500;

type Chip = 'all' | 'failed' | ToolFamilyId;

interface PanelSubject {
  title: string;
  model: string | null;
  rows: [string, string][];
  events: MapCallEvent[];
}

function eventsUpTo(
  events: readonly MapCallEvent[],
  t: number,
): MapCallEvent[] {
  return events
    .filter((e) => e.t === null || e.t <= t)
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

/** Resolves `smSel` to what the panel shows; `null` for an unknown node. */
function resolveSubject(
  model: SessionMapModel,
  selectedId: string,
): PanelSubject | null {
  if (selectedId.startsWith('group:')) {
    const key = selectedId.slice('group:'.length);
    const col = model.columns.find((c) => c.key === key);
    if (!col) return null;
    const events: MapCallEvent[] = [];
    let agents = 0;
    const walk = (n: (typeof col.roots)[number]): void => {
      agents++;
      events.push(...n.events);
      n.children.forEach(walk);
    };
    col.roots.forEach(walk);
    return {
      title: col.label,
      model: null,
      events,
      rows: [
        ['Cost', formatMapUsd(col.cost)],
        ['Agents', String(agents)],
        ['Calls', String(col.calls)],
        ['Failed', String(col.failures)],
        [
          'Duration',
          col.kind === 'workflow' && col.startMs !== null && col.endMs !== null
            ? formatDuration(col.endMs - col.startMs)
            : '–',
        ],
      ],
    };
  }
  const node =
    selectedId === 'main' ? model.main : model.agentsById.get(selectedId);
  if (!node) return null;
  return {
    title: node.label,
    model: node.model,
    events: node.events,
    rows: [
      ['Model', node.model ?? 'unknown'],
      ['Cost', `${formatMapUsd(node.cost)} (${formatShare(node.share)})`],
      ['Calls', String(node.calls)],
      ['Failed', String(node.failures)],
      [
        'Peak context',
        node.peakContext !== null && node.contextLength
          ? `${formatTokens(node.peakContext)} / ${formatTokens(node.contextLength)}`
          : 'n/a',
      ],
      [
        'Duration',
        node.f !== null && node.l !== null
          ? formatDuration(node.l - node.f)
          : '–',
      ],
      ['Started', node.f !== null ? formatClockSeconds(node.f) : '–'],
    ],
  };
}

/** `agentId` (no `agent-` prefix) → its parsed sub-agent node, across the whole turn tree. */
function indexSubAgents(
  parsed: ParsedSession | null,
): Map<string, SubAgentNode> {
  const out = new Map<string, SubAgentNode>();
  const walk = (n: SubAgentNode): void => {
    out.set(stripAgentPrefix(n.agentId), n);
    n.children.forEach(walk);
  };
  for (const turn of parsed?.turns ?? []) turn.subAgents.forEach(walk);
  return out;
}

interface ModalContext {
  turnFiles?: FileAccess[];
  subAgents?: SubAgentNode[];
}

export interface SessionMapSidePanelProps {
  model: SessionMapModel;
  selectedId: string;
  t: number;
  parsed: ParsedSession | null;
  pricing: ModelPricingMap | undefined;
  onSetT: (t: number) => void;
  onClose: () => void;
}

export function SessionMapSidePanel({
  model,
  selectedId,
  t,
  parsed,
  pricing,
  onSetT,
  onClose,
}: SessionMapSidePanelProps) {
  const [chip, setChip] = useState<Chip>('all');
  const [openCall, setOpenCall] = useState<ToolCallDetail | null>(null);
  const subject = useMemo(
    () => resolveSubject(model, selectedId),
    [model, selectedId],
  );
  const subAgentIndex = useMemo(() => indexSubAgents(parsed), [parsed]);

  if (subject === null) return null;

  const visible = eventsUpTo(subject.events, t);
  const families = FAMILIES.filter((f) =>
    subject.events.some((e) => e.family === f.id),
  );
  const chips: { id: Chip; label: string; color?: string }[] = [
    { id: 'all', label: 'all' },
    ...families.map((f) => ({ id: f.id, label: f.label, color: f.color })),
    { id: 'failed', label: 'failed', color: FAILED_COLOR },
  ];
  const filtered = visible.filter((e) =>
    chip === 'all' ? true : chip === 'failed' ? e.failed : e.family === chip,
  );
  const shown = filtered.slice(-CALL_LOG_LIMIT);

  const modalContext = (call: ToolCallDetail): ModalContext => {
    if (selectedId === 'main' || selectedId.startsWith('group:')) {
      const turn = parsed?.turns.find((tr) =>
        tr.allToolCalls.some((c) => c.id !== undefined && c.id === call.id),
      );
      if (turn) return { turnFiles: turn.files, subAgents: turn.subAgents };
      return {};
    }
    const agent = subAgentIndex.get(selectedId);
    return agent ? { turnFiles: agent.files, subAgents: agent.children } : {};
  };

  return (
    <aside
      data-testid="session-map-panel"
      className="flex shrink-0 flex-col gap-3 self-start rounded-lg border bg-white p-3 text-xs shadow-sm"
      style={{ width: PANEL_W }}
    >
      <div className="flex items-start gap-2">
        <h3
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          title={subject.title}
        >
          {subject.title}
        </h3>
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:bg-slate-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {subject.rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate font-mono" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            data-testid={`session-map-chip-${c.id}`}
            aria-pressed={chip === c.id}
            onClick={() => setChip(c.id)}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${chip === c.id ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
          >
            {c.color && (
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: c.color }}
              />
            )}
            {c.label}
          </button>
        ))}
      </div>
      <div className="text-muted-foreground">
        {filtered.length} of {subject.events.length} calls up to the time
        position
        {filtered.length > CALL_LOG_LIMIT &&
          ` (latest ${CALL_LOG_LIMIT} shown)`}
      </div>
      <ul className="flex max-h-[50vh] flex-col overflow-y-auto">
        {shown.map((e, i) => (
          <li
            key={e.toolUseId ?? `i${i}`}
            data-testid="session-map-call"
            data-tool-use-id={e.toolUseId}
            className="flex items-center gap-2 border-b border-slate-100 py-0.5"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left hover:bg-slate-50"
              onClick={() => {
                if (e.t !== null) onSetT(e.t);
              }}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: e.failed
                    ? FAILED_COLOR
                    : (FAMILIES.find((f) => f.id === e.family)?.color ??
                      '#94a3b8'),
                }}
              />
              <span className="w-16 shrink-0 font-mono text-muted-foreground">
                {e.t !== null ? formatClockSeconds(e.t) : '–'}
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${e.failed ? 'text-red-600' : ''}`}
                title={e.name}
              >
                {e.name}
              </span>
            </button>
            <button
              type="button"
              data-testid="session-map-call-open"
              aria-label="Open call"
              title="Open call"
              onClick={() => setOpenCall(e.call)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-slate-100"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="py-1 text-muted-foreground">No calls yet</li>
        )}
      </ul>
      {openCall !== null && (
        <ToolCallDetailModal
          call={openCall}
          onClose={() => setOpenCall(null)}
          charsPerToken={resolveCharsPerToken(pricing, subject.model)}
          {...modalContext(openCall)}
        />
      )}
    </aside>
  );
}
