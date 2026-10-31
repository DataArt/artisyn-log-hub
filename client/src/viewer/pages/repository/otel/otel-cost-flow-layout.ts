/**
 * Pure layout of the "Cost flow" Sankey (2026-10-30 otel-tabs-traces, DD-28 / DD-29).
 *
 * - Columns come from the `flows` rows: model → user → branch in a team context, model → branch
 *   in a private repository (the user column dropped and its rows merged), model → person →
 *   repository (· branch) on the team tab.
 * - A null value folds into "(unknown)"; the server's folded `other` row is "other" in every
 *   column.
 * - Nodes are sorted by cost, descending, per column; node height ∝ cost on one scale for all
 *   columns, `OTEL_FLOW_NODE_GAP` px between nodes; bands are at least 1 px and carry their
 *   source node's colour.
 * - `sessions` is shown only where it adds up: on a band whose ends include the model column
 *   (each session has one user, branch and repository, so rows of one model never share a
 *   session). Nodes show cost, share and calls only.
 */
import type { OtelFlowRow } from '../../../../models/repositories';
import { microsToUsd } from './otel-format';
import { OTEL_SERIES_PALETTE } from './otel-chart-data';

export type OtelFlowColumn =
  | 'model'
  | 'user'
  | 'branch'
  | 'repository'
  | 'repositoryBranch';

export const OTEL_FLOW_COLUMN_LABELS: Record<OtelFlowColumn, string> = {
  model: 'Model',
  user: 'User',
  branch: 'Branch (of the session)',
  repository: 'Repository',
  repositoryBranch: 'Repository · branch',
};

export const OTEL_FLOW_NODE_GAP = 12;
export const OTEL_FLOW_NODE_WIDTH = 10;

const UNKNOWN = '(unknown)';
const OTHER = 'other';

/** The columns of a context (DD-28). */
export function otelFlowColumns(teamContext: boolean): OtelFlowColumn[] {
  return teamContext ? ['model', 'user', 'branch'] : ['model', 'branch'];
}

export function otelFlowValue(row: OtelFlowRow, col: OtelFlowColumn): string {
  if (row.other) return OTHER;
  switch (col) {
    case 'model':
      return row.model ?? UNKNOWN;
    case 'user':
      return row.userEmail ?? UNKNOWN;
    case 'branch':
      return row.branch ?? UNKNOWN;
    case 'repository':
      return row.repository ?? UNKNOWN;
    case 'repositoryBranch':
      return `${row.repository ?? UNKNOWN} · ${row.branch ?? UNKNOWN}`;
  }
}

export interface OtelFlowNode {
  id: string;
  column: number;
  label: string;
  cost: number;
  calls: number;
  share: number;
  color: string;
  x: number;
  y: number;
  height: number;
}

export interface OtelFlowBand {
  id: string;
  source: OtelFlowNode;
  target: OtelFlowNode;
  cost: number;
  calls: number;
  /** Null where summing would count a session twice. */
  sessions: number | null;
  share: number;
  /** Top / bottom at the source and at the target. */
  sy0: number;
  sy1: number;
  ty0: number;
  ty1: number;
}

export interface OtelFlowLayout {
  columns: OtelFlowColumn[];
  nodes: OtelFlowNode[];
  bands: OtelFlowBand[];
  total: number;
  height: number;
}

export interface OtelFlowLayoutOptions {
  width: number;
  height: number;
  /** Space to the right of the last column for its labels. */
  labelWidth?: number;
}

