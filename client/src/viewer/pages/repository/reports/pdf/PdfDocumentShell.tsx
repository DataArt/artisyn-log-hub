import type { ReactNode } from 'react';
import { Document, Page, Text, View } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';

export interface PdfKpiRow {
  label: string;
  value: string;
  // Second value column — only rendered when the
  // document is in two-column mode (`valueHeaders` given).
  secondValue?: string;
  // Indented sub-row on a violet band (the 5m/1h TTL rows).
  indent?: boolean;
}

interface Props {
  title: string;
  repoUrl: string;
  teamName: string | null;
  periodLabel: string;
  generatedAt: string;
  kpiRows: PdfKpiRow[];
  // Labels for the value column(s). Omitted → the single "VALUE" column every
  // single-value report's PDF uses; a pair switches to two value columns.
  valueHeaders?: [string, string];
  children?: ReactNode;
}

// Shared PDF document shell — header + KPI table, used by every report's PDF
// export. Chart/table sections are passed as children using pdfStyles.section*.
export function PdfDocumentShell({
  title,
  repoUrl,
  teamName,
  periodLabel,
  generatedAt,
  kpiRows,
  valueHeaders,
  children,
}: Props) {
  const twoColumn = valueHeaders != null;

  return (
    <Document>
      <Page size="A4" style={pdfStyles.page}>
        <View style={pdfStyles.headerRow}>
          <Text style={pdfStyles.title}>{title}</Text>
          <Text style={pdfStyles.meta}>Generated on {generatedAt} UTC</Text>
        </View>
        <Text style={pdfStyles.meta}>
          {repoUrl}
          {teamName ? ` · ${teamName}` : ''}
        </Text>
        <Text style={pdfStyles.meta}>Period: {periodLabel}</Text>
        <View style={pdfStyles.divider} />

        {/* A report with no headline figures (kpiRows: []) omits the KPI table entirely. */}
        {kpiRows.length > 0 && (
          <View style={pdfStyles.table}>
            <View style={pdfStyles.tableHeaderRow}>
              <Text style={pdfStyles.headerCell}>METRIC</Text>
              <Text style={[pdfStyles.headerCell, { textAlign: 'right' }]}>
                {valueHeaders ? valueHeaders[0] : 'VALUE'}
              </Text>
              {twoColumn && (
                <Text style={[pdfStyles.headerCell, { textAlign: 'right' }]}>
                  {valueHeaders[1]}
                </Text>
              )}
            </View>
            {kpiRows.map((row) => (
              <View
                key={row.label}
                style={
                  row.indent
                    ? [pdfStyles.tableRow, { backgroundColor: '#f5f3ff' }]
                    : pdfStyles.tableRow
                }
              >
                <Text
                  style={
                    row.indent
                      ? [
                          pdfStyles.metricCell,
                          { paddingLeft: 12, color: '#4338ca' },
                        ]
                      : pdfStyles.metricCell
                  }
                >
                  {row.indent ? `> ${row.label}` : row.label}
                </Text>
                <Text style={pdfStyles.valueCell}>{row.value}</Text>
                {twoColumn && (
                  <Text style={pdfStyles.valueCell}>
                    {row.secondValue ?? '-'}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}

        {children}
      </Page>
    </Document>
  );
}
