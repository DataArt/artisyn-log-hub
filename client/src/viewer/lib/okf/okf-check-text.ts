/**
 * OKF verdict checks (2026-11-05, `verdict.checks`): one plain-English line per structure rule
 * (group A) with the counted value and its threshold, shared by the session and repo OKF tabs.
 *
 * The server sends rule ids, a status and params only (`okf-verdict.md` → "Checks"); every
 * sentence is built here. Shares and ratios are fractions 0-1 and render as whole percents
 * (one decimal when rounding would make a value look equal to its threshold); bytes go through
 * the shared byte formatter. A rule id this client does not know (a newer server) renders as the
 * id plus its raw params.
 */
import type { OkfFinding, OkfVerdictCheck } from '../../../models/repositories';
import { formatBytes } from '../format';
import { okfShortAgentId } from './okf-agent-label';
import type { OkfAgentNamer } from './okf-verdict-text';

/** The verdict's structure rules (group A); every other finding rule is a value signal (B). */
export const OKF_STRUCTURE_RULES: ReadonlySet<string> = new Set([
  'session_share',
  'always_read',
  'kb_flood',
  'coarse_article',
]);

/** True for a finding of a structure rule (section A); false for a value signal (section B). */
export function isStructureFinding(finding: Pick<OkfFinding, 'rule'>): boolean {
  return OKF_STRUCTURE_RULES.has(finding.rule);
}

