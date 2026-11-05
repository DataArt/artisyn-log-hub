/**
 * Per-article drill-down of the repo OKF tab (`okfArticle` URL param), shown instead of the tab
 * overview. Fetches `getOkfArticle` with the tab filters and renders: the back link, the header
 * (size, hash status chip, read summary incl. reads cut to a preview), the value-signals strip
 * (DD-29), the article's findings, the pointer table, the signal blocks and the "same finding on
 * other articles" list, whose rows switch the drill-down to that article.
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import { Skeleton } from '@/ui/skeleton';
import { ApiError, getOkfArticle } from '../../../../api';
import type {
  OkfFindingRule,
  RepoOkfArticleResponse,
} from '../../../../../models/repositories';
import { OkfFindingLine } from '../../session-log/okf/OkfFindingLine';
import { toIsoDateBounds } from '../../reports/report-url';
import type { RepoOkfFilters } from '../okf-url-state';
import { OkfPointerTable } from './OkfPointerTable';
import { OkfSignalBlocks } from './OkfSignalBlocks';

export interface OkfArticleDrillDownProps {
  repoId: number;
  teamId?: number;
  /** Repo-relative path of the KB article. */
  path: string;
  filters: RepoOkfFilters;
  /** Back to the tab overview (clears `okfArticle`). */
  onBack: () => void;
  /** Switches the drill-down to another article. */
  onOpenArticle: (path: string) => void;
}

const RULE_LABELS: Record<string, string | undefined> = {
  session_share: 'session share',
  always_read: 'always read',
  kb_flood: 'KB flood',
  coarse_article: 'coarse article',
  routing_miss: 'routing miss',
  searched_after: 'searched after reading',
  dead_pointers: 'dead pointers',
  catalog: 'catalog',
};

function ruleLabel(rule: OkfFindingRule): string {
  return RULE_LABELS[rule] ?? rule;
}

const NONE = '—';

function hashChip(data: RepoOkfArticleResponse): string {
  switch (data.hashStatus) {
    case 'current':
      return 'current version';
    case 'stale':
      return data.oldSize !== null
        ? `changed · was ${formatBytes(data.oldSize)}`
        : 'changed since';
    case 'removed':
      return 'removed from KB';
    default:
      return 'version unknown';
  }
}

function Signal({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="min-w-[7rem] rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div data-testid={testId} className="font-mono text-sm tabular-nums">
        {value}
      </div>
    </div>
  );
}

/** DD-29 value-signals strip; a signal with no data shows "—". */
function SignalsStrip({ data }: { data: RepoOkfArticleResponse }) {
  const y = data.yield;
  const sa = data.searchedAfter;
  const rm = data.routingMiss;
  const dead = data.pointers.filter((p) => p.dead).length;
  return (
    <div className="flex flex-wrap gap-2" data-testid="okf-article-signals">
      <Signal
        label="Pointer yield"
        testId="okf-article-signal-yield"
        value={y && y.n > 0 ? `${y.k} / ${y.n} reads` : NONE}
      />
      <Signal
        label="Searched after"
        testId="okf-article-signal-searched-after"
        value={sa && sa.agents > 0 ? `${sa.agents} · ${sa.searches}` : NONE}
      />
      <Signal
        label="Routing miss"
        testId="okf-article-signal-routing-miss"
        value={
          rm && rm.areaAgents > 0
            ? `${rm.agents} of ${rm.areaAgents} agents`
            : NONE
        }
      />
      <Signal
        label="Dead pointers"
        testId="okf-article-signal-dead"
        value={
          data.pointers.length > 0
            ? `${dead} dead of ${data.pointers.length} shown`
            : NONE
        }
      />
      <Signal
        label="Catalog"
        testId="okf-article-signal-catalog"
        value={data.catalog ? `${data.catalog.files} area files` : NONE}
      />
    </div>
  );
}

