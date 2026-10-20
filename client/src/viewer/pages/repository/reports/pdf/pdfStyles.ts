import { StyleSheet } from '@react-pdf/renderer';

// Shared react-pdf StyleSheet for every report's PDF document — one visual
// language across all of them (header, KPI table, chart section headings).
export const pdfStyles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: 'Helvetica' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  title: { fontSize: 18, fontWeight: 700 },
  meta: { fontSize: 9, color: '#64748b' },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    marginTop: 6,
    marginBottom: 14,
  },
  table: { borderWidth: 1, borderColor: '#e2e8f0', marginBottom: 20 },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  tableRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  metricCell: { flex: 1 },
  valueCell: { flex: 1, textAlign: 'right', fontWeight: 700 },
  headerCell: { flex: 1, fontSize: 8, color: '#94a3b8' },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 12, fontWeight: 700 },
  sectionSubtitle: { fontSize: 9, color: '#94a3b8', marginBottom: 6 },
  // Muted footnote panel — currently backs Executive Summary's "Data Source &
  // Limitations" block (ExecutiveSummaryLimitationsPdf.tsx), additive so any
  // other report's PDF can reuse the same look later.
  limitationsPanel: {
    backgroundColor: '#fafafa',
    borderWidth: 1,
    borderColor: '#e4e4e7',
    borderRadius: 4,
    padding: 12,
  },
});
