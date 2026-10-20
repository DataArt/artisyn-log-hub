export interface ReportKpiRow {
  label: string;
  value: string;
  emphasize?: boolean;
  // Second value column. Only rendered when the
  // table itself is in two-column mode (`valueHeaders` given); existing
  // single-column reports pass neither and render exactly as before.
  secondValue?: string;
  // Renders the label indented with a "↳" marker on a violet band — used for
  // the 5m/1h TTL sub-rows under "Cache write tokens".
  indent?: boolean;
}

interface Props {
  rows: ReportKpiRow[];
  // Labels for the value column(s). Omitted → a single "Value" column (the
  // shape every single-value report uses). Providing a pair switches the table to
  // two value columns.
  valueHeaders?: [string, string];
}

// Shared on-page KPI summary table — every report document has one, per the
// "summary numbers in a table" requirement for printable reports.
export function ReportKpiTable({ rows, valueHeaders }: Props) {
  const twoColumn = valueHeaders != null;

  return (
    <table className="mb-6 w-full text-sm">
      <thead>
        <tr className="bg-muted/40">
          <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Metric
          </th>
          <th className="px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {valueHeaders ? valueHeaders[0] : 'Value'}
          </th>
          {twoColumn && (
            <th className="px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {valueHeaders[1]}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.label}
            className={
              row.indent
                ? 'border-t border-border/60 bg-violet-50'
                : 'border-t border-border/60'
            }
          >
            <td
              className={
                row.indent ? 'px-2 py-2 pl-6 text-indigo-700' : 'px-2 py-2'
              }
            >
              {row.indent ? `↳ ${row.label}` : row.label}
            </td>
            <td
              className={
                row.emphasize
                  ? 'px-2 py-2 text-right font-semibold text-green-700 dark:text-green-400'
                  : 'px-2 py-2 text-right font-semibold'
              }
            >
              {row.value}
            </td>
            {twoColumn && (
              <td
                className={
                  row.emphasize
                    ? 'px-2 py-2 text-right font-semibold text-green-700 dark:text-green-400'
                    : 'px-2 py-2 text-right font-semibold'
                }
              >
                {row.secondValue ?? '–'}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
