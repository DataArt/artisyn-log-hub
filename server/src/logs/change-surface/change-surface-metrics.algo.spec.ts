/**
 * Table test for docs/knowledgebase/algorithms/change-surface-concentration.md. The doc's input
 * forms (`folders`, `facts`, `outside`, `band`) are turned into `ChangedPathFact` rows here; every
 * number lives in the doc. The `facts` rows also run against `mergeFileRows`, the tab's file-list
 * twin of the merge rule.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import {
  computeChangeSurface,
  concentrationBand,
} from './change-surface-metrics';
import { mergeFileRows } from './change-surface.service';
import type { ChangeKind, ChangedPathFact } from './change-surface.types';
import type { ComputeChangeSurfaceOptions } from './change-surface-metrics';

interface FactSpec {
  path: string;
  added: number;
  removed: number;
  kind: ChangeKind;
  /** A fact whose folder and module keys were never filled in. */
  noKeys?: true;
}

type SurfaceInput =
  | { band: number | null }
  | {
      folders?: Record<string, number>;
      facts?: FactSpec[];
      options?: ComputeChangeSurfaceOptions;
      outside?: {
        path: string;
        added: number;
        removed?: number;
        unrooted?: true;
      }[];
    };

/** One in-repo row at the repo-relative `relPath` (`a/b/f.ts`; a root file has no folder). */
function inRepoFact(
  relPath: string,
  added: number,
  removed: number,
  changeKind: ChangeKind,
): ChangedPathFact {
  const segments = relPath.split('/');
  const folderSegments = segments.slice(0, -1);
  const folder = folderSegments.length === 0 ? '.' : folderSegments.join('/');
  const fileName = segments[segments.length - 1];
  const dot = fileName.lastIndexOf('.');
  return {
    pathKey: relPath.toLowerCase(),
    rawPath: `/repo/${relPath}`,
    relPath,
    relPathKey: relPath.toLowerCase(),
    folder,
    folderKey: folder.toLowerCase(),
    topModuleKey:
      folderSegments.length === 0 ? '.' : folderSegments[0].toLowerCase(),
    depth: folderSegments.length,
    fileKind: 'source',
    extension: dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase(),
    outsideRepo: false,
    changeKind,
    editCalls: 1,
    diffCoveredCalls: 1,
    linesAdded: added,
    linesRemoved: removed,
  };
}

/**
 * An excluded row: outside the repo, or (`unrooted`) written before any repo root was known, so it
 * has no repo-relative path but is not marked outside.
 */
function outsideFact(
  path: string,
  added: number,
  removed: number,
  unrooted: boolean,
): ChangedPathFact {
  return {
    pathKey: path.toLowerCase(),
    rawPath: path,
    relPath: null,
    relPathKey: null,
    folder: null,
    folderKey: null,
    topModuleKey: null,
    depth: null,
    fileKind: null,
    extension: null,
    outsideRepo: !unrooted,
    changeKind: 'modified',
    editCalls: 1,
    diffCoveredCalls: 1,
    linesAdded: added,
    linesRemoved: removed,
  };
}

function toFacts(
  input: Exclude<SurfaceInput, { band: number | null }>,
): ChangedPathFact[] {
  const facts: ChangedPathFact[] = [];
  for (const [folder, count] of Object.entries(input.folders ?? {})) {
    for (let i = 1; i <= count; i += 1) {
      const relPath = folder === '.' ? `f${i}.ts` : `${folder}/f${i}.ts`;
      facts.push(inRepoFact(relPath, 0, 0, 'modified'));
    }
  }
  for (const spec of input.facts ?? []) {
    const fact = inRepoFact(spec.path, spec.added, spec.removed, spec.kind);
    facts.push(
      spec.noKeys
        ? { ...fact, folder: null, folderKey: null, topModuleKey: null }
        : fact,
    );
  }
  for (const spec of input.outside ?? []) {
    facts.push(
      outsideFact(
        spec.path,
        spec.added,
        spec.removed ?? 0,
        spec.unrooted === true,
      ),
    );
  }
  return facts;
}

const rows = loadExamples<SurfaceInput, Record<string, unknown>>(
  'change-surface-concentration',
);

it.each(rows)('$id', ({ input, expected }) => {
  if ('band' in input) {
    expect({ band: concentrationBand(input.band) }).toEqual(expected);
    return;
  }
  expect(computeChangeSurface(toFacts(input), input.options)).toEqual(
    expect.objectContaining(expected),
  );
});

/** The merge-rule fields `mergeFileRows` can answer for, from its in-repo file rows. */
const MERGE_KEYS = [
  'changedFiles',
  'byChangeKind',
  'linesAdded',
  'linesRemoved',
] as const;

// `facts` rows that pin at least one field the file list can answer for.
const factRows = rows.filter(
  (row) =>
    'facts' in row.input &&
    row.input.facts !== undefined &&
    MERGE_KEYS.some((key) => key in row.expected),
);

describe('mergeFileRows (twin of rule 1)', () => {
  it.each(factRows)('$id', ({ input, expected }) => {
    if ('band' in input) throw new Error('band row in factRows');
    const files = mergeFileRows(toFacts(input)).filter((f) => !f.outsideRepo);
    const actual: Record<string, unknown> = {
      changedFiles: files.length,
      byChangeKind: {
        added: files.filter((f) => f.changeKind === 'added').length,
        modified: files.filter((f) => f.changeKind === 'modified').length,
        deleted: files.filter((f) => f.changeKind === 'deleted').length,
      },
      linesAdded: files.reduce((sum, f) => sum + f.linesAdded, 0),
      linesRemoved: files.reduce((sum, f) => sum + f.linesRemoved, 0),
    };
    for (const key of MERGE_KEYS.filter((k) => k in expected)) {
      expect({ [key]: actual[key] }).toEqual({ [key]: expected[key] });
    }
  });
});
