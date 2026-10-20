export type FilesMetricKey = string;

export interface FilesMetricDef {
  key: FilesMetricKey;
  label: string;
  shortLabel: string;
  description: string;
  format: (v: number) => string;
  yLabel: string;
}

function formatBytes(v: number): string {
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} MB`;
  if (v >= 1_024) return `${(v / 1_024).toFixed(1)} KB`;
  return `${v} B`;
}

const STATIC_FILES_METRICS: FilesMetricDef[] = [
  {
    key: 'filesEditedWritten',
    // Relabel — COPY ONLY: the key, format and yLabel are
    // untouched, so no historical figure shifts. The name now says what the number
    // actually counts, which the description already spelled out.
    label: 'Edit/write calls',
    shortLabel: 'Edited',
    description:
      'Edit, Write and MultiEdit tool calls across the whole session tree — the session itself plus every sub-agent it spawned. A count of calls, not of distinct files.',
    format: (v) => v.toLocaleString(),
    yLabel: 'files',
  },
  {
    key: 'linesChanged',
    // Relabel — COPY ONLY. The key, format, yLabel and `computeProductivityValue`
    // (and therefore costPerLine / linesPerHour) are deliberately untouched, so no
    // historical figure shifts. The name now says which of the two line measures this is:
    // this one counts lines WRITTEN with no delta and no removals, while the Productivity
    // Counters view reports diff-based added/removed lines — measured at ~1/3 of this value,
    // with removals this metric has no counterpart for. The two never share a view.
    label: 'Lines changed (written)',
    shortLabel: 'Lines',
    description:
      'Total lines written across all Edit (new_string), Write (content) and MultiEdit (edits[].new_string) tool calls, over the whole session tree — the session itself plus every sub-agent it spawned. A count of lines written, with no delta and no removals. Not the same as the diff-based lines added/removed in the Productivity Counters view.',
    format: (v) => v.toLocaleString(),
    yLabel: 'lines',
  },
];

export function buildFilesMetrics(categories: string[]): FilesMetricDef[] {
  const categoryMetrics: FilesMetricDef[] = categories.flatMap((cat) => [
    {
      key: `cat:${cat}:files`,
      label: `${cat} files accessed`,
      shortLabel: `${cat} files`,
      description: `Number of ${cat} files read`,
      format: (v) => v.toLocaleString(),
      yLabel: 'files',
    },
    {
      key: `cat:${cat}:bytes`,
      label: `${cat} bytes read`,
      shortLabel: `${cat} bytes`,
      description: `Total bytes of ${cat} content read`,
      format: formatBytes,
      yLabel: 'bytes',
    },
  ]);
  return [...categoryMetrics, ...STATIC_FILES_METRICS];
}

export const FILES_METRICS: FilesMetricDef[] = STATIC_FILES_METRICS;

export type VisionMetricKey = 'imageCount' | 'imageTotalBytes';

export interface VisionMetricDef {
  key: VisionMetricKey;
  label: string;
  shortLabel: string;
  description: string;
  format: (v: number) => string;
  yLabel: string;
}

export const VISION_METRICS: VisionMetricDef[] = [
  {
    key: 'imageCount',
    label: 'Images examined',
    shortLabel: 'Images',
    description: 'Number of images passed to the model as vision input',
    format: (v) => v.toLocaleString(),
    yLabel: 'images',
  },
  {
    key: 'imageTotalBytes',
    label: 'Image bytes',
    shortLabel: 'Bytes',
    description: 'Total decoded bytes of all images passed to the model',
    format: (v) => {
      if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} MB`;
      if (v >= 1_024) return `${(v / 1_024).toFixed(1)} KB`;
      return `${v} B`;
    },
    yLabel: 'bytes',
  },
];

export type ProductivityMetricKey =
  | 'linesPerHour'
  | 'costPerHour'
  | 'costPerLine';

export interface ProductivityMetricDef {
  key: ProductivityMetricKey;
  label: string;
  shortLabel: string;
  description: string;
  format: (v: number) => string;
  yLabel: string;
}

export const PRODUCTIVITY_METRICS: ProductivityMetricDef[] = [
  {
    key: 'linesPerHour',
    label: 'Lines per hour',
    shortLabel: 'Lines',
    description: 'Lines of code changed per autonomous work hour',
    format: (v) => Math.round(v).toLocaleString(),
    yLabel: 'lines/hr',
  },
  {
    key: 'costPerHour',
    label: 'Cost per hour',
    shortLabel: 'Cost/hr',
    description: 'Model cost spent per autonomous work hour',
    format: (v) => (v < 0.01 ? `$${v.toFixed(4)}/hr` : `$${v.toFixed(2)}/hr`),
    yLabel: '$/hr',
  },
  {
    key: 'costPerLine',
    label: 'Cost per line',
    shortLabel: 'Cost/line',
    description: 'Model cost spent per line of code changed',
    format: (v) =>
      v < 0.0001
        ? `$${v.toFixed(6)}/line`
        : v < 0.01
          ? `$${v.toFixed(4)}/line`
          : `$${v.toFixed(2)}/line`,
    yLabel: '$/line',
  },
];

export type LogLinesMetricKey = 'logLineCount';

export interface LogLinesMetricDef {
  key: LogLinesMetricKey;
  label: string;
  shortLabel: string;
  description: string;
  format: (v: number) => string;
  yLabel: string;
}

export const LOG_LINES_METRICS: LogLinesMetricDef[] = [
  {
    key: 'logLineCount',
    label: 'Log lines',
    shortLabel: 'Lines',
    description: 'Number of JSONL records in the Claude session log',
    format: (v) => v.toLocaleString(),
    yLabel: 'lines',
  },
];

export interface ProductivitySession {
  workTimeMs: number;
  totalCost: number | null;
  linesChanged: number;
}

export function computeProductivityValue(
  session: ProductivitySession,
  key: ProductivityMetricKey,
): number | null {
  switch (key) {
    case 'linesPerHour':
      return session.workTimeMs === 0
        ? null
        : Math.round(session.linesChanged / (session.workTimeMs / 3_600_000));
    case 'costPerHour':
      return session.totalCost == null || session.workTimeMs === 0
        ? null
        : session.totalCost / (session.workTimeMs / 3_600_000);
    case 'costPerLine':
      return session.totalCost == null || session.linesChanged === 0
        ? null
        : session.totalCost / session.linesChanged;
  }
}
