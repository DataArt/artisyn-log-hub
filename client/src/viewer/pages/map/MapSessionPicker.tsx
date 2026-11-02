/**
 * The All views picker (FR-E3, wireframe g2): resolves the context a greyed node needs. For a
 * session it lists the recent sessions of the repository (Recent visits) and its latest sessions
 * (`fetchRepositorySessions`, the session list's own query key), searchable by id or first
 * prompt, plus "Open the session list instead →". For a repository or a team it lists the ones
 * the viewer can open. Nothing is picked until the viewer clicks an entry.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FolderGit2, Loader2, MessageSquare, Users } from 'lucide-react';
import { fetchRepositorySessions } from '../../api';
import { formatLocalTimestamp } from '../../lib/format';
import type { RepositorySession } from '../../../models/repositories';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import type { MapRecent } from './map-recent';
import { repoBasePath } from './nav-questions';
import type { NavRepo, NavTeam } from './nav-tree';

/** How many latest sessions are listed without a search; a search looks through all of them. */
const LATEST_LIMIT = 8;
const SEARCH_LIMIT = 20;

/** What the picker resolves, and for which node. */
export interface MapPickerRequest {
  needs: 'team' | 'repo' | 'session';
  /** The repository whose sessions are listed (`needs: 'session'`). */
  repoId?: number;
  /** The node to open once the context is picked; absent when opened from the rail. */
  nodeId?: string;
  /** The label of that node ("then open Statistics"). */
  nodeLabel?: string;
}

export interface MapSessionPickerProps {
  request: MapPickerRequest | null;
  repos: readonly NavRepo[];
  teams: readonly NavTeam[];
  recent: MapRecent;
  onPickSession: (repo: NavRepo, sessionId: string) => void;
  onPickRepo: (repo: NavRepo) => void;
  onPickTeam: (team: NavTeam) => void;
  onClose: () => void;
}

function shortId(id: string): string {
  return id.slice(0, 6);
}

function formatSessionCost(s: RepositorySession): string {
  const cost = s.computedCost ?? s.totalCost;
  return typeof cost === 'number' ? `$${cost.toFixed(2)}` : '—';
}

function matches(query: string, ...fields: (string | null | undefined)[]) {
  if (!query) return true;
  return fields.some((f) => f?.toLowerCase().includes(query));
}

function PickRow({
  testId,
  icon,
  title,
  sub,
  onClick,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {sub && (
          <span className="block truncate text-xs text-muted-foreground">
            {sub}
          </span>
        )}
      </span>
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-2 pt-2 text-xs font-medium uppercase text-muted-foreground">
      {children}
    </h3>
  );
}

function SessionList({
  repo,
  recent,
  query,
  onPick,
}: {
  repo: NavRepo;
  recent: MapRecent;
  query: string;
  onPick: (sessionId: string) => void;
}) {
  const sessionsQuery = useQuery({
    queryKey: ['repo-sessions', repo.id, repo.teamId],
    queryFn: () => fetchRepositorySessions(repo.id, repo.teamId),
    retry: false,
  });
  const sorted = useMemo(
    () =>
      [...(sessionsQuery.data ?? [])].sort((a, b) =>
        b.startTime.localeCompare(a.startTime),
      ),
    [sessionsQuery.data],
  );
  const byId = useMemo(
    () => new Map(sorted.map((s) => [s.sessionId, s])),
    [sorted],
  );

  const recentRows = recent.sessions
    .filter((r) => r.repoId === repo.id)
    .map((r) => ({ entry: r, session: byId.get(r.sessionId) }))
    .filter(({ entry, session }) =>
      matches(query, entry.sessionId, entry.label, session?.firstPrompt),
    );
  const recentIds = new Set(recentRows.map((r) => r.entry.sessionId));
  const latest = sorted
    .filter((s) => !recentIds.has(s.sessionId))
    .filter((s) => matches(query, s.sessionId, s.firstPrompt))
    .slice(0, query ? SEARCH_LIMIT : LATEST_LIMIT);

  const icon = <MessageSquare className="size-3.5" aria-hidden />;
  return (
    <div className="flex flex-col">
      {recentRows.length > 0 && (
        <>
          <SectionTitle>Recent</SectionTitle>
          {recentRows.map(({ entry, session }) => (
            <PickRow
              key={entry.sessionId}
              testId={`map-picker-session-${entry.sessionId}`}
              icon={icon}
              title={`${shortId(entry.sessionId)} · ${session?.firstPrompt ?? entry.label ?? 'Session'}`}
              sub={
                session
                  ? `${formatLocalTimestamp(session.startTime)} · ${formatSessionCost(session)}`
                  : undefined
              }
              onClick={() => onPick(entry.sessionId)}
            />
          ))}
        </>
      )}
      <SectionTitle>Latest</SectionTitle>
      {sessionsQuery.isPending ? (
        <p className="flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Loading sessions…
        </p>
      ) : sessionsQuery.isError ? (
        <p className="px-2 py-1.5 text-sm text-destructive">
          Could not load the sessions.
        </p>
      ) : latest.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          {query ? 'No session matches.' : 'No sessions yet.'}
        </p>
      ) : (
        latest.map((s) => (
          <PickRow
            key={s.sessionId}
            testId={`map-picker-session-${s.sessionId}`}
            icon={icon}
            title={`${shortId(s.sessionId)} · ${s.firstPrompt ?? '(prompt hidden)'}`}
            sub={`${formatLocalTimestamp(s.startTime)} · ${formatSessionCost(s)}`}
            onClick={() => onPick(s.sessionId)}
          />
        ))
      )}
    </div>
  );
}

