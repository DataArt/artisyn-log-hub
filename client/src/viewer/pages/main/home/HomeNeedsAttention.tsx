/**
 * Home's Needs attention widget (DD-14), over the shown entries' repositories and the week
 * window, at most `ATTENTION_LINES_PER_KIND` lines per kind with an in-place "Show all":
 * - Hooks: `['hook-repos']` rows with issues or an outdated version → the hook state page;
 * - Advisor: sessions with advisor advice started this week, newest first → the session's
 *   Advisor tab;
 * - Failed tool calls: one line per repository with a failed-call total > 0 this week → the
 *   "Which tools fail most?" target (DD-12).
 * A repository whose failed-call count cannot be read (tool monitoring off, no access) is simply
 * left out — it is not an error of the widget.
 */
import { useState, type ReactNode } from 'react';
import {
  CircleX,
  PiggyBank,
  Plug,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchHookRepositories } from '../../../api';
import { routes } from '../../../hooks/useHashRoute';
import { NAV_QUESTIONS } from '../../map/nav-questions';
import { cn } from '@/lib/cn';
import { HomeEmpty, HomeWidget } from './HomeWidget';
import { HOME_TONES, type HomeTone } from './home-tones';
import {
  homeSessionsQuery,
  homeToolErrorsQuery,
  shortRepoName,
  withSearch,
} from './home-queries';
import { HOME_STALE_TIME_MS, type UseHomeRepos } from './useHomeRepos';

export const ATTENTION_LINES_PER_KIND = 5;

type AttentionKind = 'hooks' | 'advisor' | 'tools';

/** Each kind keeps the app-wide status colour: a hook issue is a warning, Advisor finds savings,
 * a failed tool call is a failure. */
const KIND_STYLE: Record<AttentionKind, { icon: LucideIcon; tone: HomeTone }> =
  {
    hooks: { icon: Plug, tone: 'amber' },
    advisor: { icon: PiggyBank, tone: 'emerald' },
    tools: { icon: CircleX, tone: 'red' },
  };

interface AttentionLine {
  key: string;
  to: string;
  text: ReactNode;
}

function AttentionGroup({
  kind,
  title,
  lines,
}: {
  kind: AttentionKind;
  title: string;
  lines: AttentionLine[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (lines.length === 0) return null;
  const visible = expanded ? lines : lines.slice(0, ATTENTION_LINES_PER_KIND);
  const { icon: Icon, tone } = KIND_STYLE[kind];
  const toneClasses = HOME_TONES[tone];
  return (
    <div
      data-testid={`home-attention-${kind}`}
      className={cn('flex flex-col gap-1 border-l-2 pl-3', toneClasses.rule)}
    >
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
        <Icon className={cn('size-3.5', toneClasses.icon)} aria-hidden />
        {title}
        <span
          className={cn(
            'rounded-full px-1.5 text-[11px] font-medium normal-case ring-1',
            toneClasses.badge,
          )}
        >
          {lines.length}
        </span>
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {visible.map((l) => (
          <li key={l.key} className="min-w-0 truncate">
            <Link to={l.to} className="hover:underline">
              {l.text}
            </Link>
          </li>
        ))}
      </ul>
      {lines.length > ATTENTION_LINES_PER_KIND && (
        <button
          type="button"
          data-testid={`home-attention-show-all-${kind}`}
          onClick={() => setExpanded(!expanded)}
          className="self-start text-xs text-primary hover:underline"
        >
          {expanded ? 'Show fewer' : `Show all (${lines.length})`}
        </button>
      )}
    </div>
  );
}

export function HomeNeedsAttention({ home }: { home: UseHomeRepos }) {
  const { shown, week } = home;
  const hookRepos = useQuery({
    queryKey: ['hook-repos'],
    queryFn: fetchHookRepositories,
    staleTime: HOME_STALE_TIME_MS,
  });
  const sessionLists = useQueries({
    queries: shown.map((r) => homeSessionsQuery(r)),
  });
  const toolErrors = useQueries({
    queries: shown.map((r) => homeToolErrorsQuery(r, week)),
  });

  const shownById = new Map(shown.map((r) => [r.repoId, r]));

  const hookLines: AttentionLine[] = (hookRepos.data ?? [])
    .filter((h) => shownById.has(h.id) && (h.issueCount > 0 || h.outdated))
    .map((h) => ({
      key: `hook-${h.id}`,
      to: routes.hookState(h.id),
      text: `Hook in ${shortRepoName(h.repoUrl)}: ${
        h.issueCount > 0
          ? `${h.issueCount} issue${h.issueCount === 1 ? '' : 's'}`
          : ''
      }${h.issueCount > 0 && h.outdated ? ', ' : ''}${h.outdated ? 'outdated' : ''}`,
    }));

  const fromMs = Date.parse(week.from);
  const advisor = shown.flatMap((repo, i) =>
    (sessionLists[i]?.data ?? [])
      .filter((s) => s.hasAdvisorAdvice && Date.parse(s.startTime) >= fromMs)
      .map((s) => ({ repo, s })),
  );
  advisor.sort((a, b) => b.s.startTime.localeCompare(a.s.startTime));
  const advisorLines: AttentionLine[] = advisor.map(({ repo, s }) => ({
    key: `advisor-${s.sessionId}`,
    to: withSearch(repo.basePath, { session: s.sessionId, tab: 'advisor' }),
    text: `Advisor found savings in “${
      s.firstPrompt?.trim() || s.sessionId.slice(0, 8)
    }” (${shortRepoName(repo.repoUrl)})`,
  }));

  const toolsQuestion = NAV_QUESTIONS.find((q) => q.id === 'tools');
  const now = new Date(week.to);
  const toolLines: AttentionLine[] = shown
    .map((repo, i) => ({ repo, total: toolErrors[i]?.data?.total ?? 0 }))
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total)
    .flatMap(({ repo, total }) => {
      const target = toolsQuestion?.build(
        { repoId: repo.repoId, teamId: repo.teamId },
        [],
        now,
      );
      if (target?.kind !== 'route') return [];
      return [
        {
          key: `tools-${repo.repoId}`,
          to: withSearch(target.path, target.search ?? {}),
          text: `${total} failed tool call${total === 1 ? '' : 's'} in ${shortRepoName(repo.repoUrl)}`,
        },
      ];
    });

  const pending =
    home.isLoading ||
    hookRepos.isPending ||
    sessionLists.some((q) => q.isPending);
  const failedSessions = sessionLists.filter((q) => q.isError);
  const empty = hookLines.length + advisorLines.length + toolLines.length === 0;

  return (
    <HomeWidget
      testId="home-attention"
      title="Needs attention"
      icon={TriangleAlert}
      tone="amber"
      isLoading={pending && empty}
      isError={home.isError || hookRepos.isError || failedSessions.length > 0}
      onRetry={() => {
        home.refetch();
        void hookRepos.refetch();
        for (const q of failedSessions) void q.refetch();
      }}
    >
      {empty ? (
        <HomeEmpty>Nothing needs attention this week.</HomeEmpty>
      ) : (
        <div className="flex flex-col gap-3">
          <AttentionGroup kind="hooks" title="Hooks" lines={hookLines} />
          <AttentionGroup kind="advisor" title="Advisor" lines={advisorLines} />
          <AttentionGroup
            kind="tools"
            title="Failed tool calls"
            lines={toolLines}
          />
        </div>
      )}
    </HomeWidget>
  );
}
