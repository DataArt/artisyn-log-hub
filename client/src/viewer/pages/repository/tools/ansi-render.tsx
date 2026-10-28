/**
 * Renders terminal output with its ANSI colours on the light surface of the Tools/MCP details
 * pane. Only SGR foreground colours 30–37 / 90–97, bold (1) and the resets (0, empty, 22, 39)
 * are kept; every other escape sequence — backgrounds, cursor moves, OSC titles — is stripped,
 * so no dark background ever appears.
 */
import type { ReactNode } from 'react';

export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white';

export interface AnsiSegment {
  text: string;
  /** Foreground colour, or null for the default text colour. */
  color: AnsiColor | null;
  bright: boolean;
  bold: boolean;
}

const COLORS: readonly AnsiColor[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];

/** Dark-on-light classes: white and black map to greys so both stay readable on white. */
const NORMAL_CLASS: Readonly<Record<AnsiColor, string>> = {
  black: 'text-gray-900',
  red: 'text-red-700',
  green: 'text-green-700',
  yellow: 'text-amber-700',
  blue: 'text-blue-700',
  magenta: 'text-fuchsia-700',
  cyan: 'text-cyan-700',
  white: 'text-gray-500',
};

const BRIGHT_CLASS: Readonly<Record<AnsiColor, string>> = {
  black: 'text-gray-500',
  red: 'text-red-600',
  green: 'text-green-600',
  yellow: 'text-amber-600',
  blue: 'text-blue-600',
  magenta: 'text-fuchsia-600',
  cyan: 'text-cyan-600',
  white: 'text-gray-400',
};

// Any escape sequence: CSI (captured when it is an SGR `ESC [ <params> m`), OSC, or a two-byte
// `ESC <char>` form.
/* eslint-disable no-control-regex -- matching ESC / BEL is the point */
const ESCAPE_PATTERN =
  /\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

interface SgrState {
  color: AnsiColor | null;
  bright: boolean;
  bold: boolean;
}

function applySgr(state: SgrState, params: string): SgrState {
  // `ESC [ m` is a reset; sub-parameters (`38;5;n`, `38:2:…`) are skipped as a whole.
  const codes =
    params === '' ? [0] : params.split(';').map((p) => Number(p.split(':')[0]));
  const next = { ...state };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0 || Number.isNaN(c)) {
      next.color = null;
      next.bright = false;
      next.bold = false;
    } else if (c === 1) {
      next.bold = true;
    } else if (c === 22) {
      next.bold = false;
    } else if (c === 39) {
      next.color = null;
      next.bright = false;
    } else if (c >= 30 && c <= 37) {
      next.color = COLORS[c - 30];
      next.bright = false;
    } else if (c >= 90 && c <= 97) {
      next.color = COLORS[c - 90];
      next.bright = true;
    } else if (c === 38 || c === 48) {
      // Extended colour: skip its arguments (`5;n` or `2;r;g;b`), keep the current colour.
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  }
  return next;
}

/** `text` split into styled segments; adjacent text with the same style is merged. */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let state: SgrState = { color: null, bright: false, bold: false };
  const push = (chunk: string) => {
    if (chunk === '') return;
    const last = segments[segments.length - 1];
    if (
      last &&
      last.color === state.color &&
      last.bright === state.bright &&
      last.bold === state.bold
    ) {
      last.text += chunk;
    } else {
      segments.push({ text: chunk, ...state });
    }
  };
  let pos = 0;
  for (const m of text.matchAll(ESCAPE_PATTERN)) {
    const at = m.index ?? 0;
    push(text.slice(pos, at));
    pos = at + m[0].length;
    if (m[3] === 'm' && (m[2] ?? '') === '')
      state = applySgr(state, m[1] ?? '');
  }
  push(text.slice(pos));
  return segments;
}

function segmentClass(s: AnsiSegment): string {
  const parts: string[] = [];
  if (s.color) parts.push((s.bright ? BRIGHT_CLASS : NORMAL_CLASS)[s.color]);
  if (s.bold) parts.push('font-semibold');
  return parts.join(' ');
}

/** Inline spans of `text` with its ANSI styling on a light surface. */
export function AnsiText({ text }: { text: string }): ReactNode {
  return parseAnsi(text).map((s, i) => {
    const cls = segmentClass(s);
    return cls ? (
      <span key={i} className={cls}>
        {s.text}
      </span>
    ) : (
      <span key={i}>{s.text}</span>
    );
  });
}
