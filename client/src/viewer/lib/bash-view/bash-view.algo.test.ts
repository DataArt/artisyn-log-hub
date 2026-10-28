/**
 * Table test for docs/knowledgebase/algorithms/bash-command-view.md.
 *
 * - View rows run `buildBashView(parser, command, root)` and compare only the keys the row lists
 *   (`changes` / `reads` / `runs` / `inline` / `unresolved` from `view.files`; `changeGroups` /
 *   `readGroups` / `runGroups` / `inlineGroups` from `displayGroups`, the same helper the FILES
 *   block uses; `readAccess` from `analyzeBash`); every `ok` row also
 *   checks the token invariant (rule 2.7) on `formatBash(parser, command).script`.
 * - Highlight rows run `highlightBash` with `bashHighlightQuery(<grammar highlights.scm>)` — the
 *   same query builder as the browser's `HIGHLIGHT_QUERY` — and compare `[kind, text]` pairs.
 *
 * The WASM files and `highlights.scm` are node paths resolved with `createRequire` — the browser
 * uses Vite `?url` / `?raw` imports instead (`browser-parser.ts`).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  type BashParser,
  type BashSyntaxNode,
  analyzeBash,
  bashHighlightQuery,
  buildBashView,
  displayGroups,
  formatBash,
  highlightBash,
  withTree,
} from '@loghub/bash-view';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBashParser } from './bash-parser';

const require = createRequire(import.meta.url);

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../scripts/algo-docs/load-examples.cjs') = require('../../../../../scripts/algo-docs/load-examples.cjs');

interface BashViewInput {
  command: string;
  root?: string;
  highlight?: true;
}

interface BashViewExpected {
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
  changeGroups?: unknown[] | null;
  readGroups?: unknown[] | null;
  runGroups?: unknown[] | null;
  inlineGroups?: unknown[] | null;
  readAccess?: { path: string; kind: string }[];
  highlights?: [string, string][];
}

const rows = loader.loadExamples<BashViewInput, BashViewExpected>(
  'bash-command-view',
);
const viewRows = rows.filter((row) => row.input.highlight !== true);
const highlightRows = rows.filter((row) => row.input.highlight === true);

/** Rule 7.1, built by the production `bashHighlightQuery` from the grammar's file. */
const HIGHLIGHT_QUERY = bashHighlightQuery(
  readFileSync(
    require.resolve('tree-sitter-bash/queries/highlights.scm'),
    'utf8',
  ),
);

let parser: BashParser;

beforeAll(async () => {
  parser = await loadBashParser({
    runtimeWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
    languageWasm: require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'),
  });
});

/** Tokens per rule 2.7: leaf texts (heredoc bodies and strings whole), no `;`, newlines or blanks. */
function tokens(src: string): string[] {
  return withTree(parser, src, (root) => {
    const out: string[] = [];
    const walk = (n: BashSyntaxNode): void => {
      if (
        n.children.length === 0 ||
        n.type === 'heredoc_body' ||
        n.type === 'string_content' ||
        n.type === 'raw_string'
      ) {
        if (n.type !== ';' && n.type !== '\n' && n.text.trim() !== '')
          out.push(n.text);
        return;
      }
      for (const c of n.children) if (c) walk(c);
    };
    walk(root);
    return out;
  });
}

describe('bash-command-view: view rows', () => {
  it.each(viewRows)('$id', ({ input, expected }) => {
    const view = buildBashView(parser, input.command, input.root ?? '');
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
      changeGroups: displayGroups('changes', view.files.changes),
      readGroups: displayGroups('reads', view.files.reads),
      runGroups: displayGroups('runs', view.files.runs),
      inlineGroups: displayGroups('inline', view.files.inline),
      // Not part of the view: `analyzeBash` straight, paths as written (not repo-relative).
      ...('readAccess' in expected
        ? { readAccess: analyzeBash(parser, input.command).readAccess }
        : {}),
    };
    const picked = Object.fromEntries(
      Object.keys(expected).map((k) => [k, actual[k]]),
    );
    expect(picked).toEqual(expected);

    if (view.ok) {
      const formatted = formatBash(parser, input.command);
      expect(tokens(formatted.script)).toEqual(tokens(input.command));
    }
  });
});

describe('bash-command-view: highlight rows', () => {
  it.each(highlightRows)('$id', ({ input, expected }) => {
    const segments = highlightBash(parser, input.command, HIGHLIGHT_QUERY);
    expect({
      highlights: segments.map((s) => [
        s.kind,
        input.command.slice(s.start, s.end),
      ]),
    }).toEqual(expected);
  });
});