function Header({ data }: { data: RepoOkfArticleResponse }) {
  const r = data.reads;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono tabular-nums">
          {data.size !== null ? formatBytes(data.size) : NONE}
        </span>
        <span
          data-testid="okf-article-hash-status"
          data-status={data.hashStatus}
          className="rounded border border-border px-1 text-[10px] text-muted-foreground"
        >
          {hashChip(data)}
        </span>
        {data.bundle ? (
          <span className="text-muted-foreground">bundle {data.bundle}</span>
        ) : null}
      </div>
      <div
        data-testid="okf-article-reads"
        className="text-xs text-muted-foreground"
      >
        whole {r.whole} · § section {r.section} · upkeep {r.upkeep} excluded
        {r.partial > 0
          ? ` · ${r.partial} reads cut to a preview / empty, not counted`
          : ''}
      </div>
    </div>
  );
}

function SameFindingElsewhere({
  items,
  onOpenArticle,
}: {
  items: RepoOkfArticleResponse['sameFindingElsewhere'];
  onOpenArticle: (path: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      data-testid="okf-article-same-finding"
      className="rounded-md border border-border bg-card p-3"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Same finding on other articles
      </div>
      {items.map((it) => (
        <button
          key={`${it.rule}:${it.path}`}
          type="button"
          data-testid="okf-article-same-finding-row"
          onClick={() => onOpenArticle(it.path)}
          className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
        >
          <span className="min-w-0 flex-1 truncate font-mono" title={it.path}>
            {it.path}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {ruleLabel(it.rule)}
          </span>
          <span className="w-10 shrink-0 text-right tabular-nums">
            {it.value}
          </span>
        </button>
      ))}
    </div>
  );
}

function ArticleBody({
  data,
  onOpenArticle,
}: {
  data: RepoOkfArticleResponse;
  onOpenArticle: (path: string) => void;
}) {
  return (
    <div className="max-w-5xl space-y-3">
      <Header data={data} />
      <SignalsStrip data={data} />
      {data.areaFromOlderVersion ? (
        <div
          data-testid="okf-article-older-area"
          className="text-[11px] text-muted-foreground"
        >
          Area from an older version — no session read the current version yet.
        </div>
      ) : null}
      {data.findings.length > 0 ? (
        <div
          data-testid="okf-article-findings"
          className="rounded-md border border-border bg-card p-3"
        >
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Findings
          </div>
          {data.findings.map((f, i) => (
            <OkfFindingLine
              key={`${f.rule}:${i}`}
              finding={f}
              onClick={() => {}}
            />
          ))}
        </div>
      ) : null}
      <OkfPointerTable pointers={data.pointers} />
      <OkfSignalBlocks data={data} />
      <SameFindingElsewhere
        items={data.sameFindingElsewhere}
        onOpenArticle={onOpenArticle}
      />
    </div>
  );
}

export function OkfArticleDrillDown({
  repoId,
  teamId,
  path,
  filters,
  onBack,
  onOpenArticle,
}: OkfArticleDrillDownProps) {
  const { startDate, endDate } = toIsoDateBounds(
    filters.startDate,
    filters.endDate,
  );
  const query = useQuery({
    queryKey: [
      'repo-okf-article',
      repoId,
      teamId ?? null,
      path,
      startDate,
      endDate,
      filters.branches,
      filters.users,
      filters.attr,
    ],
    queryFn: () =>
      getOkfArticle(repoId, path, {
        teamId,
        startDate,
        endDate,
        branches: filters.branches,
        users: filters.users,
        attr: filters.attr,
      }),
  });
  const data = query.data;

  let body;
  if (query.isLoading) {
    body = (
      <div className="space-y-3" data-testid="okf-article-loading">
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-16 w-full max-w-5xl" />
        <Skeleton className="h-40 w-full max-w-5xl" />
      </div>
    );
  } else if (query.error) {
    body = (
      <div className="text-sm text-muted-foreground">
        {query.error instanceof ApiError && query.error.statusCode === 403
          ? 'No access'
          : 'Error — the article could not be loaded.'}
      </div>
    );
  } else if (!data || !data.found) {
    body = (
      <div
        data-testid="okf-article-not-found"
        className="text-sm text-muted-foreground"
      >
        This path is not a KB article read in this scope.
      </div>
    );
  } else {
    body = <ArticleBody data={data} onOpenArticle={onOpenArticle} />;
  }

  return (
    <div className="space-y-3 p-4" data-testid="okf-article-drilldown">
      <button
        type="button"
        data-testid="okf-article-back"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        back to the tree
      </button>
      <div className="font-mono text-sm font-medium" title={path}>
        {path}
      </div>
      {body}
    </div>
  );
}
