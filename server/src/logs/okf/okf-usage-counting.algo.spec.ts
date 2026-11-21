/**
 * Table test for docs/knowledgebase/algorithms/okf-usage-counting.md, server side. A row's `kind`
 * picks the function (see the doc's Examples preamble): `view` → `buildOkfUsageView`,
 * `teamFilter` → `applyOkfTeamFilter` then `buildOkfUsageView` with `teamView`, `reference` →
 * `pickReferenceRoot`. Rows of kind `format` belong to the client test
 * (`client/src/viewer/lib/okf/okf-format.algo.test.ts`) and are skipped here.
 *
 * Spec shorthands: a file is a path string or `{path, ignored?, meta?}`; a bundle defaults to
 * index `<root>/index.md` and `ignored: false`; files to `ignored: false`, `size: 1` and a dummy
 * hash; a node to `ctxTokens: 0`, `ctxCost: null`. None of the defaults enters a rule.
 *
 * `expected` is a subset of the response: every listed key must match, arrays element by element
 * and with the same length, numbers within the row's `tol` (default: exact); `null` also
 * matches an absent key (`supersededBy`).
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import type { OkfUsageRow } from './okf-paths';
import type {
  OkfSnapshotBody,
  OkfSnapshotBundle,
  OkfSnapshotFile,
  OkfSnapshotFileMeta,
} from './okf-snapshot';
import { applyOkfTeamFilter } from './okf-team-filter';
import {
  buildOkfUsageView,
  pickReferenceRoot,
  type OkfCountingNode,
} from './okf-usage-counting';
import type { OkfUsageUnit } from './okf-usage.types';

type FileSpec =
  | string
  | { path: string; ignored?: boolean; meta?: OkfSnapshotFileMeta };

interface BundleSpec {
  root: string;
  index?: string;
  ignored?: boolean;
  okfVersion?: string;
  files: FileSpec[];
}

interface NodeSpec {
  unit: number;
  rows: OkfUsageRow[];
  ctxTokens?: number;
  ctxCost?: number | null;
}

interface TreeSpec {
  rootId: number;
  snapshot: { bundles: BundleSpec[] } | null;
  nodes: Omit<NodeSpec, 'unit'>[];
}

interface RootSpec {
  id: number;
  startTime: string;
  branch: string | null;
}

interface CountingRowInput {
  unit?: OkfUsageUnit;
  bundles?: BundleSpec[] | null;
  snapshot?: { branch: string | null; takenAt: string } | null;
  bundle?: string;
  nodes?: NodeSpec[];
  trees?: TreeSpec[];
  unitsTotal?: number;
  spend?: number | null;
  refMs?: number;
  roots?: RootSpec[];
}

const DUMMY_HASH = '0'.repeat(64);

function toFile(spec: FileSpec): OkfSnapshotFile {
  const s = typeof spec === 'string' ? { path: spec } : spec;
  return {
    path: s.path,
    ignored: s.ignored ?? false,
    size: 1,
    hash: DUMMY_HASH,
    ...(s.meta !== undefined ? { meta: s.meta } : {}),
  };
}

function toBundle(spec: BundleSpec): OkfSnapshotBundle {
  return {
    root: spec.root,
    index: spec.index ?? `${spec.root}/index.md`,
    ignored: spec.ignored ?? false,
    files: spec.files.map(toFile),
    ...(spec.okfVersion !== undefined ? { okfVersion: spec.okfVersion } : {}),
  };
}

function toBundles(
  specs: BundleSpec[] | null | undefined,
): OkfSnapshotBundle[] | null {
  return specs === null || specs === undefined ? null : specs.map(toBundle);
}

function toNode(spec: NodeSpec): OkfCountingNode {
  return {
    unit: spec.unit,
    rows: spec.rows,
    ctxTokens: spec.ctxTokens ?? 0,
    ctxCost: spec.ctxCost ?? null,
  };
}

function toSnapshotBody(
  spec: TreeSpec['snapshot'],
  rootId: number,
): OkfSnapshotBody | null {
  if (spec === null) return null;
  return {
    okfSnapshotId: `snapshot-${rootId}`,
    schemaVersion: 1,
    bundles: spec.bundles.map(toBundle),
  };
}

function view(
  input: CountingRowInput,
  bundles: OkfSnapshotBundle[] | null,
  nodes: OkfCountingNode[],
  teamView = false,
) {
  return buildOkfUsageView({
    unit: input.unit ?? 'sessions',
    bundles,
    snapshot: input.snapshot ?? null,
    ...(input.bundle !== undefined ? { bundle: input.bundle } : {}),
    nodes,
    unitsTotal: input.unitsTotal ?? 0,
    spend: input.spend ?? null,
    refMs: input.refMs ?? 0,
    teamView,
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Subset match: every key of `expected`, arrays whole, numbers within `tol`. */
function expectSubset(
  actual: unknown,
  expected: unknown,
  tol: number,
  at: string,
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(
        `${at}: expected an array, got ${JSON.stringify(actual)}`,
      );
    }
    if (actual.length !== expected.length) {
      throw new Error(
        `${at}: expected ${expected.length} items, got ${actual.length}: ${JSON.stringify(actual)}`,
      );
    }
    expected.forEach((item, i) =>
      expectSubset(actual[i], item, tol, `${at}[${i}]`),
    );
    return;
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      throw new Error(
        `${at}: expected an object, got ${JSON.stringify(actual)}`,
      );
    }
    for (const [key, value] of Object.entries(expected)) {
      expectSubset(actual[key], value, tol, `${at}.${key}`);
    }
    return;
  }
  if (typeof expected === 'number' && typeof actual === 'number' && tol > 0) {
    if (Math.abs(actual - expected) > tol) {
      throw new Error(`${at}: expected ${expected} ± ${tol}, got ${actual}`);
    }
    return;
  }
  if (expected === null && actual === undefined) return;
  if (actual !== expected) {
    throw new Error(
      `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const rows = loadExamples<CountingRowInput, unknown>(
  'okf-usage-counting',
).filter((row) => row.kind !== 'format');

it.each(rows)('$id', ({ kind, input, expected, tol }) => {
  const tolerance = typeof tol === 'number' ? tol : 0;
  switch (kind) {
    case 'view': {
      const result = view(
        input,
        toBundles(input.bundles),
        (input.nodes ?? []).map(toNode),
      );
      expectSubset(result, expected, tolerance, 'view');
      break;
    }
    case 'teamFilter': {
      const trees = (input.trees ?? []).map((t) => ({
        rootId: t.rootId,
        snapshot: toSnapshotBody(t.snapshot, t.rootId),
        nodes: t.nodes.map((n) => toNode({ ...n, unit: t.rootId })),
      }));
      const filtered = applyOkfTeamFilter(trees, toBundles(input.bundles));
      const result = view(
        input,
        filtered.bundles,
        filtered.trees.flatMap((t) => t.nodes),
        true,
      );
      expectSubset(result, expected, tolerance, 'view');
      break;
    }
    case 'reference': {
      const picked = pickReferenceRoot(input.roots ?? []);
      expect({ id: picked === null ? null : picked.id }).toEqual(expected);
      break;
    }
    default:
      throw new Error(`unknown kind ${String(kind)}`);
  }
});