export function layoutOtelCostFlow(
  rows: readonly OtelFlowRow[],
  columns: readonly OtelFlowColumn[],
  opts: OtelFlowLayoutOptions,
): OtelFlowLayout {
  const labelWidth = opts.labelWidth ?? 180;
  const costs = rows.map((r) => microsToUsd(r.costUsdMicros) ?? 0);
  const total = costs.reduce((a, b) => a + b, 0);

  // Nodes per column.
  const nodeMaps = columns.map(() => new Map<string, OtelFlowNode>());
  rows.forEach((row, ri) => {
    columns.forEach((col, ci) => {
      const label = otelFlowValue(row, col);
      const map = nodeMaps[ci];
      const node =
        map.get(label) ??
        ({
          id: `${ci}:${label}`,
          column: ci,
          label,
          cost: 0,
          calls: 0,
          share: 0,
          color: '',
          x: 0,
          y: 0,
          height: 0,
        } satisfies OtelFlowNode);
      node.cost += costs[ri];
      node.calls += row.calls;
      map.set(label, node);
    });
  });
  const cols = nodeMaps.map((m) =>
    [...m.values()].sort(
      (a, b) => b.cost - a.cost || a.label.localeCompare(b.label),
    ),
  );

  const maxNodes = Math.max(1, ...cols.map((c) => c.length));
  const usable = Math.max(
    40,
    opts.height - OTEL_FLOW_NODE_GAP * (maxNodes - 1),
  );
  const scale = total > 0 ? usable / total : 0;
  const span = Math.max(1, opts.width - labelWidth - OTEL_FLOW_NODE_WIDTH);
  const step = columns.length > 1 ? span / (columns.length - 1) : 0;
  let layoutHeight = 0;

  cols.forEach((col, ci) => {
    let y = 0;
    col.forEach((node, ni) => {
      node.x = ci * step;
      node.y = y;
      node.height = Math.max(1, node.cost * scale);
      node.share = total > 0 ? node.cost / total : 0;
      node.color = OTEL_SERIES_PALETTE[ni % OTEL_SERIES_PALETTE.length];
      y += node.height + OTEL_FLOW_NODE_GAP;
    });
    layoutHeight = Math.max(layoutHeight, y - OTEL_FLOW_NODE_GAP);
  });

  // Bands between consecutive columns.
  const bands: OtelFlowBand[] = [];
  for (let ci = 0; ci + 1 < columns.length; ci += 1) {
    const withModel = columns[ci] === 'model' || columns[ci + 1] === 'model';
    const agg = new Map<
      string,
      {
        s: OtelFlowNode;
        t: OtelFlowNode;
        cost: number;
        calls: number;
        sessions: number;
      }
    >();
    rows.forEach((row, ri) => {
      const s = nodeMaps[ci].get(otelFlowValue(row, columns[ci]));
      const t = nodeMaps[ci + 1].get(otelFlowValue(row, columns[ci + 1]));
      if (!s || !t) return;
      const key = `${s.id}→${t.id}`;
      const a = agg.get(key) ?? { s, t, cost: 0, calls: 0, sessions: 0 };
      a.cost += costs[ri];
      a.calls += row.calls;
      a.sessions += row.sessions;
      agg.set(key, a);
    });
    const list = [...agg.entries()];
    const sOrder = new Map(cols[ci].map((n, i) => [n.id, i]));
    const tOrder = new Map(cols[ci + 1].map((n, i) => [n.id, i]));
    const sOffset = new Map<string, number>();
    const tOffset = new Map<string, number>();
    // Outgoing bands stacked by target order, incoming by source order.
    const bySource = [...list].sort(
      ([, a], [, b]) =>
        (sOrder.get(a.s.id) ?? 0) - (sOrder.get(b.s.id) ?? 0) ||
        (tOrder.get(a.t.id) ?? 0) - (tOrder.get(b.t.id) ?? 0),
    );
    const placed = new Map<string, OtelFlowBand>();
    for (const [key, a] of bySource) {
      const h = Math.max(1, a.cost * scale);
      const so = sOffset.get(a.s.id) ?? 0;
      sOffset.set(a.s.id, so + h);
      placed.set(key, {
        id: key,
        source: a.s,
        target: a.t,
        cost: a.cost,
        calls: a.calls,
        sessions: withModel ? a.sessions : null,
        share: total > 0 ? a.cost / total : 0,
        sy0: a.s.y + so,
        sy1: a.s.y + so + h,
        ty0: 0,
        ty1: 0,
      });
    }
    const byTarget = [...placed.values()].sort(
      (a, b) =>
        (tOrder.get(a.target.id) ?? 0) - (tOrder.get(b.target.id) ?? 0) ||
        (sOrder.get(a.source.id) ?? 0) - (sOrder.get(b.source.id) ?? 0),
    );
    for (const band of byTarget) {
      const h = band.sy1 - band.sy0;
      const to = tOffset.get(band.target.id) ?? 0;
      tOffset.set(band.target.id, to + h);
      band.ty0 = band.target.y + to;
      band.ty1 = band.target.y + to + h;
      bands.push(band);
    }
  }

  return {
    columns: [...columns],
    nodes: cols.flat(),
    bands,
    total,
    height: Math.max(layoutHeight, 1),
  };
}

/** SVG path of a band: a ribbon from the source node's right edge to the target's left edge. */
export function otelFlowBandPath(b: OtelFlowBand): string {
  const x0 = b.source.x + OTEL_FLOW_NODE_WIDTH;
  const x1 = b.target.x;
  const mx = (x0 + x1) / 2;
  return [
    `M${x0},${b.sy0}`,
    `C${mx},${b.sy0} ${mx},${b.ty0} ${x1},${b.ty0}`,
    `L${x1},${b.ty1}`,
    `C${mx},${b.ty1} ${mx},${b.sy1} ${x0},${b.sy1}`,
    'Z',
  ].join(' ');
}
