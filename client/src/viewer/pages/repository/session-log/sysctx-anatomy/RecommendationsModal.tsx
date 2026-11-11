/**
 * The on-demand "Recommendations" modal of the System context anatomy tab. It lists the startup
 * context groups a `@loghub/recommendations` catalog entry matched (rows computed by the tab),
 * with their measured size, who controls them and how to switch them off. Static data only: it
 * makes no network request, and its DOM holds only catalog text, names, counts and sizes.
 */
import {
  CATALOG_VERSION,
  type RecommendationRow,
} from '@loghub/recommendations';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { fmtInt } from './AnatomyCells';
import { RecommendationRows, fmtRecoShare } from './RecommendationRows';
import type { SysctxAnatomy } from './sysctx-anatomy';

export interface RecommendationsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: RecommendationRow[];
  anatomy: SysctxAnatomy;
  /** Claude Code version of the session, `null` when unknown. */
  claudeVersion: string | null;
}

/**
 * `N matched · ≈ X tokens (Y % of T[ attributed]) · [K not measured ·] Claude Code <v|unknown> ·
 * catalog v<CATALOG_VERSION>` (DD 12).
 */
export function recommendationsSummary(
  rows: RecommendationRow[],
  anatomy: SysctxAnatomy,
  claudeVersion: string | null,
): string {
  let tokens = 0;
  let notMeasured = 0;
  for (const r of rows) {
    if (r.tokens === null) notMeasured += 1;
    else tokens += r.tokens;
  }
  const share = anatomy.denominator > 0 ? tokens / anatomy.denominator : 0;
  const ofWhat =
    fmtInt(anatomy.denominator) +
    (anatomy.denominator !== anatomy.total ? ' attributed' : '');
  const parts = [
    `${fmtInt(rows.length)} matched`,
    `≈ ${fmtInt(tokens)} tokens (${fmtRecoShare(share)} of ${ofWhat})`,
  ];
  if (notMeasured > 0) parts.push(`${fmtInt(notMeasured)} not measured`);
  parts.push(`Claude Code ${claudeVersion ?? 'unknown'}`);
  parts.push(`catalog v${CATALOG_VERSION}`);
  return parts.join(' · ');
}

const HEAD =
  'px-2 py-2 text-left text-xs font-medium uppercase text-muted-foreground';

export function RecommendationsModal({
  open,
  onOpenChange,
  rows,
  anatomy,
  claudeVersion,
}: RecommendationsModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] w-[90vw] max-w-5xl flex-col overflow-hidden"
        data-testid="sysctx-reco-modal"
      >
        <DialogHeader className="shrink-0 space-y-1">
          <DialogTitle className="text-base">Recommendations</DialogTitle>
          <DialogDescription className="text-xs">
            Startup context groups you may be able to switch off, with their
            estimated size in this session&apos;s first request.
          </DialogDescription>
          <div
            className="pt-1 text-sm tabular-nums"
            data-testid="sysctx-reco-summary"
          >
            {recommendationsSummary(rows, anatomy, claudeVersion)}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b">
                <th className={`${HEAD} w-[22%]`}>Group</th>
                <th className={`${HEAD} w-[28%]`}>What it is for</th>
                <th className={`${HEAD} w-[10%]`}>≈ Tokens</th>
                <th className={`${HEAD} w-[12%]`}>Controlled by</th>
                <th className={`${HEAD} w-[28%]`}>How to disable</th>
              </tr>
            </thead>
            <tbody>
              <RecommendationRows rows={rows} />
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
