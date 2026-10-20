import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';

interface Props {
  columns: string[];
  rows: string[][];
  /**
   * Optional per-row amber tint, indexed like `rows`. Used by Executive Summary to
   * mark a session whose model has no configured pricing, matching the on-screen table's
   * `bg-warning/5` row. Absent/short arrays simply leave rows untinted.
   */
  highlightRows?: boolean[];
  /**
   * Tint used for highlighted rows. Defaults to `'warning'` (amber, the original no-pricing look);
   * `'destructive'` is the red wash Claude Code Version Usage uses for outdated users.
   */
  highlightTone?: 'warning' | 'destructive';
}

const styles = StyleSheet.create({
  // #fffbeb — same amber wash the wireframe uses for an unpriced row on screen.
  highlightedRow: { backgroundColor: '#fffbeb' },
  // #fef2f2 — the red wash matching the on-screen `bg-destructive/5` row.
  highlightedRowDestructive: { backgroundColor: '#fef2f2' },
});

// Generic N-column table for PDF report exports (Branch Summary's per-branch
// breakdown, Executive Summary's top-sessions table).
export function TablePdf({
  columns,
  rows,
  highlightRows,
  highlightTone = 'warning',
}: Props) {
  const highlightStyle =
    highlightTone === 'destructive'
      ? styles.highlightedRowDestructive
      : styles.highlightedRow;
  return (
    <View style={pdfStyles.table}>
      <View style={pdfStyles.tableHeaderRow}>
        {columns.map((col, i) => (
          <Text
            key={col}
            style={
              i > 0
                ? [pdfStyles.headerCell, { textAlign: 'right' }]
                : pdfStyles.headerCell
            }
          >
            {col.toUpperCase()}
          </Text>
        ))}
      </View>
      {rows.map((row, ri) => (
        <View
          key={ri}
          style={
            highlightRows?.[ri]
              ? [pdfStyles.tableRow, highlightStyle]
              : pdfStyles.tableRow
          }
        >
          {row.map((cell, ci) => (
            <Text
              key={ci}
              style={ci === 0 ? pdfStyles.metricCell : pdfStyles.valueCell}
            >
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}
