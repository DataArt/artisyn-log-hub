/**
 * OKF verdict strings (impl-plan DD-47), shared by the session and repo OKF tabs.
 *
 * The server sends rule ids + params only; every human-readable sentence is built here. Share
 * and ratio params are fractions 0-1 and render as whole percents; byte params go through the
 * shared byte formatter. A rule id this client does not know (a newer server) renders as the id
 * plus its raw params, never as an empty line.
 */
import type {
  OkfAgentEntry,
  OkfFinding,
  OkfFindingSeverity,
  OkfQualifier,
  OkfVerdict,
  OkfVerdictLevel,
} from '../../../models/repositories';
import { formatBytes } from '../format';

const LEVEL_LABELS: Record<OkfVerdictLevel, string> = {
  ok: 'OK',
  fix: 'Something to fix',
  mess: 'Mess',
  kb_not_used: 'KB not used',
  not_enough_data: 'Not enough data',
};

const ENTRY_LABELS: Record<OkfAgentEntry, string> = {
  index: '✓ index',
  search: 'grep',
  given: 'given',
};

/** Badge text of a verdict level; an unknown level (newer server) is shown as is. */
export function levelLabel(level: OkfVerdictLevel): string {
  return (LEVEL_LABELS as Record<string, string | undefined>)[level] ?? level;
}

/**
 * Chip text of a verdict qualifier. The repo route carries `partialData` counts on the verdict;
 * without them (session route) the session wording is used.
 */
export function qualifierLabel(
  qualifier: OkfQualifier,
  verdict?: Pick<OkfVerdict, 'partialData'> | null,
): string {
  if (qualifier !== 'partial_data') return String(qualifier);
  const pd = verdict?.partialData;
  if (pd) {
    return `partial data — ${pd.withoutSnapshot} of ${pd.total} sessions without a snapshot`;
  }
  return 'partial data — no KB snapshot';
}

/** Chip text for how an agent reached the KB. */
export function entryLabel(entry: OkfAgentEntry): string {
  return (ENTRY_LABELS as Record<string, string | undefined>)[entry] ?? entry;
}

function num(v: string | number | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function str(v: string | number | undefined): string {
  return v === undefined ? '' : String(v);
}

/** A fraction 0-1 as a whole percent number (no `%` sign). */
function pct(v: string | number | undefined): number {
  return Math.round(num(v) * 100);
}

function rawParams(params: Record<string, string | number>): string {
  const parts = Object.entries(params).map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** The article a finding is about: `file` (value-signal rules), else the finding node's path. */
function findingFile(finding: OkfFinding): string {
  return str(finding.params?.file) || finding.node?.path || '';
}

const SEVERITY_LABELS: Record<OkfFindingSeverity, string> = {
  fix: 'fix',
  mess: 'mess',
  info: 'info',
};

/**
 * Chip text of a finding severity. `info` findings are listed but never change the verdict
 * level; an unknown severity (newer server) is shown as is.
 */
export function severityLabel(severity: OkfFindingSeverity): string {
  return (
    (SEVERITY_LABELS as Record<string, string | undefined>)[severity] ??
    severity
  );
}

/** True for a finding that is shown but never changes the verdict level. */
export function isInfoFinding(finding: OkfFinding): boolean {
  return finding.severity === 'info';
}

/** One "Why" line of the verdict card. */
export function formatOkfFinding(finding: OkfFinding): string {
  const p = finding.params ?? {};
  switch (finding.rule) {
    case 'session_share':
      return `agent ${str(p.agentId).slice(0, 4)} read ${pct(p.share)}% of ${str(p.bundle)} files (${num(p.read)} of ${num(p.total)})`;
    case 'always_read':
      return `${str(p.path)} is read in ${num(p.sessions)} of ${num(p.kbSessions)} KB sessions (${pct(p.share)}%) — its key facts probably belong in index.md/CLAUDE.md, or it should be split`;
    case 'kb_flood':
      return `${str(p.bundle)}: in ${num(p.sessions)} sessions an agent read more than 25% of its files (${pct(p.share)}% of the sessions that used it)`;
    case 'coarse_article':
      return `${str(p.path)} (${formatBytes(num(p.size))}) is read in ${num(p.sessions)} sessions, ~${formatBytes(num(p.avgReadBytes))} per read (${pct(p.ratio)}%) — split it or add section pointers`;
    // 2026-11-03 OKF value signals.
    case 'routing_miss':
      return `routing miss: ${num(p.agents)} of ${num(p.areaAgents)} agents searched ${str(p.area)} without opening ${findingFile(finding)}`;
    case 'searched_after':
      return `searched after reading: ${num(p.agents)} agents made ${num(p.searches)} searches in the area of ${findingFile(finding)} after reading it`;
    case 'dead_pointers': {
      const notFound = num(p.notFound);
      return `dead pointers: ${num(p.dead)} pointers in ${findingFile(finding)} were shown but never followed${notFound > 0 ? ` (${notFound} of them: path not found in any session)` : ''}`;
    }
    case 'catalog':
      return `catalog: ${findingFile(finding)} points to ${num(p.files)} code files`;
    default:
      return `${String(finding.rule)}${rawParams(p)}`;
  }
}
