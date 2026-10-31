/**
 * Session OTEL KPIs computed on the client (2026-10-30 otel-tabs-traces, Visual/UX notes): turns,
 * running turns, sub-agents, models and waiting from the assembled turns and the calls, and the
 * live highlight of the KPI tiles whose value changed with the latest poll.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  OtelCallRow,
  OtelSessionKpis,
} from '../../../../../models/repositories';
import type { OtelSessionDerivedKpis } from '../../otel/OtelKpiTiles';
import { OTEL_HIGHLIGHT_MS } from '../../otel/otel.constants';
import type { OtelTurn } from './otel-trace-assembly';

export function otelSessionDerivedKpis(
  turns: readonly OtelTurn[],
  calls: readonly OtelCallRow[],
): OtelSessionDerivedKpis {
  const agents = new Set<string>();
  const models = new Set<string>();
  for (const c of calls) {
    if (c.agentId !== null) agents.add(c.agentId);
    if (c.model !== null) models.add(c.model);
  }
  const interactionTurns = turns.filter((t) => !t.standaloneOnly);
  return {
    turns: interactionTurns.length,
    runningTurns: interactionTurns.filter((t) => t.inProgress).length,
    subagents: agents.size,
    modelCount: models.size,
    waitingMs: turns.reduce((sum, t) => sum + t.header.waitingMs, 0),
  };
}

/** The tile ids of `OtelSessionKpiTiles` and the value each one shows. */
function tileValues(
  kpis: OtelSessionKpis,
  derived: OtelSessionDerivedKpis,
): Record<string, string | number> {
  return {
    total: kpis.totalCostUsdMicros,
    hidden: kpis.hiddenCostUsdMicros,
    apiCalls: kpis.apiCalls,
    turns: derived.turns,
    subagents: derived.subagents,
    waiting: derived.waitingMs,
  };
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Tile ids whose value changed since the previous KPIs; empty again after `OTEL_HIGHLIGHT_MS`.
 * The first KPIs (a snapshot) highlight nothing.
 */
export function useOtelKpiHighlight(
  kpis: OtelSessionKpis | null,
  derived: OtelSessionDerivedKpis,
): ReadonlySet<string> {
  const prevRef = useRef<Record<string, string | number> | null>(null);
  const [changed, setChanged] = useState<ReadonlySet<string>>(NONE);

  useEffect(() => {
    if (kpis === null) {
      // A reset (another session, a new snapshot): the next KPIs are a fresh baseline.
      prevRef.current = null;
      return;
    }
    const next = tileValues(kpis, derived);
    const prev = prevRef.current;
    prevRef.current = next;
    if (prev === null) return;
    const ids = Object.keys(next).filter((k) => prev[k] !== next[k]);
    if (ids.length > 0) setChanged(new Set(ids));
  }, [kpis, derived]);

  useEffect(() => {
    if (changed === NONE) return;
    const t = window.setTimeout(() => setChanged(NONE), OTEL_HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [changed]);

  return changed;
}
