/**
 * Value-signal blocks of the OKF article drill-down: routing miss (FR-3: X of Y agents, top
 * patterns, the agents that missed), searched after reading (FR-2), dead pointers (FR-13) and
 * catalog (FR-15). Each block ends with its "→ action" line (`okfActionText`, DD-26). The action
 * uses the article's own finding of that rule when the server sent one, else a finding built
 * from the drill-down data with the same params, so a signal below its finding threshold still
 * says what to change.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { routes } from '../../../../hooks/useHashRoute';
import { okfActionText } from '@/lib/okf/okf-action-text';
import type {
  OkfFinding,
  OkfFindingRule,
  OkfPatternCountItem,
  RepoOkfArticleResponse,
} from '../../../../../models/repositories';
import { okfAgentLabel } from '@/lib/okf/okf-agent-label';
import { OkfSearchedAfterAgents, OkfTrailLink } from './OkfArticleAgentLinks';

/** At most 3 dead pointers in the action's `path` param, then "…" (DD-26). */
const DEAD_IN_ACTION = 3;

/** The common folder of the area files (`area` param of DD-26), `/` when none is shared. */
export function okfAreaFolder(area: readonly string[]): string {
  if (area.length === 0) return '';
  let prefix = area[0].split('/').slice(0, -1);
  for (const file of area.slice(1)) {
    const parts = file.split('/').slice(0, -1);
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.length > 0 ? `${prefix.join('/')}/` : '/';
}

function patternsParam(patterns: readonly OkfPatternCountItem[]): string {
  return patterns.map((p) => p.pattern).join(', ');
}

function findingFor(
  data: RepoOkfArticleResponse,
  rule: OkfFindingRule,
  params: Record<string, string | number>,
): OkfFinding {
  return (
    data.findings.find((f) => f.rule === rule) ?? {
      rule,
      severity: 'info',
      params: { file: data.path, ...params },
      node: { bundle: data.bundle, path: data.path },
    }
  );
}

function Block({
  title,
  testId,
  finding,
  children,
}: {
  title: string;
  testId: string;
  finding: OkfFinding;
  children?: ReactNode;
}) {
  const action = okfActionText(finding);
  return (
    <div
      data-testid={testId}
      className="space-y-1.5 rounded-md border border-border bg-card p-3"
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
      {action ? (
        <div
          data-testid="okf-article-action"
          className="text-[11px] text-muted-foreground"
        >
          → {action}
        </div>
      ) : null}
    </div>
  );
}

function Patterns({ patterns }: { patterns: readonly OkfPatternCountItem[] }) {
  if (patterns.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="okf-article-patterns">
      {patterns.map((p) => (
        <span
          key={p.pattern}
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]"
        >
          <span className="font-mono">{p.pattern}</span>
          <span className="tabular-nums text-muted-foreground">×{p.count}</span>
        </span>
      ))}
    </div>
  );
}