export function MapSessionPicker({
  request,
  repos,
  teams,
  recent,
  onPickSession,
  onPickRepo,
  onPickTeam,
  onClose,
}: MapSessionPickerProps) {
  const navigate = useNavigate();
  const [rawQuery, setRawQuery] = useState('');
  const query = rawQuery.trim().toLowerCase();

  const repo =
    request?.needs === 'session'
      ? repos.find((r) => r.id === request.repoId)
      : undefined;

  const what =
    request?.needs === 'session'
      ? `a session of ${repo?.label ?? 'this repository'}`
      : request?.needs === 'team'
        ? 'a team'
        : 'a repository';
  const then = request?.nodeLabel
    ? `Then ${request.nodeLabel} opens.`
    : 'It fills the context for every node that needs it.';

  // Recent repositories first, then the rest in list order.
  const repoRows = useMemo(() => {
    const order = new Map(recent.repos.map((r, i) => [r.repoId, i]));
    return [...repos]
      .sort(
        (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
      )
      .filter((r) => matches(query, r.label));
  }, [repos, recent.repos, query]);

  let body: ReactNode;
  if (request?.needs === 'session') {
    body = repo ? (
      <SessionList
        repo={repo}
        recent={recent}
        query={query}
        onPick={(sessionId) => onPickSession(repo, sessionId)}
      />
    ) : (
      <p className="px-2 py-1.5 text-sm text-muted-foreground">
        This repository is not available.
      </p>
    );
  } else if (request?.needs === 'team') {
    const rows = teams.filter((t) => matches(query, t.name));
    body =
      rows.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          No team matches.
        </p>
      ) : (
        rows.map((t) => (
          <PickRow
            key={t.id}
            testId={`map-picker-team-${t.id}`}
            icon={<Users className="size-3.5" aria-hidden />}
            title={t.name}
            onClick={() => onPickTeam(t)}
          />
        ))
      );
  } else {
    body =
      repoRows.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          No repository matches.
        </p>
      ) : (
        repoRows.map((r) => (
          <PickRow
            key={r.id}
            testId={`map-picker-repo-${r.id}`}
            icon={<FolderGit2 className="size-3.5" aria-hidden />}
            title={r.label}
            onClick={() => onPickRepo(r)}
          />
        ))
      );
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) {
          setRawQuery('');
          onClose();
        }
      }}
    >
      <DialogContent data-testid="map-picker" className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle>Pick {what}</DialogTitle>
          <DialogDescription>{then}</DialogDescription>
        </DialogHeader>
        <Input
          data-testid="map-picker-search"
          type="search"
          autoFocus
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          placeholder={
            request?.needs === 'session'
              ? 'Session id or first prompt…'
              : 'Filter by name…'
          }
          aria-label="Search"
        />
        <div className="max-h-[50vh] overflow-y-auto">{body}</div>
        {request?.needs === 'session' && repo && (
          <button
            type="button"
            data-testid="map-picker-session-list"
            className="justify-self-start text-sm text-primary hover:underline"
            onClick={() =>
              void navigate(
                repoBasePath({ repoId: repo.id, teamId: repo.teamId }),
              )
            }
          >
            Open the session list instead →
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}
