/**
 * Table test for docs/knowledgebase/algorithms/okf-verdict.md: `session` rows run
 * `computeSessionVerdict` (and `agentEntry` per node when `expected.entries` is given), `repo` rows
 * run `computeRepoVerdict`, after `applyOkfTeamFilter` when the row says `"team": true`. The input
 * shorthand (bundle file counts, row defaults, `count` expansion) is the one the doc's Examples
 * preamble defines. A row's raw `input.okf` goes through `resolveOkfThresholds` (absent = the
 * defaults); `input.latestFiles` and a session's `files` feed the FR-10 hash maps.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import type { OkfSnapshotBundle } from './okf-snapshot';
import { resolveOkfThresholds } from './okf-thresholds';
import type {
  OkfAgentEntry,
  OkfOp,
  OkfVerdict,
  OkfVerdictCheckStatus,
} from './okf-usage.types';
import { applyOkfTeamFilter } from './okf-usage-tree';
import {
  agentEntry,
  computeRepoVerdict,
  computeSessionVerdict,
  type OkfVerdictBundle,
  type OkfVerdictFileHash,
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
  rangedCalls?: number;
  rangedBytes?: number;
  searchHits?: number;
  nodeId?: string;
}

/** `path → {hash, size}` of one snapshot (FR-10, DD-18a). */
type FilesSpec = Record<string, OkfVerdictFileHash>;

interface VerdictInput {
  bundles: BundleSpec[] | null;
  nodes?: { agentId: string; count?: number; rows: RowSpec[] }[];
  sessions?: {
    count?: number;
    hasSnapshot: boolean;
    rows: RowSpec[];
    files?: FilesSpec;
  }[];
  /** Raw stored `okf` section; resolved field by field over the defaults. */
  okf?: unknown;
  latestFiles?: FilesSpec;
}

interface ExpectedFinding {
  rule: string;
  severity: string;
  params: Record<string, string | number>;
  stale?: { sessions: number; total: number; oldSize: number | null };
  removed?: boolean;
}

interface ExpectedCheck {
  rule: string;
  status: OkfVerdictCheckStatus;
  params: Record<string, string | number | null>;
}

interface VerdictExpected {
  verdict:
    | (Omit<OkfVerdict, 'findings' | 'checks'> & {
        findings: ExpectedFinding[];
        upkeepOnlySessions?: number;
        /** When given: the checks in order, rule + status exact, the listed params compared. */
        checks?: ExpectedCheck[];
      })
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
        ? Array.from({ length: spec.files + 1 }, (_, i) => ({
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
    ...(r.rangedCalls !== undefined ? { rangedCalls: r.rangedCalls } : {}),
    ...(r.rangedBytes !== undefined ? { rangedBytes: r.rangedBytes } : {}),
    ...(r.searchHits !== undefined ? { searchHits: r.searchHits } : {}),
    ...(r.nodeId !== undefined ? { nodeId: r.nodeId } : {}),
  }));
}

function toFileMap(spec: FilesSpec): Map<string, OkfVerdictFileHash> {
  return new Map(Object.entries(spec));
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
  const { findings, checks, ...head } = expected;
  const {
    findings: actualFindings,
    checks: actualChecks,
    ...actualHead
  } = actual!;
  expect(actualHead).toEqual(head);
  // Every verdict carries one check per structure rule of its level.
  expect(actualChecks).toBeDefined();
  if (checks !== undefined) {
    expect(actualChecks!.map((c) => [c.rule, c.status])).toEqual(
      checks.map((c) => [c.rule, c.status]),
    );
    checks.forEach((want, i) => {
      const got = actualChecks![i].params;
      for (const [key, value] of Object.entries(want.params)) {
        if (typeof value === 'number' && !Number.isInteger(value)) {
          expect(Math.abs(Number(got[key]) - value)).toBeLessThan(
            SHARE_TOLERANCE,
          );
        } else {
          expect(got[key]).toBe(value);
        }
      }
    });
  }
  expect(actualFindings).toHaveLength(findings.length);
  findings.forEach((want, i) => {
    const got = actualFindings[i];
    expect(got.rule).toBe(want.rule);
    expect(got.severity).toBe(want.severity);
    expect(got.stale).toEqual(want.stale);
    expect(got.removed ?? false).toBe(want.removed ?? false);
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
  const thresholds = resolveOkfThresholds(input.okf);

  if (row.kind === 'session') {
    const nodes = expand(input.nodes ?? [], (n, _k, i) =>
      i === undefined ? n.agentId : `${n.agentId}-${i}`,
    ).map(({ item, name }) => ({ agentId: name, rows: toRows(item.rows) }));
    expectVerdict(
      computeSessionVerdict({ nodes, bundles }, thresholds),
      expected.verdict,
    );
    if (expected.entries !== undefined) {
      expect(nodes.map((n) => agentEntry(n.rows, bundles))).toEqual(
        expected.entries,
      );
    }
    return;
  }

  expect(row.kind).toBe('repo');
  const expanded = expand(
    input.sessions ?? [],
    (_s, k, i) => `s${k}-${i ?? 0}`,
  );
  let sessions: RepoVerdictSession[] = expanded.map(({ item, name }) => ({
    sessionId: name,
    hasSnapshot: item.hasSnapshot,
    rows: toRows(item.rows),
  }));
  const sessionFiles = new Map<string, Map<string, OkfVerdictFileHash>>();
  for (const { item, name } of expanded) {
    if (item.files !== undefined) sessionFiles.set(name, toFileMap(item.files));
  }
  const hashMaps =
    input.latestFiles !== undefined
      ? { sessionFiles, latestFiles: toFileMap(input.latestFiles) }
      : {};
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
    computeRepoVerdict(
      { sessions, bundles: repoBundles, ...hashMaps },
      thresholds,
    ),
    expected.verdict,
  );
});
