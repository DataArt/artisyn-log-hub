/**
 * Shared document shell for the four usage reports.
 *
 * All four have the same shape — a KPI table plus one or more string tables — so they share one
 * renderer instead of four near-identical files. Crucially the on-page tables and the PDF tables
 * are built from the *same* `sections` array, so a report and its export cannot drift.
 *
 * Each report file supplies only its query and its row builders (`usage-report-rows.ts`).
 */
import { Text, View } from '@react-pdf/renderer';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/table';
import { ReportDocumentHeader } from './ReportDocumentHeader';
import { ReportDocumentShell } from './ReportDocumentShell';
import { ReportKpiTable, type ReportKpiRow } from './ReportKpiTable';
import { useReportHeaderMeta } from './useReportHeaderMeta';
import { useReportPdfDownload } from './downloadReportPdf';
import { PdfDocumentShell } from './pdf/PdfDocumentShell';
import { TablePdf } from './pdf/TablePdf';
import { pdfStyles } from './pdf/pdfStyles';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import type { ReportParamsState } from './report-url';

export interface UsageReportSection {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: string[][];
  /** Shown under the table, on the page and in the PDF. */
  footnote?: string;
  /** Rendered in place of the table when `rows` is empty. */
  emptyLabel: string;
  /**
   * Optional per-row highlight flags, indexed like `rows`. Applied to both the on-page table
   * and the PDF table. Absent/short arrays leave rows unhighlighted.
   */
  highlightRows?: boolean[];
  /** Tint for highlighted rows; defaults to `'warning'` (matches `TablePdf`). */
  highlightTone?: 'warning' | 'destructive';
}

const ROW_HIGHLIGHT_CLASS: Record<'warning' | 'destructive', string> = {
  warning: 'bg-warning/5 border-l-[3px] border-l-warning',
  destructive: 'bg-destructive/5 border-l-[3px] border-l-destructive',
};

const LAST_CELL_HIGHLIGHT_CLASS: Record<'warning' | 'destructive', string> = {
  warning: 'font-semibold text-warning',
  destructive: 'font-semibold text-destructive',
};

/**
 * Cell classes for the on-page table. Highlight-only styling (bold last cell, muted zero
 * counts) is scoped to sections that opt into `highlightRows`, so existing reports render
 * exactly as before.
 */
function cellClassName(
  section: UsageReportSection,
  cell: string,
  cellIndex: number,
  rowLength: number,
  highlighted: boolean,
): string {
  const classes = [
    cellIndex === 0 ? 'font-mono text-xs' : 'text-right font-mono',
  ];
  if (section.highlightRows !== undefined && cellIndex >= 1) {
    if (highlighted && cellIndex === rowLength - 1) {
      classes.push(
        LAST_CELL_HIGHLIGHT_CLASS[section.highlightTone ?? 'warning'],
      );
    } else if (cell === '0') {
      classes.push('text-muted-foreground');
    }
  }
  return classes.join(' ');
}

interface Props {
  title: string;
  repoId: number;
  teamId?: number;
  params: ReportParamsState;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  hasData: boolean;
  kpiRows: ReportKpiRow[];
  sections: UsageReportSection[];
  /** Becomes `<prefix>_<start>_<end>.pdf`. */
  pdfFilePrefix: string;
}

function buildPdf(
  title: string,
  repoUrl: string,
  teamName: string | null,
  params: ReportParamsState,
  kpiRows: ReportKpiRow[],
  sections: UsageReportSection[],
) {
  return PdfDocumentShell({
    title,
    repoUrl,
    teamName,
    periodLabel: formatPeriodLabel(params.startDate, params.endDate),
    generatedAt: formatGeneratedAt(),
    kpiRows,
    children: (
      <>
        {sections.map((section) => (
          <View key={section.title} style={pdfStyles.section}>
            <Text style={pdfStyles.sectionTitle}>{section.title}</Text>
            {section.subtitle !== undefined && (
              <Text style={pdfStyles.sectionSubtitle}>{section.subtitle}</Text>
            )}
            {section.rows.length > 0 ? (
              <TablePdf
                columns={section.columns}
                rows={section.rows}
                highlightRows={section.highlightRows}
                highlightTone={section.highlightTone}
              />
            ) : (
              <Text style={pdfStyles.meta}>{section.emptyLabel}</Text>
            )}
            {section.footnote !== undefined && (
              <Text style={pdfStyles.meta}>{section.footnote}</Text>
            )}
          </View>
        ))}
      </>
    ),
  });
}

export function UsageReportDocument({
  title,
  repoId,
  teamId,
  params,
  isLoading,
  isFetching,
  error,
  onRetry,
  hasData,
  kpiRows,
  sections,
  pdfFilePrefix,
}: Props) {
  const { repoUrl, teamName } = useReportHeaderMeta(repoId, teamId);

  const { downloadError, handleDownload } = useReportPdfDownload(
    () => buildPdf(title, repoUrl, teamName, params, kpiRows, sections),
    `${pdfFilePrefix}_${params.startDate}_${params.endDate}.pdf`,
  );

  return (
    <ReportDocumentShell
      isLoading={isLoading}
      error={error}
      onRetry={onRetry}
      canDownload={hasData && !isFetching && !error}
      onDownload={() => void handleDownload()}
      downloadError={downloadError}
      maxWidthClassName="max-w-[884px]"
    >
      <ReportDocumentHeader
        title={title}
        repoUrl={repoUrl}
        teamName={teamName}
        startDate={params.startDate}
        endDate={params.endDate}
      />
      {hasData && (
        <>
          {kpiRows.length > 0 && <ReportKpiTable rows={kpiRows} />}
          {sections.map((section) => (
            <section key={section.title} className="mb-6">
              <h2 className="text-sm font-semibold text-foreground">
                {section.title}
              </h2>
              {section.subtitle !== undefined && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {section.subtitle}
                </p>
              )}
              {section.rows.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {section.columns.map((column, i) => (
                          <TableHead
                            key={column === '' ? `col-${i}` : column}
                            className={i === 0 ? undefined : 'text-right'}
                          >
                            {column}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {section.rows.map((row, rowIndex) => {
                        const highlighted =
                          section.highlightRows?.[rowIndex] === true;
                        return (
                          <TableRow
                            key={`${row[0]}-${rowIndex}`}
                            className={
                              highlighted
                                ? ROW_HIGHLIGHT_CLASS[
                                    section.highlightTone ?? 'warning'
                                  ]
                                : undefined
                            }
                          >
                            {row.map((cell, cellIndex) => (
                              <TableCell
                                key={cellIndex}
                                className={cellClassName(
                                  section,
                                  cell,
                                  cellIndex,
                                  row.length,
                                  highlighted,
                                )}
                              >
                                {cell}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="flex items-center justify-center h-20 text-sm text-muted-foreground border border-dashed rounded-md">
                  {section.emptyLabel}
                </p>
              )}
              {section.footnote !== undefined && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {section.footnote}
                </p>
              )}
            </section>
          ))}
        </>
      )}
    </ReportDocumentShell>
  );
}
