/**
 * Verdict card of the OKF tabs: level badge, qualifiers, clickable "Why" lines (worst first),
 * and — on the session variant — the Read top 5 and the "How agents reached the KB" chips.
 * The repo variant shows the KB session count instead; its anomaly lines are the same Why
 * lines. Every line click is forwarded to `onNodeClick` so the tab can scroll the tree to it.
 */
import type { ReactNode } from 'react';
import { Badge } from '@/ui/badge';
import { TooltipProvider } from '@/ui/tooltip';
import {
  entryLabel,
  levelLabel,
  qualifierLabel,
} from '@/lib/okf/okf-verdict-text';
import type {
  OkfAgent,
  OkfReadTopItem,
  OkfSessionUpkeepItem,
  OkfThresholdsInfo,
  OkfVerdict,
  OkfVerdictLevel,
} from '../../../../../models/repositories';
import { okfAgentLabel } from './okf-tree';
import { OkfFindingLine } from './OkfFindingLine';
import { OkfReadTop } from './OkfReadTop';
import { OkfThresholdsChip } from './OkfThresholdsChip';

type BadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary';

const LEVEL_VARIANT: Record<OkfVerdictLevel, BadgeVariant> = {
  ok: 'success',
  fix: 'warning',
  mess: 'destructive',
  kb_not_used: 'secondary',
  not_enough_data: 'secondary',
};

export interface OkfVerdictCardProps {
  verdict: OkfVerdict;
  variant: 'session' | 'repo';
  onNodeClick: (bundle: string | null, path?: string) => void;
  /** Session variant. */
  readTop?: readonly OkfReadTopItem[];
  /** Session variant: the "Upkeep" line under Read top 5 (FR-5). */
  upkeep?: readonly OkfSessionUpkeepItem[];
  /** Session variant: ranged read calls by file path, for the `§ section` chips. */
  rangedCalls?: ReadonlyMap<string, number>;
  agents?: readonly OkfAgent[];
  rootSessionId?: string;
  /** Repo variant. */
  kbSessions?: number;
  totalSessions?: number;
  /** Which thresholds differ from the defaults; the chip is hidden when absent (older server). */
  thresholds?: OkfThresholdsInfo;
  /** Opens Settings → Analysis (OKF thresholds) from the thresholds chip. */
  onOpenSettings?: () => void;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

export function OkfVerdictCard({
  verdict,
  variant,
  onNodeClick,
  readTop = [],
  upkeep,
  rangedCalls,
  agents = [],
  rootSessionId = '',
  kbSessions,
  totalSessions,
  thresholds,
  onOpenSettings,
}: OkfVerdictCardProps) {
  const entryAgents = agents.filter((a) => a.entry !== null);

  return (
    <TooltipProvider>
      <div
        data-testid="okf-verdict-card"
        className="space-y-3 rounded-md border border-border bg-card p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Verdict
          </span>
          <Badge
            variant={LEVEL_VARIANT[verdict.level] ?? 'secondary'}
            data-testid="okf-verdict-level"
          >
            {levelLabel(verdict.level)}
          </Badge>
          {verdict.qualifiers.map((q) => (
            <Badge key={q} variant="outline" className="text-muted-foreground">
              {qualifierLabel(q, verdict)}
            </Badge>
          ))}
          {variant === 'repo' && kbSessions !== undefined ? (
            <span className="text-xs text-muted-foreground">
              {kbSessions.toLocaleString()} KB sessions
              {totalSessions !== undefined
                ? ` of ${totalSessions.toLocaleString()}`
                : ''}
            </span>
          ) : null}
          {thresholds ? (
            <span className="ml-auto">
              <OkfThresholdsChip
                thresholds={thresholds}
                onOpenSettings={onOpenSettings}
              />
            </span>
          ) : null}
        </div>
        {variant === 'repo' ? (
          <div
            data-testid="okf-verdict-subtitle"
            className="-mt-2 text-[11px] text-muted-foreground"
          >
            Measures access, layout and value proxies
          </div>
        ) : null}

        {verdict.findings.length > 0 ? (
          <div>
            <SectionTitle>
              {variant === 'repo' ? 'Anomalies' : 'Why'}
            </SectionTitle>
            {verdict.findings.map((f, i) => (
              <OkfFindingLine
                key={`${f.rule}:${i}`}
                finding={f}
                onClick={() => onNodeClick(f.node.bundle, f.node.path)}
              />
            ))}
            {variant === 'session' ? (
              <div className="px-1 text-[11px] text-muted-foreground">
                Per agent — the same article read by several agents is not a
                finding.
              </div>
            ) : null}
          </div>
        ) : null}

        {variant === 'session' ? (
          <OkfReadTop
            readTop={readTop}
            upkeep={upkeep}
            rangedCalls={rangedCalls}
            onNodeClick={onNodeClick}
          />
        ) : null}

        {variant === 'session' && entryAgents.length > 0 ? (
          <div>
            <SectionTitle>
              How agents reached the KB · {entryAgents.length} agents
            </SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {entryAgents.map((a) => (
                <span
                  key={a.id}
                  data-testid="okf-entry-chip"
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]"
                  title={a.taskHead}
                >
                  <span className="font-mono">
                    {okfAgentLabel(a.id, rootSessionId)}
                  </span>
                  <span className="text-muted-foreground">
                    → {a.files.length}{' '}
                    {a.files.length === 1 ? 'article' : 'articles'}
                  </span>
                  <span className="font-medium">
                    {a.entry ? entryLabel(a.entry) : ''}
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
