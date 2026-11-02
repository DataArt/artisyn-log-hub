/**
 * Table test for `matchNavFilter` against the rows of
 * docs/knowledgebase/algorithms/nav-filter-match.md. Each row carries the tree as compact doc
 * nodes and the filter query; the whole result is compared.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { matchNavFilter, type NavFilterResult, type NavNode } from './nav-tree';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface DocNode {
  id: string;
  label: string;
  synonyms?: string[];
  description?: string;
  children?: DocNode[];
}

interface FilterInput {
  query: string;
  nodes: DocNode[];
}

/** A doc node as a map node: with `children` a container, otherwise a leaf. */
function toNode(spec: DocNode): NavNode {
  const base = {
    id: spec.id,
    label: spec.label,
    description: spec.description ?? '',
    synonyms: spec.synonyms ?? [],
  };
  return spec.children
    ? {
        ...base,
        kind: 'container',
        icon: 'group',
        children: spec.children.map(toNode),
      }
    : { ...base, kind: 'leaf', icon: 'tab' };
}

const rows = loader.loadExamples<FilterInput, NavFilterResult>(
  'nav-filter-match',
);

it.each(rows)('$id', ({ input, expected }) => {
  expect(matchNavFilter(input.nodes.map(toNode), input.query)).toEqual(
    expected,
  );
});
