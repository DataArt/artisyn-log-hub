/**
 * The session view's "System context anatomy" tab.
 *
 * Splits the first request's measured input (the startup context) into partitions estimated from
 * what the transcript logged before the first assistant reply, joined with the harness snapshot
 * for file sizes and git status. Fully prop-driven: it issues no query of its own and derives
 * everything from the `/logs` payload `SessionDetailPane` already holds, through one memo
 * (`buildSysctxAnatomy`, docs/knowledgebase/algorithms/sysctx-anatomy.md).
 *
 * Only names, paths, sizes, statuses and role labels reach the DOM — never file, section or
 * prompt text.
 */
import { useCallback, useMemo, useState } from 'react';
import { Skeleton } from '@/ui/skeleton';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { HarnessSnapshot } from '../../../../api';
import { getSessionLogsErrorMessage } from '../session-logs-error';
import { buildSysctxAnatomy, type SysctxAnatomy } from './sysctx-anatomy';
import type { AnatomyPartitionKind } from './sysctx-anatomy-constants';
import { fmtInt } from './AnatomyCells';
import { AnatomyPartitionBar } from './AnatomyPartitionBar';
import { AnatomyPartitionTable } from './AnatomyPartitionTable';

export interface SessionSysctxAnatomyTabProps {
  mainLogs: Record<string, unknown>[] | null;
  harnessSnapshot: HarnessSnapshot | null | undefined;
  /** Absolute repository root (for display paths only), empty when unknown. */
  repoRoot: string;
  pricing: ModelPricingMap | null | undefined;
  /** Session model (`summary.model`), used for the bytes-per-token ratio when no line names one. */
  sessionModel: string | null | undefined;
  isLoading: boolean;
  error: Error | null;
}

type BannerVariant =
  | 'old-hook'
  | 'no-git'
  | 'no-prompt-snapshot'
  | 'unknown-total'
  | 'over-total';

interface Banner {
  variant: BannerVariant;
  tone: 'info' | 'warning';
  text: string;
}

/** Banners of the edge states (DD 12), in display order. */
function buildBanners(a: SysctxAnatomy): Banner[] {
  const out: Banner[] = [];
  if (a.flags.noSnapshot) {
    out.push({
      variant: 'old-hook',
      tone: 'info',
      text: 'No harness snapshot for this session — git status and size on disk are unavailable (hook older than 2.22.0).',
    });
  } else if (a.flags.noGitStatus) {
    out.push({
      variant: 'no-git',
      tone: 'info',
      text: 'Git status needs hook 2.28.0 or newer.',
    });
  }
  if (a.flags.noPromptSnapshot) {
    out.push({
      variant: 'no-prompt-snapshot',
      tone: 'info',
      text: 'This Claude Code version did not log its system prompt — it is counted in Harness internals.',
    });
  }
  if (a.flags.unknownTotal) {
    out.push({
      variant: 'unknown-total',
      tone: 'info',
      text: 'The measured total is unknown, so shares are of the attributed estimate.',
    });
  }
  if (a.flags.overTotal && a.overBy !== null) {
    out.push({
      variant: 'over-total',
      tone: 'warning',
      text: `Attributed estimate exceeds measured total by ${fmtInt(a.overBy)} tokens`,
    });
  }
  return out;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4" data-testid="sysctx-anatomy-loading">
      <Skeleton className="h-6 w-80" />
      <Skeleton className="h-7 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function Message({ text }: { text: string }) {
  return (
    <div
      className="p-8 text-center text-sm text-muted-foreground"
      data-testid="sysctx-anatomy-tab"
    >
      {text}
    </div>
  );
}

function Header({ anatomy }: { anatomy: SysctxAnatomy }) {
  return (
    <div className="space-y-0.5">
      <h2 className="text-base font-semibold">System context anatomy</h2>
      <div className="text-sm tabular-nums" data-testid="anatomy-total">
        {anatomy.total === null
          ? 'Total unknown — no assistant message with usage'
          : `Total ${fmtInt(anatomy.total)} tokens · exact (input + cache write + cache read)`}
      </div>
      <div className="text-xs text-muted-foreground">
        ≈ bytes / {anatomy.cpt} — only the total is exact
      </div>
    </div>
  );
}

export function SessionSysctxAnatomyTab({
  mainLogs,
  harnessSnapshot,
  repoRoot,
  pricing,
  sessionModel,
  isLoading,
  error,
}: SessionSysctxAnatomyTabProps) {
  const [selectedKind, setSelectedKind] = useState<AnatomyPartitionKind | null>(
    null,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<AnatomyPartitionKind>>(
    () => new Set(),
  );

  const anatomy = useMemo(
    () =>
      buildSysctxAnatomy({
        main: mainLogs ?? [],
        snapshot: harnessSnapshot ?? null,
        repoRoot,
        // cpt: resolveCharsPerToken(pricing, first assistant model ?? session model) (DD 5).
        pricing: pricing ?? undefined,
        fallbackModel: sessionModel ?? null,
      }),
    [mainLogs, harnessSnapshot, repoRoot, pricing, sessionModel],
  );

  // Selecting a kind (segment or row) also expands it when it has drill-down rows (DD 15).
  const select = useCallback(
    (kind: AnatomyPartitionKind) => {
      setSelectedKind(kind);
      const hasRows = anatomy.partitions.some(
        (p) => p.kind === kind && p.rows.length > 0,
      );
      if (hasRows) {
        setExpanded((prev) =>
          prev.has(kind) ? prev : new Set(prev).add(kind),
        );
      }
    },
    [anatomy],
  );

  const toggleExpand = useCallback((kind: AnatomyPartitionKind) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  if (isLoading) return <LoadingSkeleton />;
  if (error) return <Message text={getSessionLogsErrorMessage(error)} />;
  if (anatomy.flags.empty) {
    return <Message text="No startup context recorded for this session." />;
  }

  const banners = buildBanners(anatomy);

  return (
    <div
      className="h-full min-h-0 overflow-auto"
      data-testid="sysctx-anatomy-tab"
    >
      <div className="max-w-[1200px] space-y-4 p-4">
        <Header anatomy={anatomy} />
        {banners.length > 0 && (
          <div className="space-y-2">
            {banners.map((b) => (
              <div
                key={b.variant}
                data-testid="anatomy-banner"
                data-variant={b.variant}
                role={b.tone === 'warning' ? 'alert' : 'status'}
                className={
                  b.tone === 'warning'
                    ? 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800'
                    : 'rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700'
                }
              >
                {b.text}
              </div>
            ))}
          </div>
        )}
        <AnatomyPartitionBar
          anatomy={anatomy}
          selectedKind={selectedKind}
          onSelect={select}
        />
        <AnatomyPartitionTable
          anatomy={anatomy}
          selectedKind={selectedKind}
          expanded={expanded}
          onSelect={select}
          onToggleExpand={toggleExpand}
        />
      </div>
    </div>
  );
}
