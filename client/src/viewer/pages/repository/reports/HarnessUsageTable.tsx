import { useMemo, useState } from 'react';
import { ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import type { HarnessUsageRow } from '../../../../models/harness-usage';
import {
  buildHarnessDisplayRows,
  buildHarnessKindChips,
  filterProjectSkillsOnly,
  formatHarnessCount,
  formatHarnessMcpCell,
  formatHarnessPercent,
  formatSchemaSize,
  formatSeenCaption,
  HARNESS_KIND_BADGE_CLASSNAMES,
  HARNESS_KIND_LABELS,
  type HarnessKindFilter,
  type HarnessSortKey,
} from './harness-usage-rows';

interface Props {
  rows: HarnessUsageRow[];
  /** Group header, e.g. a branch or user name — omitted for the ungrouped table. */
  title?: string;
}

interface ColumnDef {
  label: string;
  key?: HarnessSortKey;
  align: 'left' | 'right';
}

const COLUMNS: ColumnDef[] = [
  { label: 'Kind', key: 'kind', align: 'left' },
  { label: 'Element', key: 'name', align: 'left' },
  { label: 'Schema', align: 'right' },
  { label: 'Uses', key: 'uses', align: 'right' },
  { label: 'Input tokens', key: 'inputTokens', align: 'right' },
  { label: 'Output tokens', key: 'outputTokens', align: 'right' },
  { label: 'Uses %', key: 'countPct', align: 'right' },
  { label: 'Tokens %', key: 'tokenPct', align: 'right' },
];

// One sortable/filterable harness-usage table — the ungrouped report renders exactly one of
// these, a grouped report renders one per group, each with fully independent local
// sort/filter/expand state.
export function HarnessUsageTable({ rows, title }: Props) {
  const [kindFilter, setKindFilter] = useState<HarnessKindFilter>('all');
  const [sortKey, setSortKey] = useState<HarnessSortKey>('uses');
  const [sortDesc, setSortDesc] = useState(true);
  // MCP servers start expanded — the point of the folder metaphor is to show the tool
  // breakdown by default, not hide it behind an extra click.
  const [expandedServers, setExpandedServers] = useState<ReadonlySet<string>>(
    () => new Set(rows.filter((r) => r.kind === 'mcp').map((r) => r.name)),
  );
  const [projectSkillsOnly, setProjectSkillsOnly] = useState(false);

  const visibleRows = useMemo(
    () => filterProjectSkillsOnly(rows, projectSkillsOnly),
    [rows, projectSkillsOnly],
  );
  const chips = useMemo(
    () => buildHarnessKindChips(visibleRows),
    [visibleRows],
  );
  const displayRows = useMemo(
    () =>
      buildHarnessDisplayRows(
        visibleRows,
        kindFilter,
        sortKey,
        sortDesc,
        expandedServers,
      ),
    [visibleRows, kindFilter, sortKey, sortDesc, expandedServers],
  );

  function handleSort(key: HarnessSortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  function toggleExpanded(server: string) {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(server)) next.delete(server);
      else next.add(server);
      return next;
    });
  }

  return (
    <section className="mb-6">
      {title && (
        <h2 className="mb-1 text-sm font-semibold text-foreground">{title}</h2>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Filter by kind
        </span>
        {chips.map((chip) => (
          <button
            key={chip.kind}
            onClick={() => setKindFilter(chip.kind)}
            className={
              chip.kind === kindFilter
                ? 'rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground'
                : 'rounded-full border border-border px-2.5 py-1 text-xs text-foreground hover:bg-accent/50'
            }
          >
            {chip.label} {chip.count}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-xs text-foreground">
          <input
            type="checkbox"
            checked={projectSkillsOnly}
            onChange={(e) => setProjectSkillsOnly(e.target.checked)}
            className="size-3.5 rounded border-border"
          />
          Project skills only
        </label>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.label}
                  onClick={col.key ? () => handleSort(col.key!) : undefined}
                  className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground ${
                    col.align === 'right' ? 'text-right' : 'text-left'
                  } ${col.key ? 'cursor-pointer select-none hover:text-foreground' : ''}`}
                >
                  <span
                    className={`inline-flex items-center gap-1 ${
                      col.align === 'right' ? 'justify-end' : ''
                    }`}
                  >
                    {col.label}
                    {col.key && sortKey === col.key && (
                      <ArrowUpDown className="size-3" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No elements match this filter.
                </td>
              </tr>
            ) : (
              displayRows.map(({ row, depth, expandable, expanded }) => {
                const caption = row.removed ? formatSeenCaption(row) : null;
                const zeroUse = row.uses === 0;
                return (
                  <tr
                    key={`${row.kind}\0${row.mcpServer ?? ''}\0${row.name}`}
                    className={`border-t border-border ${zeroUse ? 'bg-muted/20' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${HARNESS_KIND_BADGE_CLASSNAMES[row.kind]}`}
                      >
                        {HARNESS_KIND_LABELS[row.kind]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div
                        className="flex items-center gap-1.5"
                        style={depth === 1 ? { paddingLeft: 16 } : undefined}
                      >
                        {depth === 1 && (
                          <span className="text-muted-foreground">↳</span>
                        )}
                        {expandable && (
                          <button
                            onClick={() => toggleExpanded(row.name)}
                            aria-label={expanded ? 'Collapse' : 'Expand'}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {expanded ? (
                              <ChevronDown className="size-3.5" />
                            ) : (
                              <ChevronRight className="size-3.5" />
                            )}
                          </button>
                        )}
                        <span
                          className={`font-mono ${
                            row.removed
                              ? 'text-muted-foreground line-through'
                              : zeroUse
                                ? 'text-muted-foreground'
                                : ''
                          }`}
                        >
                          {row.name}
                        </span>
                        {row.removed && (
                          <span className="inline-flex rounded border border-orange-300 bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold text-orange-700 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-300">
                            REMOVED
                          </span>
                        )}
                        {row.kind === 'mcp' && row.mcpConnected === false && (
                          <span className="inline-flex rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            disconnected
                          </span>
                        )}
                        {zeroUse && !row.removed && (
                          <span className="inline-flex rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                            0 uses
                          </span>
                        )}
                      </div>
                      {caption && (
                        <p className="mt-0.5 text-[11px] italic text-muted-foreground">
                          {caption}
                        </p>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 text-right font-mono text-muted-foreground"
                      title={
                        row.schemaSizeReported
                          ? undefined
                          : 'Not reported by this hook version'
                      }
                    >
                      {formatSchemaSize(row)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {formatHarnessMcpCell(row, formatHarnessCount(row.uses))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {formatHarnessMcpCell(
                        row,
                        formatHarnessCount(row.inputTokens),
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {formatHarnessMcpCell(
                        row,
                        formatHarnessCount(row.outputTokens),
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {formatHarnessMcpCell(
                        row,
                        formatHarnessPercent(row.countPct),
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {formatHarnessMcpCell(
                        row,
                        formatHarnessPercent(row.tokenPct),
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