function RoutingMissBlock({
  data,
  base,
}: {
  data: RepoOkfArticleResponse;
  /** Repo page path the session links hang off (`routes.repo` / `routes.teamRepo`). */
  base: string;
}) {
  const rm = data.routingMiss;
  if (!rm || rm.agents === 0) return null;
  const finding = findingFor(data, 'routing_miss', {
    patterns: patternsParam(rm.patterns),
    area: okfAreaFolder(data.area),
  });
  return (
    <Block
      title="Routing miss"
      testId="okf-article-routing-miss"
      finding={finding}
    >
      <div className="text-xs">
        <span className="font-medium tabular-nums">
          {rm.agents} of {rm.areaAgents}
        </span>{' '}
        agents that searched this article&apos;s area never opened it
      </div>
      <Patterns patterns={rm.patterns} />
      <div className="text-[11px] text-muted-foreground">
        To check by hand: open an agent&apos;s trail below — its searches of
        this area are highlighted, and none of them follows a read of this
        article.
      </div>
      {rm.missing.length > 0 ? (
        <table className="w-full text-xs" data-testid="okf-article-missing">
          <thead>
            <tr className="text-[10px] text-muted-foreground">
              <th className="px-1 text-left font-normal">Session</th>
              <th className="px-1 text-left font-normal">Agent</th>
              <th className="px-1 text-left font-normal">Task</th>
              <th className="px-1 text-right font-normal">Searches</th>
              <th className="px-1 text-left font-normal">Check</th>
            </tr>
          </thead>
          <tbody>
            {rm.missing.map((m) => (
              <tr
                key={`${m.sessionId}:${m.agentId}`}
                data-testid="okf-article-missing-agent"
              >
                <td className="px-1 font-mono text-muted-foreground">
                  {m.sessionId.slice(0, 8)}
                </td>
                <td className="px-1 font-mono">
                  {okfAgentLabel(m.agentId, m.sessionId)}
                </td>
                <td className="max-w-md truncate px-1" title={m.taskHead}>
                  {m.taskHead}
                </td>
                <td className="px-1 text-right tabular-nums">{m.searches}</td>
                <td className="space-x-2 whitespace-nowrap px-1">
                  <OkfTrailLink
                    base={base}
                    sessionId={m.sessionId}
                    agentId={m.agentId}
                  />
                  <Link
                    to={`${base}?session=${encodeURIComponent(m.sessionId)}&tab=bash`}
                    data-testid="okf-article-missing-bash-link"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Bash tab
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Block>
  );
}

function SearchedAfterBlock({
  data,
  base,
}: {
  data: RepoOkfArticleResponse;
  base: string;
}) {
  const sa = data.searchedAfter;
  if (!sa || sa.agents === 0) return null;
  const finding = findingFor(data, 'searched_after', {
    patterns: patternsParam(sa.patterns),
  });
  return (
    <Block
      title="Searched after reading"
      testId="okf-article-searched-after"
      finding={finding}
    >
      <div className="text-xs">
        <span className="font-medium tabular-nums">{sa.agents}</span>{' '}
        {sa.agents === 1 ? 'agent kept' : 'agents kept'} searching its area
        after reading it —{' '}
        <span className="font-medium tabular-nums">{sa.searches}</span>{' '}
        {sa.searches === 1 ? 'search' : 'searches'}
      </div>
      <Patterns patterns={sa.patterns} />
      <OkfSearchedAfterAgents pairs={sa.pairs ?? []} base={base} />
    </Block>
  );
}

function DeadPointersBlock({ data }: { data: RepoOkfArticleResponse }) {
  const dead = data.pointers.filter((p) => p.dead);
  if (dead.length === 0) return null;
  const names = dead.slice(0, DEAD_IN_ACTION).map((p) => p.pointer);
  const finding = findingFor(data, 'dead_pointers', {
    path: `${names.join(', ')}${dead.length > DEAD_IN_ACTION ? ', …' : ''}`,
  });
  return (
    <Block title="Dead pointers" testId="okf-article-dead" finding={finding}>
      <div className="text-xs">
        <span className="font-medium tabular-nums">{dead.length}</span> pointers
        shown to agents and never followed
      </div>
    </Block>
  );
}

function CatalogBlock({ data }: { data: RepoOkfArticleResponse }) {
  if (!data.catalog) return null;
  const finding = findingFor(data, 'catalog', { files: data.catalog.files });
  return (
    <Block title="Catalog" testId="okf-article-catalog" finding={finding}>
      <div className="text-xs">
        Its area has{' '}
        <span className="font-medium tabular-nums">{data.catalog.files}</span>{' '}
        code files — routing misses are not counted for a catalog article
      </div>
    </Block>
  );
}

export function OkfSignalBlocks({
  data,
  repoId,
  teamId,
}: {
  data: RepoOkfArticleResponse;
  repoId: number;
  teamId?: number;
}) {
  const base =
    teamId !== undefined
      ? routes.teamRepo(teamId, repoId)
      : routes.repo(repoId);
  return (
    <div className="space-y-3">
      <RoutingMissBlock data={data} base={base} />
      <SearchedAfterBlock data={data} base={base} />
      <DeadPointersBlock data={data} />
      <CatalogBlock data={data} />
    </div>
  );
}
