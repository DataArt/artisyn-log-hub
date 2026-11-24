/**
 * The Session Map's data: the session's parts manifest and the assembled part bodies — the same
 * pre-compressed, browser-cached parts every other session tab reads — turned into the Map's
 * state, the parsed root session and the map model, memoised on the state only.
 *
 * - Follows a live session (the manifest's `liveness.live`) by re-reading the manifest every
 *   {@link SESSION_MAP_POLL_MS}; a part whose revision changed is then re-fetched by
 *   `useSessionLogParts`, an unchanged one is not. The poll stops while the page is hidden
 *   (TanStack's `refetchIntervalInBackground: false`) and once the session is no longer live.
 * - A failed refetch keeps the last good state on screen (`error` is set).
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchSessionLogParts, type SessionLogsData } from '../../../../api';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { RepoConfig } from '../../../../../models/repositories';
import { parseSessionLogs } from '../log-parser';
import type { ParsedSession } from '../types';
import {
  buildSessionMapState,
  type SessionMapParseInputs,
  type SessionMapState,
  toParseInputs,
} from './session-map-state';
import {
  buildSessionMapModel,
  type SessionMapModel,
} from './session-map-model';
import { SESSION_MAP_POLL_MS } from './session-map.constants';

export interface UseSessionMapDataOptions {
  repoId: number;
  sessionId: string;
  teamId?: number;
  pricing: ModelPricingMap | undefined;
  repoConfig: RepoConfig | null;
  /** The assembled logs of every part (the tab renders behind `AllSessionPartsGate`). */
  logs: SessionLogsData | undefined;
  /** The error of the session's parts query, if any. */
  logsError: Error | null;
}

export interface SessionMapData {
  state: SessionMapState | null;
  parsed: ParsedSession | null;
  inputs: SessionMapParseInputs | null;
  model: SessionMapModel | null;
  /** True until the manifest and the logs are in (or failed). */
  isLoading: boolean;
  /** The latest manifest / part error; with a state on screen it is a transient "update failed". */
  error: Error | null;
}

export function useSessionMapData({
  repoId,
  sessionId,
  teamId,
  pricing,
  repoConfig,
  logs,
  logsError,
}: UseSessionMapDataOptions): SessionMapData {
  // Same key and fetcher as `useSessionLogParts`: this observer only adds the live interval.
  const manifestQuery = useQuery({
    queryKey: ['session-logs', repoId, sessionId, teamId],
    queryFn: () => fetchSessionLogParts(repoId, sessionId, teamId),
    refetchInterval: (query) =>
      query.state.data?.liveness?.live === true ? SESSION_MAP_POLL_MS : false,
  });
  const manifest = manifestQuery.data;
  const receivedAt = manifestQuery.dataUpdatedAt;

  const state = useMemo(
    () =>
      manifest !== undefined && logs !== undefined
        ? buildSessionMapState(manifest, logs, receivedAt)
        : null,
    [manifest, logs, receivedAt],
  );

  const derived = useMemo(() => {
    if (state === null) return null;
    const inputs = toParseInputs(state);
    const parsed = parseSessionLogs(inputs.main, {
      repoConfig,
      subagentStats: inputs.subagentStats,
      workflows: inputs.workflows,
      subagentLogs: inputs.subagentLogs,
      pricing,
      harnessSnapshot: null,
    });
    const serverTimeMs = Date.parse(state.serverTime);
    const model = buildSessionMapModel(parsed, inputs, pricing, {
      live: state.liveness.live,
      serverTimeMs: Number.isNaN(serverTimeMs) ? null : serverTimeMs,
    });
    return { inputs, parsed, model };
  }, [state, repoConfig, pricing]);

  const error = manifestQuery.error ?? logsError;
  return {
    state,
    parsed: derived?.parsed ?? null,
    inputs: derived?.inputs ?? null,
    model: derived?.model ?? null,
    isLoading: state === null && error === null,
    error,
  };
}
