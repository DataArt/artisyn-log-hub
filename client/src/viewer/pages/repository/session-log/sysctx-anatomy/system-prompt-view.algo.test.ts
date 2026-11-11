/**
 * Table test for `buildSystemPromptView`, `maskLocalPaths`, `partTitle`, `hasPromptSnapshot` and
 * `systemPromptViewToMarkdown` against the rows of
 * docs/knowledgebase/algorithms/system-prompt-view.md. The row's input key picks the function
 * (`view`, `mask`, `title`, `has`, `markdown`); the projection format is the doc's Examples prose.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  buildSystemPromptView,
  hasPromptSnapshot,
  maskLocalPaths,
  partTitle,
  systemPromptViewToMarkdown,
  type BuildSystemPromptViewInput,
  type SystemPromptView,
} from './system-prompt-view';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface ViewInput {
  view?: BuildSystemPromptViewInput;
  mask?: { text: string; repoRoot: string };
  title?: string;
  has?: Record<string, unknown>[];
  markdown?: BuildSystemPromptViewInput;
}

type ViewExpected = Record<string, unknown> | string | boolean;

/** Expands every `{"$fill": n, "start": s}` into `s` padded with `x` to n bytes (ASCII). */
function expandFills(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandFills);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$fill === 'number') {
      const start = typeof obj.start === 'string' ? obj.start : '';
      return start + 'x'.repeat(Math.max(0, obj.$fill - start.length));
    }
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, expandFills(v)]),
    );
  }
  return value;
}

/** Long display strings: compared only when the expected item gives them. */
const OPTIONAL_TEXT_KEYS = new Set(['text', 'description', 'schemaJson']);

function expectedItems(expected: unknown, key: string): unknown[] {
  if (expected === null || typeof expected !== 'object' || !(key in expected)) {
    return [];
  }
  const list: unknown = Reflect.get(expected, key);
  return Array.isArray(list) ? list : [];
}

function hasKey(item: unknown, key: string): boolean {
  return item !== null && typeof item === 'object' && key in item;
}

/** Drops each optional text key the matching expected item does not list. */
function trimItem(item: object, wanted: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(item).filter(
      ([k]) => !OPTIONAL_TEXT_KEYS.has(k) || hasKey(wanted, k),
    ),
  );
}

/** The projection: only the top-level keys the row lists, each compared in full. */
function project(
  view: SystemPromptView,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const full: Record<string, unknown> = {
    prompt: {
      ...view.prompt,
      parts: view.prompt.parts.map((p, i) =>
        trimItem(p, expectedItems(expected.prompt, 'parts')[i]),
      ),
    },
    tools: {
      ...view.tools,
      items: view.tools.items.map((t, i) => {
        const { share, ...rest } = t;
        return {
          ...trimItem(rest, expectedItems(expected.tools, 'items')[i]),
          sharePct: Math.round(share * 10) / 10,
        };
      }),
    },
    flags: view.flags,
    totals: view.totals,
    error: view.error,
  };
  return Object.fromEntries(Object.keys(expected).map((k) => [k, full[k]]));
}

const rows = loader.loadExamples<ViewInput, ViewExpected>('system-prompt-view');

it.each(rows)('$id', ({ input: raw, expected }) => {
  // `$fill` placeholders expand to strings, so the shape stays the documented ViewInput.
  const input = expandFills(raw) as ViewInput;
  if (input.mask) {
    expect(maskLocalPaths(input.mask.text, input.mask.repoRoot)).toBe(expected);
    return;
  }
  if (input.title !== undefined) {
    expect(partTitle(input.title)).toBe(expected);
    return;
  }
  if (input.has) {
    expect(hasPromptSnapshot(input.has)).toBe(expected);
    return;
  }
  if (input.markdown) {
    expect(
      systemPromptViewToMarkdown(buildSystemPromptView(input.markdown)),
    ).toBe(expected);
    return;
  }
  if (!input.view || typeof expected !== 'object') {
    throw new Error('row has no view/mask/title/has/markdown input');
  }
  const view = buildSystemPromptView(input.view);
  expect(project(view, expected)).toEqual(expected);
});
