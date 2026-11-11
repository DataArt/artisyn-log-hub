// Adapter from the "System context anatomy" result to the `@loghub/recommendations` input
// (`StartupFacts`). Pure: no DOM, no network. Rules: impl-plan DD 11 of the
// 2026-11-11-sysctx-recommendations task and docs/knowledgebase/algorithms/startup-recommendations.md.
// A missing data source (old hook, old Claude Code) yields an empty or `null` field, so the
// matching catalog entry simply does not match.

import type { StartupFacts, StartupMcpServer } from '@loghub/recommendations';
import type { HarnessSnapshot } from '../../../../api';
import {
  mcpKey,
  type AnatomyPartition,
  type AnatomyRow,
  type SysctxAnatomy,
} from './sysctx-anatomy';
import type { AnatomyPartitionKind } from './sysctx-anatomy-constants';

export interface BuildStartupFactsInput {
  anatomy: SysctxAnatomy;
  snapshot: HarnessSnapshot | null;
  /** The raw main transcript lines. */
  main: Record<string, unknown>[];
}

export interface BuildStartupFactsResult {
  facts: StartupFacts;
  /** Claude Code version of the first `main` line that carries one (FR-6), else `null`. */
  claudeVersion: string | null;
}

function partition(
  anatomy: SysctxAnatomy,
  kind: AnatomyPartitionKind,
): AnatomyPartition | undefined {
  return anatomy.partitions.find((p) => p.kind === kind);
}

function rowsOf(
  anatomy: SysctxAnatomy,
  kind: AnatomyPartitionKind,
): AnatomyRow[] {
  return partition(anatomy, kind)?.rows ?? [];
}

function firstVersion(main: Record<string, unknown>[]): string | null {
  for (const line of main) {
    if (typeof line.version === 'string' && line.version.length > 0) {
      return line.version;
    }
  }
  return null;
}

function buildMcpServers(
  anatomy: SysctxAnatomy,
  snapshot: HarnessSnapshot | null,
): StartupMcpServer[] {
  const snap = new Map<
    string,
    {
      name: string;
      configSource: 'project' | 'user' | null;
      connected: boolean | undefined;
    }
  >();
  for (const s of snapshot?.mcpServers ?? []) {
    if (typeof s.name !== 'string') continue;
    const key = mcpKey(s.name);
    if (snap.has(key)) continue;
    snap.set(key, {
      name: s.name,
      configSource:
        s.configSource === 'project' || s.configSource === 'user'
          ? s.configSource
          : null,
      connected: s.connected,
    });
  }

  const seen = new Set<string>();
  const out: StartupMcpServer[] = [];
  for (const r of rowsOf(anatomy, 'mcp-server')) {
    const s = snap.get(r.key);
    seen.add(r.key);
    out.push({
      key: r.key,
      label: r.label,
      names: r.names ?? [],
      namesBytes: r.namesBytes ?? 0,
      instrBytes: r.instrBytes ?? 0,
      failed: r.status === 'failed' || s?.connected === false,
      configSource: s ? s.configSource : null,
    });
  }
  // Snapshot-only servers: kept only when they failed (nothing to measure otherwise).
  for (const [key, s] of snap) {
    if (seen.has(key) || s.connected !== false) continue;
    out.push({
      key,
      label: s.name,
      names: [],
      namesBytes: 0,
      instrBytes: 0,
      failed: true,
      configSource: s.configSource,
    });
  }
  return out;
}

/** Turns the anatomy, the harness snapshot and `main` into the matcher's `StartupFacts`. */
export function buildStartupFacts(
  input: BuildStartupFactsInput,
): BuildStartupFactsResult {
  const { anatomy, snapshot, main } = input;
  const facts: StartupFacts = {
    cpt: anatomy.cpt,
    denominator: anatomy.denominator,
    tools:
      anatomy.toolSource !== null
        ? rowsOf(anatomy, 'tool-definitions').map((r) => ({
            name: r.label,
            bytes: r.bytes,
          }))
        : null,
    snapshot: snapshot !== null,
    mcpServers: buildMcpServers(anatomy, snapshot),
    skills: rowsOf(anatomy, 'skills').map((r) => ({
      name: r.label,
      bytes: r.bytes,
      source: r.source,
      pluginId: r.pluginId ?? null,
    })),
    memoryBytes: partition(anatomy, 'memory')?.bytes ?? 0,
    instructionFiles: rowsOf(anatomy, 'instruction-file')
      .filter((r) => r.onDemand !== true)
      .map((r) => ({
        path: r.path ?? r.label,
        bytes: r.bytes,
        source: r.source === 'user' ? ('user' as const) : ('project' as const),
      })),
    agentTypes: rowsOf(anatomy, 'agent-types').map((r) => ({
      name: r.label,
      bytes: r.bytes,
    })),
  };
  return { facts, claudeVersion: firstVersion(main) };
}
