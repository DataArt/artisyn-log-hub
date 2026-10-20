/**
 * The session detail "Advisor" tab.
 *
 * Renders the latest submitted Turn-End Cost Advisor result, read straight off the already-
 * fetched `/logs` payload's `turnEndAdvisor` field (no separate session-
 * detail cost/advisor endpoint). The tab itself is only ever mounted when that field is non-null
 * (`SessionDetailPane.tsx` hides the tab button otherwise), so this component does not render an
 * empty/disabled state of its own — only loading/error while the shared `/logs` query is in
 * flight, matching `SessionUsageTab`'s pattern.
 *
 * Section order is fixed by the Visual/UX notes: general summary, then cost factors, then
 * harness advice, with the generation timestamp shown as a small trailing label.
 */
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Skeleton } from '../../ui/skeleton';
import {
  formatCost,
  formatLocalTimestamp,
  formatTokens,
} from '../../lib/format';

export interface AdvisorTabData {
  generatedAt: string;
  summaryGeneral: string;
  costFactors: string[];
  harnessAdvice: string[];
  model: string | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface Props {
  turnEndAdvisor: AdvisorTabData | null;
  isLoading: boolean;
  error: unknown;
}

function BulletList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to report.</p>;
  }
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

export function AdvisorTab({ turnEndAdvisor, isLoading, error }: Props) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-sm text-muted-foreground">Error</p>
      </div>
    );
  }

  if (!turnEndAdvisor) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-sm text-muted-foreground">
          No advisor result available for this session.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-4 p-4 overflow-y-auto"
      data-testid="advisor-tab"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Turn-End Cost Advisor</h2>
        <span className="text-xs text-muted-foreground">
          Generated {formatLocalTimestamp(turnEndAdvisor.generatedAt)}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm whitespace-pre-wrap">
            {turnEndAdvisor.summaryGeneral}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Cost factors</CardTitle>
        </CardHeader>
        <CardContent>
          <BulletList items={turnEndAdvisor.costFactors} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Harness advice</CardTitle>
        </CardHeader>
        <CardContent>
          <BulletList items={turnEndAdvisor.harnessAdvice} />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Analysis cost {formatCost(turnEndAdvisor.costUsd)} &middot;{' '}
        {turnEndAdvisor.model ?? 'unknown model'} &middot;{' '}
        {formatTokens(turnEndAdvisor.inputTokens)} in /{' '}
        {formatTokens(turnEndAdvisor.outputTokens)} out /{' '}
        {formatTokens(turnEndAdvisor.cacheReadTokens)} cache read /{' '}
        {formatTokens(turnEndAdvisor.cacheWriteTokens)} cache write
      </p>
    </div>
  );
}
