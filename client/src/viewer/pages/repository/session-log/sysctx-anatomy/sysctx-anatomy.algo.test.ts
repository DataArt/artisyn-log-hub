/**
 * Table test for `buildSysctxAnatomy`, `splitSkillListing` and `mcpKey` against the rows of
 * docs/knowledgebase/algorithms/sysctx-anatomy.md. Builder rows have `input.main`; helper rows
 * have `input.split` or `input.mcpKey`. The input/projection format is the doc's Examples prose.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type {
  HarnessSnapshot,
  HarnessSnapshotAgent,
  HarnessSnapshotFile,
  HarnessSnapshotMcpServer,
  HarnessSnapshotSkill,
} from '../../../../api';
import {
  buildSysctxAnatomy,
  mcpKey,
  splitSkillListing,
  type AnatomyRow,
  type SysctxAnatomy,
} from './sysctx-anatomy';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../../scripts/algo-docs/load-examples.cjs',
  );

/** The doc's partial snapshot: the fields a row gives; the test adds the rest. */
interface SnapshotSpec {
  skills?: (Pick<HarnessSnapshotSkill, 'name' | 'source' | 'path' | 'bytes'> &
    Partial<HarnessSnapshotSkill>)[];
  agents?: (Pick<HarnessSnapshotAgent, 'name' | 'path' | 'bytes'> &
    Partial<HarnessSnapshotAgent>)[];
  mcpServers?: HarnessSnapshotMcpServer[];
  systemContext?: {
    totalBytes: number;
    files: (Pick<HarnessSnapshotFile, 'path' | 'bytes'> &
      Partial<HarnessSnapshotFile>)[];
  } | null;
}

interface AnatomyInput {
  main?: Record<string, unknown>[];
  snapshot?: SnapshotSpec;
  repoRoot?: string;
  cpt?: number;
  split?: { content: string; names: string[] };
  mcpKey?: string;
}

type AnatomyExpected = Record<string, unknown>;

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

/** A doc's partial snapshot completed with the fields the doc says the test adds. */
function toSnapshot(spec: SnapshotSpec): HarnessSnapshot {
  const sc = spec.systemContext;
  return {
    snapshotId: 'test',
    schemaVersion: 1,
    perToolDetailSupported: false,
    skills: (spec.skills ?? []).map((s) => ({
      kind: 'skill',
      description: '',
      body: '',
      contentHash: '',
      ...s,
    })),
    agents: (spec.agents ?? []).map((a) => ({
      description: '',
      body: '',
      contentHash: '',
      source: 'project',
      ...a,
    })),
    mcpServers: spec.mcpServers ?? [],
    systemContext: sc
      ? {
          totalBytes: sc.totalBytes,
          files: sc.files.map((f) => ({ contentHash: '', ...f })),
        }
      : null,
  };
}

const pct = (share: number): number => Math.round(share * 1000) / 10;

function projectRow(row: AnatomyRow): Record<string, unknown> {
  const { share, ...rest } = row;
  return { ...rest, sharePct: pct(share) };
}

function project(a: SysctxAnatomy): Record<string, unknown> {
  return {
    total: a.total,
    attributed: a.attributed,
    internals: a.internals,
    overBy: a.overBy,
    denominator: a.denominator,
    cpt: a.cpt,
    flags: a.flags,
    kinds: a.partitions.map((p) => p.kind),
    partitions: Object.fromEntries(
      a.partitions.map((p) => [
        p.kind,
        {
          bytes: p.bytes,
          tokens: p.tokens,
          sharePct: pct(p.share),
          ...(p.count !== undefined && { count: p.count }),
        },
      ]),
    ),
    rows: Object.fromEntries(
      a.partitions.map((p) => [p.kind, p.rows.map(projectRow)]),
    ),
  };
}

const rows = loader.loadExamples<AnatomyInput, AnatomyExpected>(
  'sysctx-anatomy',
);

it.each(rows)('$id', ({ input, expected }) => {
  if (input.split) {
    const sizes = splitSkillListing(input.split.content, input.split.names);
    expect({ sizes: Object.fromEntries(sizes) }).toEqual(expected);
    return;
  }
  if (input.mcpKey !== undefined) {
    expect({ key: mcpKey(input.mcpKey) }).toEqual(expected);
    return;
  }
  // `$fill` placeholders expand to strings, so the shape stays the documented AnatomyInput.
  const expanded = expandFills(input) as AnatomyInput;
  const anatomy = buildSysctxAnatomy({
    main: expanded.main ?? [],
    snapshot: expanded.snapshot ? toSnapshot(expanded.snapshot) : null,
    repoRoot: expanded.repoRoot ?? '',
    ...(expanded.cpt !== undefined && { charsPerToken: expanded.cpt }),
  });
  expect(project(anatomy)).toMatchObject(expected);
});
