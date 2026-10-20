/**
 * On-page pieces of AttributionUsageReport.tsx split out to keep that file under the
 * component-size guidance (`.claude/rules/client.md`): the outcome-toggle control and the two
 * plain HTML tables (outcome breakdown, top re-evaluated sessions).
 */
import type {
  AttributionUsageOutcomeRow,
  AttributionUsageTopSession,
  SessionAttributionRunOutcome,
} from '../../../../models/repositories';
import {
  ATTRIBUTION_USAGE_OUTCOME_COLUMNS,
  ATTRIBUTION_USAGE_OUTCOMES,
  ATTRIBUTION_USAGE_OUTCOME_LABELS,
  ATTRIBUTION_USAGE_TOP_COLUMNS,
  buildAttributionUsageOutcomeRow,
  buildAttributionUsageTopRow,
} from './attribution-usage-rows';

interface ToggleProps {
  selectedOutcomes: Set<SessionAttributionRunOutcome>;
  onToggle: (outcome: SessionAttributionRunOutcome) => void;
  onClear: () => void;
}

// Presentation-only outcome narrowing — not URL-synced (same precedent as
// HarnessUsageTable's kind filter chips).
export function AttributionUsageOutcomeToggle({
  selectedOutcomes,
  onToggle,
  onClear,
}: ToggleProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Outcome
      </span>
      {ATTRIBUTION_USAGE_OUTCOMES.map((outcome) => (
        <button
          key={outcome}
          onClick={() => onToggle(outcome)}
          className={`rounded-full border px-2.5 py-1 text-xs ${
            selectedOutcomes.has(outcome)
              ? 'border-primary bg-primary/10 font-semibold text-primary'
              : 'border-input text-muted-foreground hover:bg-accent/50'
          }`}
        >
          {ATTRIBUTION_USAGE_OUTCOME_LABELS[outcome]}
        </button>
      ))}
      {selectedOutcomes.size > 0 && (
        <button
          onClick={onClear}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function columnClassName(i: number, alignedClassName: string): string {
  return `px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground ${
    i === 0 ? 'text-left' : alignedClassName
  }`;
}

export function AttributionUsageOutcomeTable({
  rows,
}: {
  rows: AttributionUsageOutcomeRow[];
}) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-foreground">
        Outcome breakdown
      </h2>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              {ATTRIBUTION_USAGE_OUTCOME_COLUMNS.map((col, i) => (
                <th key={col} className={columnClassName(i, 'text-right')}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.outcome} className="border-t border-border">
                {buildAttributionUsageOutcomeRow(row).map((cell, i) => (
                  <td
                    key={i}
                    className={i === 0 ? 'px-3 py-2' : 'px-3 py-2 text-right'}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AttributionUsageTopSessionsTable({
  rows,
}: {
  rows: AttributionUsageTopSession[];
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-foreground">
        Most re-evaluated sessions
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Top 10 by evaluation count, ties broken by cost
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No evaluations in scope</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                {ATTRIBUTION_USAGE_TOP_COLUMNS.map((col, i) => (
                  <th key={col} className={columnClassName(i, 'text-right')}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sessionId} className="border-t border-border">
                  {buildAttributionUsageTopRow(row).map((cell, i) => (
                    <td
                      key={i}
                      className={
                        i === 0 ? 'px-3 py-2 font-mono' : 'px-3 py-2 text-right'
                      }
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
