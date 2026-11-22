/**
 * Constants and every fixed text of the shared OKF view (`OkfUsageView`): unit labels, the
 * wrong-format group titles and the tooltip texts. The repo tab counts sessions, the session tab
 * counts agents — the label comes from the response's `unit`.
 */
import type {
  OkfFormatProblem,
  OkfUsageUnit,
} from '../../../../../models/repositories';

/** Hot-files rows shown before "Show all". */
export const OKF_HOT_FILES_TOP = 10;

/** Files shown per wrong-format group before "show all". */
export const OKF_FORMAT_FILES_TOP = 10;

/** Column label of the unit count. */
export const OKF_UNIT_LABEL: Record<OkfUsageUnit, string> = {
  sessions: 'Sessions',
  agents: 'Agents',
};

/** The summary line's lead and unit noun: "KB read in N of M sessions" / "… by N of M agents". */
export const OKF_SUMMARY_LEAD: Record<
  OkfUsageUnit,
  { lead: string; noun: string }
> = {
  sessions: { lead: 'KB read in', noun: 'sessions' },
  agents: { lead: 'KB read by', noun: 'agents' },
};

/** Tail of the explorer header after "X of Y files opened". */
export const OKF_EXPLORER_HEADER_TAIL: Record<OkfUsageUnit, string> = {
  sessions: '',
  agents: ' in this session',
};

export const OKF_FORMAT_GROUP_TITLE: Record<OkfFormatProblem, string> = {
  no_front_matter: 'No front matter',
  no_type: 'No "type" in the front matter',
  v01_timestamp: 'Old "timestamp" key (format 0.1)',
  deprecated: 'Deprecated',
  past_stale_after: 'Past its "stale after" date',
};

export const OKF_NO_SNAPSHOT_TEXT = 'No KB snapshot — update the hook.';
export const OKF_NO_SNAPSHOT_LINK = 'How to update';
export const OKF_OLD_HOOK_TEXT =
  'Update the hook to see versions and format problems.';
export const OKF_SEARCH_ROW_LABEL = 'searches across this folder';
export const OKF_MISSING_ROOT_LABEL = 'Not in this snapshot';
export const OKF_NOT_IN_GIT_LABEL = 'not in git';
export const OKF_ROOT_BUNDLE_LABEL = '(repository root)';

export const OKF_TIP_COST =
  'For each agent: the KB share of what it put into its context × what that context cost (input + cache write + cache read; output is not included). Assumes KB text is carried and re-read from the cache like the rest of the context. Spend = total cost of the same sessions.';
export const OKF_TIP_COST_ALL_PRICED = 'All reads in this period have a cost.';
export const OKF_TIP_READS =
  'Read and search (grep) calls that returned text of this file.';
export const OKF_TIP_TOKENS =
  'Bytes returned by those calls ÷ 4 — not the size of the file.';
export const OKF_TIP_SNAPSHOT =
  'The list of KB files as of this branch and date. "Never opened" is measured against it.';
export const OKF_TIP_MISSING =
  'Files that were read but are not in the snapshot shown: deleted, renamed, or on another branch.';
export const OKF_TIP_SEARCH =
  "Searches over the whole folder; not included in any file's numbers.";
export const OKF_TIP_FORMAT =
  'The format version each KB folder declares in its index.md (okf_version).';

/** Second sentence of the ≈ $ tooltip: how many reads have no cost. */
export function okfCostCoverageText(readsWithoutCost: number): string {
  return readsWithoutCost > 0
    ? `${readsWithoutCost} reads have no cost (their agent has no computed cost).`
    : OKF_TIP_COST_ALL_PRICED;
}

/** The collapsed Versions line. */
export function okfVersionsSummaryText(
  folders: number,
  older: number,
  currentFormat: string,
): string {
  const noun = folders === 1 ? 'KB folder' : 'KB folders';
  if (older > 0) {
    return `${folders} ${noun}, ${older} older than the current format ${currentFormat}`;
  }
  return folders === 1
    ? `1 ${noun}, on format ${currentFormat}`
    : `${folders} ${noun}, all on format ${currentFormat}`;
}

/** `1 file` / `N files`. */
export function okfFilesText(n: number): string {
  return n === 1 ? '1 file' : `${n} files`;
}
