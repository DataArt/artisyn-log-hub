/**
 * Per-article details of the session OKF tree (2026-11-03 OKF value signals): which agent was
 * shown which new code pointers in an article, and which agents searched an article's code area
 * without opening it (routing misses). Built from the session route's `agents[]` as sent — the
 * server owns every count; this only regroups the per-agent lists by article path.
 */
import type {
  OkfAgent,
  OkfFinding,
  OkfTreeNode,
} from '../../../../../models/repositories';
import { okfAgentLabel } from './okf-tree';

export interface OkfAgentPointers {
  agentId: string;
  label: string;
  pointers: { pointer: string; followed: boolean }[];
  /** Paths the agent's prompt already named (whole agent, not per article). */
  promptNamedPaths: number;
}

export interface OkfAgentMiss {
  agentId: string;
  label: string;
  article: string;
  searches: number;
  patterns: string[];
}

export interface OkfSessionDetails {
  /** Article path → agents that were shown new pointers in it. */
  pointers: Map<string, OkfAgentPointers[]>;
  /** Article path → agents that missed it. */
  misses: Map<string, OkfAgentMiss[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildOkfSessionDetails(
  agents: readonly OkfAgent[],
  rootSessionId: string,
): OkfSessionDetails {
  const pointers = new Map<string, OkfAgentPointers[]>();
  const misses = new Map<string, OkfAgentMiss[]>();
  for (const a of agents) {
    const label = okfAgentLabel(a.id, rootSessionId);
    const byArticle = new Map<
      string,
      { pointer: string; followed: boolean }[]
    >();
    for (const p of a.pointers ?? []) {
      push(byArticle, p.article, { pointer: p.pointer, followed: p.followed });
    }
    for (const [article, list] of byArticle) {
      push(pointers, article, {
        agentId: a.id,
        label,
        pointers: list,
        promptNamedPaths: a.promptNamedPaths ?? 0,
      });
    }
    for (const m of a.routingMisses ?? []) {
      push(misses, m.article, {
        agentId: a.id,
        label,
        article: m.article,
        searches: m.searches,
        patterns: m.patterns,
      });
    }
  }
  return { pointers, misses };
}

/** File paths present in the tree, so misses on articles outside it can be listed apart. */
export function okfTreeFilePaths(nodes: readonly OkfTreeNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: OkfTreeNode): void => {
    if (n.kind === 'file') out.add(n.path);
    n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** Read calls with a line range per file path (FR-4), for the Read top 5 `§` chips. */
export function okfRangedCallsByPath(
  nodes: readonly OkfTreeNode[],
): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (n: OkfTreeNode): void => {
    if (n.kind === 'file' && (n.rangedCalls ?? 0) > 0) {
      out.set(n.path, n.rangedCalls ?? 0);
    }
    n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** A routing miss as a finding, so `okfActionText` gives its action line (DD-26). */
export function okfMissFinding(miss: OkfAgentMiss): OkfFinding {
  return {
    rule: 'routing_miss',
    severity: 'info',
    params: {
      file: miss.article,
      area: 'its code area',
      patterns: miss.patterns.join(', ') || '—',
    },
    node: { bundle: null, path: miss.article },
  };
}
