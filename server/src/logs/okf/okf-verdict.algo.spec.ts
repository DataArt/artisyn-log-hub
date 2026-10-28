/**
 * Table test for docs/knowledgebase/algorithms/okf-verdict.md: `session` rows run
 * `computeSessionVerdict` (and `agentEntry` per node when `expected.entries` is given), `repo` rows
 * run `computeRepoVerdict`, after `applyOkfTeamFilter` when the row says `"team": true`. The input
 * shorthand (bundle file counts, row defaults, `count` expansion) is the one the doc's Examples
 * preamble defines.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import type { OkfSnapshotBundle } from './okf-snapshot';
import type { OkfAgentEntry, OkfOp, OkfVerdict } from './okf-usage.types';
import { applyOkfTeamFilter } from './okf-usage-tree';
import {
  agentEntry,
  computeRepoVerdict,
  computeSessionVerdict,
  type OkfVerdictBundle,
  type OkfVerdictRow,
  type RepoVerdictSession,
} from './okf-verdict';

interface FileSpec {
  path: string;
  size: number;
  ignored?: boolean;
}

interface BundleSpec {
  root: string;
  files: number | FileSpec[];
}

interface RowSpec {
  pathKey: string;
  op: OkfOp;
  bytes?: number;
  calls?: number;
  afterOwnEdit?: boolean;
  seq?: number;
}

interface VerdictInput {
  bundles: BundleSpec[] | null;
  nodes?: { agentId: string; count?: number; rows: RowSpec[] }[];
  sessions?: { count?: number; hasSnapshot: boolean; rows: RowSpec[] }[];
}

interface ExpectedFinding {
  rule: string;
  severity: string;
  params: Record<string, string | number>;
}

interface VerdictExpected {
  verdict:
    | (Omit<OkfVerdict, 'findings'> & { findings: ExpectedFinding[] })
    | null;
  entries?: (OkfAgentEntry | null)[];
}

const SHARE_TOLERANCE = 1e-9;

const rows = loadExamples<VerdictInput, VerdictExpected>('okf-verdict');

/** Bundles with their `ignored` flags (the snapshot shape the team filter reads). */
function toSnapshotBundles(specs: BundleSpec[]): OkfSnapshotBundle[] {
  return specs.map((spec) => {
    const index = `${spec.root}/index.md`;
    const files =
      typeof spec.files === 'number'
        ? Array.from({ length: spec.files }, (_, i) => ({
            path: i === 0 ? index : `${spec.root}/a${i}.md`,
            size: 1000,
            ignored: false,
            hash: '',
          }))
        : spec.files.map((f) => ({
            path: f.path,
            size: f.size,
            ignored: f.ignored === true,
            hash: '',
          }));
    return { root: spec.root, index, ignored: false, files };
  });
}

function toRows(specs: RowSpec[]): OkfVerdictRow[] {
  return specs.map((r, i) => ({
    pathKey: r.pathKey,
    op: r.op,
    afterOwnEdit: r.afterOwnEdit ?? false,
    bytes: r.bytes ?? 0,
    calls: r.calls ?? 1,
    seq: r.seq ?? i + 1,
  }));
}

/** Expands `count: N` into N copies, named `<name>-1` … `<name>-N`. */
function expand<T extends { count?: number }>(
  items: T[],
  name: (item: T, i: number, n: number | undefined) => string,
): { item: T; name: string }[] {
  return items.flatMap((item, k) =>
    item.count === undefined
      ? [{ item, name: name(item, k, undefined) }]
      : Array.from({ length: item.count }, (_, i) => ({
          item,
          name: name(item, k, i + 1),
        })),
  );
}

function expectVerdict(
  actual: OkfVerdict | null,
  expected: VerdictExpected['verdict'],
): void {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  const { findings, ...head } = expected;
  const { findings: actualFindings, ...actualHead } = actual!;
  expect(actualHead).toEqual(head);
  expect(actualFindings).toHaveLength(findings.length);
  findings.forEach((want, i) => {
    const got = actualFindings[i];
    expect(got.rule).toBe(want.rule);
    expect(got.severity).toBe(want.severity);
    for (const [key, value] of Object.entries(want.params)) {
      if (key === 'share' || key === 'ratio') {
        expect(Math.abs(Number(got.params[key]) - Number(value))).toBeLessThan(
          SHARE_TOLERANCE,
        );
      } else {
        expect(got.params[key]).toBe(value);
      }
    }
  });
}

it.each(rows)('$id', (row) => {
  const { input, expected } = row;
  const snapshotBundles =
    input.bundles === null ? null : toSnapshotBundles(input.bundles);
  const bundles: OkfVerdictBundle[] | null = snapshotBundles;

  if (row.kind === 'session') {
    const nodes = expand(input.nodes ?? [], (n, _k, i) =>
      i === undefined ? n.agentId : `${n.agentId}-${i}`,
    ).map(({ item, name }) => ({ agentId: name, rows: toRows(item.rows) }));
    expectVerdict(computeSessionVerdict({ nodes, bundles }), expected.verdict);
    if (expected.entries !== undefined) {
      expect(nodes.map((n) => agentEntry(n.rows, bundles))).toEqual(
        expected.entries,
      );
    }
    return;
  }

  expect(row.kind).toBe('repo');
  let sessions: RepoVerdictSession[] = expand(
    input.sessions ?? [],
    (_s, k, i) => `s${k}-${i ?? 0}`,
  ).map(({ item, name }) => ({
    sessionId: name,
    hasSnapshot: item.hasSnapshot,
    rows: toRows(item.rows),
  }));
  let repoBundles: OkfVerdictBundle[] | null = bundles;
  if (row.team === true) {
    const filtered = applyOkfTeamFilter(
      sessions.map((s) => ({
        session: s,
        snapshot:
          s.hasSnapshot && snapshotBundles !== null
            ? {
                okfSnapshotId: 'snap',
                schemaVersion: 1,
                bundles: snapshotBundles,
              }
            : null,
        nodes: [{ rows: s.rows }],
      })),
      snapshotBundles,
    );
    sessions = filtered.trees.map((t) => ({
      ...t.session,
      rows: t.nodes.flatMap((n) => n.rows),
    }));
    repoBundles = filtered.bundles;
  }
  expectVerdict(
    computeRepoVerdict({ sessions, bundles: repoBundles }),
    expected.verdict,
  );
});
