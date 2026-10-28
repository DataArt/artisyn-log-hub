/**
 * Output text helpers of the Tools/MCP details pane: what shape a captured output has, how to
 * re-align a table whose columns the terminal width broke, and which lines of the full output
 * the agent actually received. Pure functions — no React — so the algorithm table test can run
 * them directly.
 */

export type OutputFormat =
  | 'json'
  | 'pipe-table'
  | 'fixed-width-table'
  | 'tsv'
  | 'plain';

export interface RealignedTable {
  headers: string[];
  rows: string[][];
}

/** Lines looked at by {@link detectOutputFormat}; a table is recognised from its head. */
const DETECT_MAX_LINES = 200;
/** A wider "table" is noise, not columns. */
const MAX_COLUMNS = 40;

// Every escape sequence a terminal output can carry: CSI (`ESC [ … final`), OSC
// (`ESC ] … BEL` or `ESC ] … ESC \`) and the two-byte `ESC <char>` forms.
/* eslint-disable no-control-regex -- matching ESC / BEL is the point */
const ANSI_PATTERN =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

/** `text` without terminal escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * The lines of an output: split on `\n` / `\r\n`; a trailing newline does not add an empty
 * last line. Line indexes returned by {@link markAgentSeenLines} refer to this split.
 */
export function splitOutputLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function nonEmptyLines(text: string): string[] {
  return splitOutputLines(stripAnsi(text))
    .slice(0, DETECT_MAX_LINES)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '');
}

function isJson(trimmed: string): boolean {
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** A pipe-table rule line such as `|---|:--:|` or `----+----`. */
function isRuleLine(line: string): boolean {
  return /^[\s|+:=-]+$/.test(line) && /[-=]/.test(line);
}

function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function looksLikePipeTable(lines: string[]): boolean {
  const rows = lines.filter((l) => !isRuleLine(l));
  if (rows.length < 2) return false;
  const width = splitPipeRow(rows[0]).length;
  if (width < 2 || width > MAX_COLUMNS) return false;
  return rows.every((l) => l.includes('|') && splitPipeRow(l).length === width);
}

function looksLikeTsv(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const width = lines[0].split('\t').length;
  if (width < 2 || width > MAX_COLUMNS) return false;
  return lines.every((l) => l.split('\t').length === width);
}

/**
 * Column spans of a fixed-width table: maximal runs of character positions where at least one
 * line has a non-space character, separated by "gutters" — positions blank in every line.
 * Returns the `[start, end)` spans and the widest gutter.
 */
function fixedWidthColumns(lines: string[]): {
  spans: [number, number][];
  widestGutter: number;
} {
  const width = Math.max(...lines.map((l) => l.length));
  const used = new Array<boolean>(width).fill(false);
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== ' ') used[i] = true;
    }
  }
  const spans: [number, number][] = [];
  let widestGutter = 0;
  let i = 0;
  while (i < width) {
    if (!used[i]) {
      const start = i;
      while (i < width && !used[i]) i++;
      if (spans.length > 0 && i < width) {
        widestGutter = Math.max(widestGutter, i - start);
      }
      continue;
    }
    const start = i;
    while (i < width && used[i]) i++;
    spans.push([start, i]);
  }
  return { spans, widestGutter };
}

function looksLikeFixedWidth(lines: string[]): boolean {
  if (lines.length < 2 || lines.some((l) => l.includes('\t'))) return false;
  const { spans, widestGutter } = fixedWidthColumns(lines);
  if (spans.length < 2 || spans.length > MAX_COLUMNS || widestGutter < 2) {
    return false;
  }
  // The header names every column.
  const header = lines[0];
  return spans.every(([s, e]) => header.slice(s, e).trim() !== '');
}

/**
 * The shape of a captured output, checked in order: JSON (the whole trimmed text parses as an
 * object or array), pipe table (≥ 2 rows with the same number of `|` cells, rule lines
 * ignored), TSV (≥ 2 lines with the same number of tab-separated cells), fixed-width table
 * (≥ 2 lines whose columns are separated by blank gutters in every line, at least one gutter
 * ≥ 2 wide, and a header naming every column), else plain. Escape sequences are ignored.
 */
