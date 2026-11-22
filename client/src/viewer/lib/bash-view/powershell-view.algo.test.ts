/**
 * Table test for docs/knowledgebase/algorithms/powershell-command-view.md.
 *
 * - View rows run `buildPowerShellView(parser, command, root)` and compare only the keys the row
 *   lists (`changes` / `reads` / `runs` / `inline` / `unresolved` / `deleted` from `view.files`;
 *   `changeGroups` / `readGroups` from `displayGroups`, the same helper the FILES block uses;
 *   `readAccess` from `analyzePowerShell` of the unwrapped command); every `ok` row also checks the
 *   token invariant (rule 3.7) on `formatPowerShell(parser, stripLhWrap(parser, command)).script`.
 * - Highlight rows run `highlightPowerShell` with `powershellHighlightQuery(<grammar
 *   highlights.scm>)` — the same query builder as the browser's `PS_HIGHLIGHT_QUERY` — and compare
 *   `[kind, text]` pairs.
 *
 * The WASM files and `highlights.scm` are node paths resolved with `createRequire` — the browser
 * uses Vite `?url` / `?raw` imports instead (`powershell-browser-parser.ts`).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  type BashParser,
  analyzePowerShell,
  buildPowerShellView,
  displayGroups,
  formatPowerShell,
  highlightPowerShell,
  powershellHighlightQuery,
  stripLhWrap,
} from '@loghub/bash-view';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTreeSitterParser } from './bash-parser';

const require = createRequire(import.meta.url);

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../scripts/algo-docs/load-examples.cjs') = require('../../../../../scripts/algo-docs/load-examples.cjs');

interface PowerShellViewInput {
  command: string;
  root?: string;
  highlight?: true;
}

interface PowerShellViewExpected {
  ok?: boolean;
  workDir?: string | null;
  script?: string;
  rawDisplay?: string;
  folded?: unknown[];
  lineCount?: number;
  rawLineCount?: number;
  firstStatement?: string | null;
  changes?: string[];
  reads?: string[];
  runs?: string[];
  inline?: string[];
  unresolved?: number;
  deleted?: string[];
  changeGroups?: unknown[] | null;
  readGroups?: unknown[] | null;
  readAccess?: {
    path: string;
    kind: string;
    range?: { from: number; to: number | null };
    pattern?: string;
  }[];
  highlights?: [string, string][];
}

const rows = loader.loadExamples<PowerShellViewInput, PowerShellViewExpected>(
  'powershell-command-view',
);
const viewRows = rows.filter((row) => row.input.highlight !== true);
const highlightRows = rows.filter((row) => row.input.highlight === true);

/** Rule 9.1, built by the production `powershellHighlightQuery` from the grammar's file. */
const HIGHLIGHT_QUERY = powershellHighlightQuery(
  readFileSync(
    require.resolve('tree-sitter-powershell/queries/highlights.scm'),
    'utf8',
  ),
);

let parser: BashParser;

beforeAll(async () => {
  parser = await loadTreeSitterParser('powershell', {
    runtimeWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
    languageWasm:
      require.resolve('tree-sitter-powershell/tree-sitter-powershell.wasm'),
  });
});

/**
 * Rule 3.7: only whitespace changes and statement-separating `;` are dropped, so the text without
 * blanks and `;` is the same before and after formatting.
 */
const tokenText = (s: string): string => s.replace(/[\s;]/g, '');

describe('powershell-command-view: view rows', () => {
  it.each(viewRows)('$id', ({ input, expected }) => {
    const view = buildPowerShellView(parser, input.command, input.root ?? '');
    const typed = stripLhWrap(parser, input.command);
    const actual: Record<string, unknown> = {
      ok: view.ok,
      workDir: view.workDir,
      script: view.script,
      rawDisplay: view.rawDisplay,
      folded: view.folded,
      lineCount: view.lineCount,
      rawLineCount: view.rawLineCount,
      firstStatement: view.firstStatement,
      changes: view.files.changes,
      reads: view.files.reads,
      runs: view.files.runs,
      inline: view.files.inline,
      unresolved: view.files.unresolved,
      deleted: view.files.deleted,
      changeGroups: displayGroups('changes', view.files.changes),
      readGroups: displayGroups('reads', view.files.reads),
      // Not part of the view: `analyzePowerShell` straight, paths as written (not repo-relative).
      ...('readAccess' in expected
        ? { readAccess: analyzePowerShell(parser, typed).readAccess }
        : {}),
    };
    const picked = Object.fromEntries(
      Object.keys(expected).map((k) => [k, actual[k]]),
    );
    expect(picked).toEqual(expected);

    if (view.ok) {
      const formatted = formatPowerShell(parser, typed);
      expect(tokenText(formatted.script)).toEqual(tokenText(typed));
    }
  });
});

describe('powershell-command-view: highlight rows', () => {
  it.each(highlightRows)('$id', ({ input, expected }) => {
    const segments = highlightPowerShell(
      parser,
      input.command,
      HIGHLIGHT_QUERY,
    );
    expect({
      highlights: segments.map((s) => [
        s.kind,
        input.command.slice(s.start, s.end),
      ]),
    }).toEqual(expected);
  });
});