/** `n` with the singular or plural noun: `1 agent`, `3 agents`. */
export function okfCount(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export interface OkfCheckText {
  /** Short rule name. */
  name: string;
  /** The sentence with the counted value and the threshold. */
  text: string;
  /** "→ action" of a finding; null otherwise. */
  action: string | null;
}

type Params = OkfVerdictCheck['params'];

function num(p: Params, key: string): number {
  const v = p[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return 0;
}

function str(p: Params, key: string): string {
  const v = p[key];
  return v === null || v === undefined ? '' : String(v);
}

/** A fraction as a percent; one decimal when it would round onto `threshold`. */
function pct(share: number, threshold?: number): string {
  const whole = Math.round(share * 100);
  if (
    threshold !== undefined &&
    share !== threshold &&
    whole === Math.round(threshold * 100)
  ) {
    return `${(share * 100).toFixed(1)} %`;
  }
  return `${whole} %`;
}

const NAMES: Record<string, string> = {
  kb_used: 'KB used',
  entry: 'Way in',
  session_share: 'Targeted reading',
  upkeep: 'Upkeep',
  kb_sessions: 'KB sessions',
  kb_flood: 'KB flood',
  always_read: 'Always read',
  coarse_article: 'Coarse article',
};

function rawParams(p: Params): string {
  const parts = Object.entries(p).map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function naText(p: Params, what: string): string {
  switch (str(p, 'reason')) {
    case 'no_snapshot':
      return `No KB snapshot — ${what} cannot be checked`;
    case 'kb_not_used':
      return `Nothing was read from the KB — ${what} not checked`;
    default:
      return `${what} not checked${rawParams(p)}`;
  }
}

function kbUsed(c: OkfVerdictCheck): string {
  const p = c.params;
  const folders = str(p, 'folders');
  const n = num(p, 'agents');
  const a = num(p, 'agentsWithKb');
  if (c.status === 'finding') {
    return folders
      ? `No agent opened the KB although ${folders} has ${okfCount(num(p, 'articles'), 'article', 'articles')}`
      : 'No agent opened the KB';
  }
  const where = folders ? ` (${folders})` : ' (no snapshot, any read KB file)';
  const rest =
    n > a ? `; ${okfCount(n - a, 'agent', 'agents')} did not open it` : '';
  return `${a} of ${okfCount(n, 'agent', 'agents')} read the KB${where}${rest}`;
}

function entry(c: OkfVerdictCheck): string {
  const p = c.params;
  if (c.status === 'na') {
    return str(p, 'reason') === 'no_snapshot'
      ? 'No KB snapshot — the way in cannot be told'
      : 'No agent entered a KB folder';
  }
  const index = num(p, 'index');
  const search = num(p, 'search');
  const given = num(p, 'given');
  const total = index + search + given;
  if (index === total) {
    return total === 1
      ? 'The agent started from index.md'
      : `All ${total} agents started from index.md`;
  }
  const parts: string[] = [];
  if (index > 0)
    parts.push(`${okfCount(index, 'agent', 'agents')} started from index.md`);
  if (search > 0) {
    parts.push(
      `${okfCount(search, 'agent', 'agents')} found ${search === 1 ? 'its article' : 'their articles'} by search`,
    );
  }
  if (given > 0) {
    parts.push(
      `${okfCount(given, 'agent', 'agents')} had the path in ${given === 1 ? 'its' : 'their'} task`,
    );
  }
  return parts.join(', ');
}

function sessionShare(
  c: OkfVerdictCheck,
  agentName: OkfAgentNamer,
): OkfCheckText {
  const p = c.params;
  const fix = num(p, 'fix');
  const why = `More than ${pct(fix)} means an agent read the KB wholesale instead of finding one article`;
  if (c.status === 'na') {
    const text =
      str(p, 'reason') === 'small_bundles'
        ? `No KB folder has ${num(p, 'minFiles')}+ articles — share is not judged on small folders`
        : naText(p, 'the share');
    return { name: NAMES.session_share, text, action: null };
  }
  const read = num(p, 'read');
  const total = num(p, 'total');
  const bundle = str(p, 'bundle');
  const share = num(p, 'share');
  const agentId = str(p, 'agentId');
  if (c.status === 'finding') {
    return {
      name: NAMES.session_share,
      text: `${agentName(agentId)} read ${read} of ${okfCount(total, 'article', 'articles')} of ${bundle} (${pct(share, fix)}) — wholesale reading (finding at > ${pct(fix)}, mess at > ${pct(num(p, 'mess'))})`,
      action: `sharpen the one-line descriptions in ${bundle}/index.md so the agent can pick one article`,
    };
  }
  const text = agentId
    ? `Targeted reads — at most ${read} of ${okfCount(total, 'article', 'articles')} (${pct(share, fix)}) per agent (${agentName(agentId)}, ${bundle}). ${why}`
    : `No agent read an article of ${bundle} (${okfCount(total, 'article', 'articles')}). ${why}`;
  return { name: NAMES.session_share, text, action: null };
}

function upkeep(c: OkfVerdictCheck, agentName: OkfAgentNamer): string {
  const p = c.params;
  const agents = num(p, 'agents');
  if (agents === 0) return 'No agent edited an article it read';
  const articles = num(p, 'articles');
  const more =
    articles > 1
      ? ` and ${okfCount(articles - 1, 'more article', 'more articles')}`
      : '';
  const others = agents > 1 ? ` (${agents} agents edit articles)` : '';
  return `${agentName(str(p, 'agentId'))} edited ${str(p, 'path')}${more}${others} — reads of an article the same agent edits are upkeep and excluded above`;
}

function kbSessions(c: OkfVerdictCheck): string {
  const p = c.params;
  const kb = num(p, 'kbSessions');
  const sessions = num(p, 'sessions');
  const min = num(p, 'minimum');
  const upkeepOnly = num(p, 'upkeepOnly');
  const upkeepText =
    upkeepOnly > 0
      ? `; ${okfCount(upkeepOnly, 'upkeep-only session', 'upkeep-only sessions')} not counted`
      : '';
  if (c.status === 'finding') {
    return `None of ${okfCount(sessions, 'session', 'sessions')} read the KB${upkeepText}`;
  }
  if (c.status === 'na') {
    return `Only ${kb} of ${okfCount(sessions, 'session', 'sessions')} read the KB — the repository checks need ${min}, so the level is "Not enough data"${upkeepText}`;
  }
  return `${kb} of ${okfCount(sessions, 'session', 'sessions')} read the KB (the repository checks need at least ${min})${upkeepText}`;
}

function kbFlood(c: OkfVerdictCheck): OkfCheckText {
  const p = c.params;
  const fs = num(p, 'floodShare');
  const min = num(p, 'minSessions');
  if (c.status === 'na') {
    const text =
      str(p, 'reason') === 'small_bundles'
        ? `No KB folder has ${num(p, 'minFiles')}+ articles — flooding is not judged on small folders`
        : naText(p, 'flooding');
    return { name: NAMES.kb_flood, text, action: null };
  }
  const bundle = str(p, 'bundle');
  const flooded = num(p, 'flooded');
  const of = `${flooded} of ${okfCount(num(p, 'bundleSessions'), 'session', 'sessions')}`;
  if (c.status === 'finding') {
    return {
      name: NAMES.kb_flood,
      text: `${of} read more than ${pct(fs)} of ${bundle} — wholesale reading repeats (finding at ≥ ${min} sessions): its index does not route`,
      action: `sharpen the one-line descriptions in ${bundle}/index.md`,
    };
  }
  const text =
    flooded > 0
      ? `${of} read more than ${pct(fs)} of ${bundle} — below the ${okfCount(min, 'session', 'sessions')} that make it a finding`
      : `No session read more than ${pct(fs)} of a KB folder (most: ${pct(num(p, 'maxShare'), fs)} of ${bundle}); a finding needs ${okfCount(min, 'such session', 'such sessions')}`;
  return { name: NAMES.kb_flood, text, action: null };
}

function alwaysRead(c: OkfVerdictCheck): OkfCheckText {
  const p = c.params;
  if (c.status === 'na') {
    return {
      name: NAMES.always_read,
      text: naText(p, 'always-read articles'),
      action: null,
    };
  }
  const path = str(p, 'path');
  const thr = num(p, 'threshold');
  if (!path) {
    return {
      name: NAMES.always_read,
      text: 'No article was read',
      action: null,
    };
  }
  const counted = `${path} is read in ${num(p, 'sessions')} of ${okfCount(num(p, 'kbSessions'), 'KB session', 'KB sessions')} (${pct(num(p, 'share'), thr)})`;
  if (c.status === 'finding') {
    return {
      name: NAMES.always_read,
      text: `${counted} — finding at ≥ ${pct(thr)}: it belongs in always-loaded context`,
      action: `move its key facts into CLAUDE.md / index.md`,
    };
  }
  return {
    name: NAMES.always_read,
    text: `Most-read article: ${counted}; finding at ≥ ${pct(thr)} — an article nearly every session needs belongs in CLAUDE.md`,
    action: null,
  };
}

function coarseArticle(c: OkfVerdictCheck): OkfCheckText {
  const p = c.params;
  const minSize = formatBytes(num(p, 'minSize'));
  if (c.status === 'na') {
    const text =
      str(p, 'reason') === 'no_big_articles'
        ? `No article reaches ${minSize} — nothing to split`
        : naText(p, 'coarse articles');
    return { name: NAMES.coarse_article, text, action: null };
  }
  const path = str(p, 'path');
  const maxRatio = num(p, 'maxRatio');
  const minSessions = num(p, 'minSessions');
  if (!path) {
    return {
      name: NAMES.coarse_article,
      text: `${okfCount(num(p, 'bigArticles'), 'article', 'articles')} of ≥ ${minSize}, none read whole`,
      action: null,
    };
  }
  const read = `${path} (${formatBytes(num(p, 'size'))}) is read whole in ${okfCount(num(p, 'sessions'), 'session', 'sessions')}, ~${formatBytes(num(p, 'avgReadBytes'))} per read (${pct(num(p, 'ratio'), maxRatio)} of it)`;
  if (c.status === 'finding') {
    return {
      name: NAMES.coarse_article,
      text: `${read} — readers need under ${pct(maxRatio)}: split it`,
      action: `split ${path} at its headings or add section pointers to index.md`,
    };
  }
  return {
    name: NAMES.coarse_article,
    text: `Nearest: ${read}; a finding needs < ${pct(maxRatio)} in ≥ ${okfCount(minSessions, 'session', 'sessions')}`,
    action: null,
  };
}

/** Name, sentence and action of one check. `agentName` names agent ids (session tab). */
export function formatOkfCheck(
  check: OkfVerdictCheck,
  agentName: OkfAgentNamer = okfShortAgentId,
): OkfCheckText {
  const p = check.params ?? {};
  const c = { ...check, params: p };
  switch (check.rule) {
    case 'kb_used':
      return {
        name: NAMES.kb_used,
        text: kbUsed(c),
        action:
          check.status === 'finding'
            ? 'point agents at the KB from CLAUDE.md (where it is and when to read it)'
            : null,
      };
    case 'entry':
      return { name: NAMES.entry, text: entry(c), action: null };
    case 'session_share':
      return sessionShare(c, agentName);
    case 'upkeep':
      return { name: NAMES.upkeep, text: upkeep(c, agentName), action: null };
    case 'kb_sessions':
      return { name: NAMES.kb_sessions, text: kbSessions(c), action: null };
    case 'kb_flood':
      return kbFlood(c);
    case 'always_read':
      return alwaysRead(c);
    case 'coarse_article':
      return coarseArticle(c);
    default:
      return {
        name: String(check.rule),
        text: `${String(check.status)}${rawParams(p)}`,
        action: null,
      };
  }
}
