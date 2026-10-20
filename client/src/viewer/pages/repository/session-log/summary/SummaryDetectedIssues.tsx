/**
 * Summary tab, Section 2: "Detected issues".
 *
 * Renders `null` — no heading, no placeholder — when there are no findings (Visual/UX notes:
 * "Absent entirely (no placeholder, no heading) when there are no findings"). Findings are
 * pre-sorted by `runDetectors` (registry severity order); this component does not re-sort.
 *
 * Findings may carry a `group`. Ungrouped findings render first, in
 * the order they arrived; then one labelled section per distinct group, in first-appearance
 * order. Partitioning preserves relative order, so each section stays severity-ordered without
 * a second sort. A group with no findings renders nothing at all — no header, no "all clear"
 * placeholder (the focused-session counter-case).
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import type { SessionTab } from '../../useRepositoryViewState';
import type { Finding } from './detectors/types';
import { SummaryFindingRow } from './SummaryFindingRow';

interface Props {
  findings: Finding[];
  onGoToTurn: (turnIndex: number) => void;
  /** Handles a finding's `action` of `kind: 'tab'`. */
  onOpenTab: (tab: SessionTab) => void;
}

/**
 * Splits into the ungrouped head plus one entry per distinct group, both in first-appearance
 * order and both internally order-preserving.
 */
export function partitionFindingsByGroup(findings: Finding[]): {
  ungrouped: Finding[];
  groups: { group: string; findings: Finding[] }[];
} {
  const ungrouped: Finding[] = [];
  const groups: { group: string; findings: Finding[] }[] = [];
  const byName = new Map<string, Finding[]>();

  for (const finding of findings) {
    const group = finding.group;
    if (group == null || group === '') {
      ungrouped.push(finding);
      continue;
    }
    let bucket = byName.get(group);
    if (bucket === undefined) {
      bucket = [];
      byName.set(group, bucket);
      groups.push({ group, findings: bucket });
    }
    bucket.push(finding);
  }

  return { ungrouped, groups };
}

export function SummaryDetectedIssues({
  findings,
  onGoToTurn,
  onOpenTab,
}: Props) {
  if (findings.length === 0) return null;

  const { ungrouped, groups } = partitionFindingsByGroup(findings);

  const rows = (list: Finding[]) =>
    list.map((finding) => (
      <SummaryFindingRow
        key={finding.id}
        finding={finding}
        onGoToTurn={onGoToTurn}
        onOpenTab={onOpenTab}
      />
    ));

  return (
    <Card data-testid="summary-detected-issues">
      <CardHeader>
        <CardTitle>Detected issues</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col p-0">
        {ungrouped.length > 0 && (
          <div className="flex flex-col divide-y divide-border">
            {rows(ungrouped)}
          </div>
        )}
        {groups.map(({ group, findings: groupFindings }) => (
          <div key={group} data-testid="summary-finding-group">
            <div className="border-t border-border bg-muted/40 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group}
            </div>
            <div className="flex flex-col divide-y divide-border">
              {rows(groupFindings)}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
