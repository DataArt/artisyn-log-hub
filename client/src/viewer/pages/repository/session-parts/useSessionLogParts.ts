import { useCallback, useMemo, useRef, useState } from 'react';
import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  fetchSessionLogPart,
  fetchSessionLogParts,
  type SessionLogLine,
  type SessionLogPart,
  type SessionLogPartsManifest,
  type SessionLogsData,
} from '../../../api';
import {
  buildAgentParentMap,
  buildSubagentMeta,
  type SubagentMetaMap,
} from '../session-log/log-parser';
import {
  assembleSessionLogs,
  isRootSessionLogPart,
  sessionLogPartKey,
} from './assemble-session-logs';

/** How many sub-agent parts load at the same time (the root parts never wait for this). */
export const PART_LOAD_CONCURRENCY = 3;

const AGENT_PREFIX = 'agent-';

function stripAgentPrefix(id: string): string {
  return id.startsWith(AGENT_PREFIX) ? id.slice(AGENT_PREFIX.length) : id;
}

/**
 * The read-only slice of a query result the session views use, built from the manifest query
 * plus the root parts. `data` is the legacy `SessionLogsData` shape (see `assembleSessionLogs`),
 * so a view written against `/logs` keeps working.
 */
export interface SessionLogsQueryView {
  data: SessionLogsData | undefined;
  error: Error | null;
  isPending: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
}

export interface SessionLogPartsResult {
  /** The manifest query; its key is the historic `['session-logs', repoId, sessionId, teamId]`. */
  manifestQuery: UseQueryResult<SessionLogPartsManifest>;
  /** The manifest plus the root parts and every loaded sub-agent part, as one query view. */
  logsQuery: SessionLogsQueryView;
  /** The assembled logs; `undefined` until the manifest and both root parts are in. */
  logsData: SessionLogsData | undefined;
  /** Loaded sub-agent bodies keyed by bare agent id. */
  subagentLogsMap: Map<string, Record<string, unknown>[]>;
  /** agentId -> parent agentId for every sub-agent part of the manifest (loaded or not). */
  agentParentMap: Map<string, string | null>;
  /** `.meta.json` labels of every sub-agent part of the manifest (loaded or not). */
  subagentMeta: SubagentMetaMap;
  /** Bare agent ids of every sub-agent part of the manifest. */
  knownAgentIds: Set<string>;
  requestAgent(id: string, withDescendants: boolean): Promise<void>;
  requestAll(): Promise<void>;
  loaded: number;
  total: number;
  allLoaded: boolean;
}

interface PartRequests {
  scope: string;
  ids: ReadonlySet<string>;
  all: boolean;
}

const NO_REQUESTS: Omit<PartRequests, 'scope'> = {
  ids: new Set<string>(),
  all: false,
};

/** A FIFO semaphore: at most `max` tasks run at once; a finished task hands its slot on. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function partQueryKey(
  repoId: number,
  sessionId: string,
  part: Pick<SessionLogPart, 'sessionId' | 'logType'>,
): readonly unknown[] {
  return ['session-log-part', repoId, sessionId, part.sessionId, part.logType];
}

/**
 * A part whose revision changed keeps showing its previous body until the new one arrives, so
 * a live refetch never blanks a view. The cache holds older revisions under the same key prefix.
 */
function cachedBodyOfAnyRev(
  queryClient: QueryClient,
  repoId: number,
  sessionId: string,
  part: SessionLogPart,
): SessionLogLine[] | undefined {
  let best: { at: number; lines: SessionLogLine[] } | undefined;
  for (const [key, lines] of queryClient.getQueriesData<SessionLogLine[]>({
    queryKey: partQueryKey(repoId, sessionId, part),
  })) {
    if (lines === undefined) continue;
    const at = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
    if (best === undefined || at > best.at) best = { at, lines };
  }
  return best?.lines;
}