export function detectOutputFormat(text: string): OutputFormat {
  const trimmed = stripAnsi(text).trim();
  if (trimmed === '') return 'plain';
  if (isJson(trimmed)) return 'json';
  const lines = nonEmptyLines(text);
  if (looksLikePipeTable(lines)) return 'pipe-table';
  if (looksLikeTsv(lines)) return 'tsv';
  if (looksLikeFixedWidth(lines)) return 'fixed-width-table';
  return 'plain';
}

function padRow(row: string[], width: number): string[] {
  if (row.length >= width) return row;
  return [...row, ...new Array<string>(width - row.length).fill('')];
}

/**
 * A TSV's first row is a header only when every cell is non-empty and holds no digit: a
 * header-less TSV (`gh issue list` piped) starts with a data row such as `51\tCLOSED\t…`.
 */
function isTsvHeader(row: string[]): boolean {
  return row.every((c) => c !== '' && !/\d/.test(c));
}

/**
 * The cells of a table output: the first row is the header, every row is padded to the
 * header's width. A TSV without a header row ({@link isTsvHeader}) gives `headers: []` and
 * every line as a row. Rule lines of a pipe table are dropped; escape sequences are stripped.
 * `json` and `plain` give no table (`{ headers: [], rows: [] }`).
 */
export function realignTable(
  text: string,
  format: OutputFormat,
): RealignedTable {
  const lines = splitOutputLines(stripAnsi(text))
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '');
  let cells: string[][];
  if (format === 'pipe-table') {
    cells = lines.filter((l) => !isRuleLine(l)).map(splitPipeRow);
  } else if (format === 'tsv') {
    cells = lines.map((l) => l.split('\t').map((c) => c.trim()));
  } else if (format === 'fixed-width-table') {
    const { spans } = fixedWidthColumns(lines);
    cells = lines.map((l) =>
      spans.map(([s, e], i) =>
        // The last column takes the rest of the line, so an over-long value is not cut.
        (i === spans.length - 1 ? l.slice(s) : l.slice(s, e)).trim(),
      ),
    );
  } else {
    return { headers: [], rows: [] };
  }
  if (cells.length === 0) return { headers: [], rows: [] };
  if (format === 'tsv' && !isTsvHeader(cells[0])) {
    return { headers: [], rows: cells };
  }
  const headers = cells[0];
  return {
    headers,
    rows: cells.slice(1).map((r) => padRow(r, headers.length)),
  };
}

function comparable(line: string): string {
  return stripAnsi(line).replace(/\s+$/, '');
}

/**
 * Indexes (into {@link splitOutputLines} of `full`) of the lines the agent received. Lines are
 * compared without escape sequences and trailing whitespace. Each line of `agentSaw` is matched
 * to the next equal line of `full` after the previous match, so a head, a tail or a head + tail
 * with a truncation marker in between all map back; an `agentSaw` line with no such match (a
 * marker the agent harness added) is skipped. The last `agentSaw` line may be a prefix of its
 * `full` line, when the output was cut mid-line.
 */
export function markAgentSeenLines(full: string, agentSaw: string): number[] {
  const fullLines = splitOutputLines(full).map(comparable);
  const sawLines = splitOutputLines(agentSaw).map(comparable);
  if (fullLines.length === 0 || sawLines.length === 0) return [];

  const positions = new Map<string, number[]>();
  fullLines.forEach((line, idx) => {
    const list = positions.get(line);
    if (list) list.push(idx);
    else positions.set(line, [idx]);
  });

  const nextAtOrAfter = (list: number[], from: number): number | null => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length ? list[lo] : null;
  };

  const seen: number[] = [];
  let cursor = 0;
  sawLines.forEach((line, i) => {
    if (cursor >= fullLines.length) return;
    const exact = positions.get(line);
    const hit = exact ? nextAtOrAfter(exact, cursor) : null;
    if (hit !== null) {
      seen.push(hit);
      cursor = hit + 1;
      return;
    }
    const isLast = i === sawLines.length - 1;
    if (isLast && line !== '' && fullLines[cursor].startsWith(line)) {
      seen.push(cursor);
      cursor += 1;
    }
  });
  return seen;
}
