/**
 * Summary tab, Section 2: a single detected-issue row.
 *
 * Visual contract (Visual/UX notes): a 3.5px left severity spine, a `Badge` (destructive =
 * critical, warning = warning, secondary = info, success = success — `ui/badge.tsx`),
 * bold title, one-line explanation, monospace evidence chips, and a right-aligned
 * "Go to turn #N →" link. The link only exists when `finding.turnIndex`
 * is present — an absent `turnIndex` renders no link at all (never a dead one).
 *
 * The change-surface detectors add a second, independent right-aligned link: `finding.action`,
 * which switches the session view to another tab. A whole-session finding (the change-surface
 * family) has no originating turn, so it carries an `action` and no `turnIndex`; the two rules
 * do not interact, and a finding carrying both would render both links.
 */
import { cn } from '@/lib/cn';
import { Badge } from '@/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import type { SessionTab } from '../../useRepositoryViewState';
import type { Finding, FindingSeverity } from './detectors/types';

interface Props {
  finding: Finding;
  onGoToTurn: (turnIndex: number) => void;
  /** Handles a `finding.action` of `kind: 'tab'`. */
  onOpenTab: (tab: SessionTab) => void;
}

const SEVERITY_BADGE_VARIANT: Record<
  FindingSeverity,
  'destructive' | 'warning' | 'secondary' | 'success'
> = {
  critical: 'destructive',
  warning: 'warning',
  info: 'secondary',
  success: 'success',
};

const SEVERITY_SPINE_CLASS: Record<FindingSeverity, string> = {
  critical: 'border-destructive',
  warning: 'border-warning',
  info: 'border-muted-foreground/40',
  success: 'border-success',
};

/**
 * A short (1-3 sentence) explanation for one evidence chip, keyed by the finding it belongs to
 * — the same chip text (e.g. `threshold: > N`) means something different on different findings,
 * so the lookup is per-`finding.id`, not global. Returns `null` for a chip with no known
 * explanation, which renders it exactly as before (no tooltip).
 */
function evidenceHint(findingId: string, chip: string): string | null {
  switch (findingId) {
    case 'change-surface-spread':
      if (chip.startsWith('concentration '))
        return 'How clustered the changed files are across folders, on a 0-100 scale. Higher means the changes stayed within a few folders; below 40 is the "scattered" band this finding fires on.';
      if (chip.endsWith('files / folder'))
        return 'Changed files divided by folders touched. A low number means many folders were touched for only a file or two each, which is what drives up merge-conflict risk.';
      if (chip.startsWith('band: '))
        return 'Which of the three fixed concentration bands this session falls into: focused (≥ 60), mixed (40-59), or scattered (< 40).';
      return null;
    case 'change-surface-modules':
      if (chip.startsWith('common ancestor: '))
        return 'How many path segments deep the one folder shared by every changed file sits. Depth 0 means the changes reach all the way up to the repo root.';
      if (chip.startsWith('threshold: > '))
        return 'This finding only fires once the session touches more top-level modules than this.';
      return 'One of the top-level modules (first path segment) this session touched.';
    case 'change-surface-single-file-folders':
      if (chip.includes('folders = 1 file'))
        return 'Folders where only a single file was touched — often a sign of drive-by edits scattered across the tree rather than deliberate, concentrated work.';
      if (chip.startsWith('threshold: > '))
        return 'This finding only fires once single-file folders make up more than this share of all touched folders.';
      return null;
    case 'context-compression':
      return 'Tokens in the context window immediately before and after this compaction event.';
    case 'context-ceiling-pressure':
      if (chip.startsWith('peak '))
        return 'The highest number of tokens the context window reached anywhere in this session.';
      return null;
    case 'low-cache-read-ratio':
      if (chip.startsWith('floor '))
        return 'This finding only fires once the cache-read ratio drops below this floor.';
      return null;
    case 'claude-version':
      if (chip.startsWith('session '))
        return "Highest Claude Code version recorded on this session's transcript lines.";
      if (chip.startsWith('stable ') || chip.startsWith('latest '))
        return 'npm dist-tag that was current when the session started.';
      if (chip.startsWith('releases as of '))
        return 'When these release versions were first recorded by the server.';
      return null;
    default:
      return null;
  }
}

export function SummaryFindingRow({ finding, onGoToTurn, onOpenTab }: Props) {
  const { turnIndex, action } = finding;
  return (
    <div
      data-testid="summary-finding"
      className={cn(
        'flex items-start gap-3 border-l-[3.5px] py-2 pl-3 pr-2',
        SEVERITY_SPINE_CLASS[finding.severity],
      )}
    >
      <Badge
        variant={SEVERITY_BADGE_VARIANT[finding.severity]}
        className="mt-0.5 shrink-0"
      >
        {finding.severity}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{finding.title}</div>
        <div className="text-sm text-muted-foreground">
          {finding.explanation}
        </div>
        {finding.evidence && finding.evidence.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {finding.evidence.map((chip, i) => {
              const hint = evidenceHint(finding.id, chip);
              const chipClassName =
                'rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground';
              return hint ? (
                <Tooltip key={i}>
                  <TooltipTrigger
                    className={cn(chipClassName, 'underline decoration-dotted')}
                  >
                    {chip}
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[320px] font-sans">
                    {hint}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span key={i} className={chipClassName}>
                  {chip}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {turnIndex != null && (
        <button
          type="button"
          onClick={() => onGoToTurn(turnIndex)}
          className="shrink-0 whitespace-nowrap text-sm text-primary hover:underline"
        >
          Go to turn #{turnIndex} →
        </button>
      )}
      {action != null && (
        <button
          type="button"
          data-testid="summary-finding-action"
          onClick={() => onOpenTab(action.tab)}
          className="shrink-0 whitespace-nowrap text-sm text-primary hover:underline"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