/** `ids` (with `agent-` prefix) plus, when asked, every descendant by `parentSessionId`. */
function collectTargetIds(
  subParts: SessionLogPart[],
  rootIds: string[],
  withDescendants: boolean,
): Set<string> {
  const ids = new Set(rootIds);
  if (!withDescendants) return ids;
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of subParts) {
      if (
        !ids.has(p.sessionId) &&
        p.parentSessionId !== null &&
        ids.has(p.parentSessionId)
      ) {
        ids.add(p.sessionId);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Loads a session's logs in parts (impl-plan DD-13, DD-30a): the manifest under the historic
 * `session-logs` key (so the watermark and every invalidator refetch only the manifest), the
 * root's claude and artisyn parts at once, and sub-agent parts only on `requestAgent` /
 * `requestAll`, at most {@link PART_LOAD_CONCURRENCY} at a time. Part keys carry the revision
 * and never go stale, so a manifest refetch reloads only the parts that are loaded and changed.
 */
export function useSessionLogParts({
  repoId,
  sessionId,
  teamId,
}: {
  repoId: number;
  sessionId: string | undefined;
  teamId?: number;
}): SessionLogPartsResult {
  const queryClient = useQueryClient();
  const limiterRef = useRef<ReturnType<typeof createLimiter> | null>(null);
  limiterRef.current ??= createLimiter(PART_LOAD_CONCURRENCY);
  const limiter = limiterRef.current;

  const enabled = sessionId !== undefined;
  const manifestKey = useMemo(
    () => ['session-logs', repoId, sessionId, teamId] as const,
    [repoId, sessionId, teamId],
  );
  const manifestQuery = useQuery({
    queryKey: manifestKey,
    queryFn: () => fetchSessionLogParts(repoId, sessionId!, teamId),
    enabled,
  });
  const manifest = manifestQuery.data;

  const partOptions = useCallback(
    (part: SessionLogPart) => ({
      queryKey: [...partQueryKey(repoId, sessionId!, part), part.rev],
      queryFn: () => {
        const load = () =>
          fetchSessionLogPart(repoId, sessionId!, part, teamId);
        return isRootSessionLogPart(part) ? load() : limiter(load);
      },
      staleTime: Infinity,
      // A key is one immutable revision: deep-comparing a large body buys nothing.
      structuralSharing: false,
    }),
    [repoId, sessionId, teamId, limiter],
  );

  const scope = `${repoId}|${sessionId ?? ''}|${teamId ?? ''}`;
  const [requests, setRequests] = useState<PartRequests>({
    scope,
    ids: new Set(),
    all: false,
  });
  const activeRequests = useMemo(
    () => (requests.scope === scope ? requests : NO_REQUESTS),
    [requests, scope],
  );

  const wantedParts = useMemo(() => {
    if (!manifest) return [];
    return manifest.parts.filter(
      (p) =>
        isRootSessionLogPart(p) ||
        activeRequests.all ||
        activeRequests.ids.has(p.sessionId),
    );
  }, [manifest, activeRequests.all, activeRequests.ids]);

  // No `combine`: useQueries runs a combined value through `replaceEqualDeep`, which would walk
  // every loaded log body on each state change of any part. The results array is read directly
  // and the bodies map is rebuilt only when a part's data revision (`dataUpdatedAt`) changes.
  const partResults: UseQueryResult<SessionLogLine[]>[] = useQueries({
    queries: wantedParts.map((p) => ({ ...partOptions(p), enabled })),
  });

  let partsError: Error | null = null;
  let partsUpdatedAt = 0;
  let partsFetching = false;
  for (const r of partResults) {
    if (partsError === null && r.error) partsError = r.error;
    if (r.dataUpdatedAt > partsUpdatedAt) partsUpdatedAt = r.dataUpdatedAt;
    if (r.isFetching) partsFetching = true;
  }
  const bodiesVersion = partResults
    .map((r) => (r.data === undefined ? '-' : String(r.dataUpdatedAt)))
    .join(',');
  const partResultsRef = useRef(partResults);
  partResultsRef.current = partResults;

  const bodies = useMemo(() => {
    const map = new Map<string, SessionLogLine[]>();
    if (!sessionId) return map;
    const results = partResultsRef.current;
    wantedParts.forEach((part, i) => {
      const lines =
        results[i]?.data ??
        cachedBodyOfAnyRev(queryClient, repoId, sessionId, part);
      if (lines !== undefined) map.set(sessionLogPartKey(part), lines);
    });
    return map;
    // `bodiesVersion` stands for the part results: it changes exactly when a body does.
  }, [wantedParts, bodiesVersion, queryClient, repoId, sessionId]);

  const rootReady =
    manifest !== undefined &&
    manifest.parts
      .filter(isRootSessionLogPart)
      .every((p) => bodies.has(sessionLogPartKey(p)));

  const logsData = useMemo(
    () =>
      manifest !== undefined && rootReady
        ? assembleSessionLogs(manifest, bodies)
        : undefined,
    [manifest, rootReady, bodies],
  );

  const subagentLogsMap = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const sa of logsData?.subagents ?? []) {
      map.set(stripAgentPrefix(sa.sessionId), sa.logs);
    }
    return map;
  }, [logsData]);

  const subParts = useMemo(
    () => manifest?.parts.filter((p) => !isRootSessionLogPart(p)) ?? [],
    [manifest],
  );
  const agentParentMap = useMemo(
    () => buildAgentParentMap(subParts),
    [subParts],
  );
  const subagentMeta = useMemo(() => buildSubagentMeta(subParts), [subParts]);
  const knownAgentIds = useMemo(
    () => new Set(subParts.map((p) => stripAgentPrefix(p.sessionId))),
    [subParts],
  );

  const loadParts = useCallback(
    async (pick: (subParts: SessionLogPart[]) => SessionLogPart[]) => {
      if (sessionId === undefined) return;
      let current: SessionLogPartsManifest;
      try {
        current = await queryClient.ensureQueryData({
          queryKey: manifestKey,
          queryFn: () => fetchSessionLogParts(repoId, sessionId, teamId),
        });
      } catch {
        return; // The manifest query shows the error.
      }
      const targets = pick(
        current.parts.filter((p) => !isRootSessionLogPart(p)),
      );
      // Failures stay visible on the part queries; the caller only waits.
      await Promise.allSettled(
        targets.map((p) => queryClient.fetchQuery(partOptions(p))),
      );
    },
    [sessionId, queryClient, manifestKey, repoId, teamId, partOptions],
  );

  const requestAgent = useCallback(
    async (id: string, withDescendants: boolean) => {
      await loadParts((all) => {
        const ids = collectTargetIds(
          all,
          [`${AGENT_PREFIX}${stripAgentPrefix(id)}`],
          withDescendants,
        );
        setRequests((prev) => {
          const base =
            prev.scope === scope
              ? prev
              : { scope, ids: new Set<string>(), all: false };
          if ([...ids].every((x) => base.ids.has(x))) return base;
          return { ...base, ids: new Set([...base.ids, ...ids]) };
        });
        return all.filter((p) => ids.has(p.sessionId));
      });
    },
    [loadParts, scope],
  );

  const requestAll = useCallback(async () => {
    await loadParts((all) => {
      setRequests((prev) =>
        prev.scope === scope && prev.all
          ? prev
          : {
              scope,
              ids: prev.scope === scope ? prev.ids : new Set<string>(),
              all: true,
            },
      );
      return all;
    });
  }, [loadParts, scope]);

  const total = manifest?.parts.length ?? 0;
  const loaded = manifest ? bodies.size : 0;
  const allLoaded = manifest !== undefined && loaded === total;

  const error = manifestQuery.error ?? partsError;
  const isFetching = manifestQuery.isFetching || partsFetching;
  const dataUpdatedAt = Math.max(manifestQuery.dataUpdatedAt, partsUpdatedAt);
  const logsQuery = useMemo<SessionLogsQueryView>(
    () => ({
      data: logsData,
      error,
      isPending: logsData === undefined && error === null,
      isLoading: enabled && logsData === undefined && error === null,
      isSuccess: logsData !== undefined && error === null,
      isError: error !== null,
      isFetching,
      dataUpdatedAt,
    }),
    [logsData, error, enabled, isFetching, dataUpdatedAt],
  );

  return {
    manifestQuery,
    logsQuery,
    logsData,
    subagentLogsMap,
    agentParentMap,
    subagentMeta,
    knownAgentIds,
    requestAgent,
    requestAll,
    loaded,
    total,
    allLoaded,
  };
}
