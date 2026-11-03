/**
 * The Session Map's data (session-map DD-10, DD-12): polls `GET …/logs/delta` through the shared
 * `useOtelLivePoll` loop, merges each answer with `mergeSessionMapDelta`, and derives the parsed
 * root session and the map model — memoised on the merged state only, so a poll that changed
 * nothing (same state object) rebuilds nothing.
 *
 * - `{reload: true}` bumps `reloadGen` (a new `resetKey` → one empty-cursor snapshot) and
 *   invalidates the `/logs` query, which no longer matches either. The last good state stays on
 *   screen until the snapshot arrives.
 * - A failed poll keeps the last good state (`error` is set, polling continues). A 403 / 404 is
 *   fatal: the state is dropped and polling stops until the session (or team) changes.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, fetchSessionLogsDelta } from '../../../../api';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { RepoConfig } from '../../../../../models/repositories';
import {
  type OtelLiveIndicatorState,
  type OtelPollStep,
  useOtelLivePoll,
} from '../../otel/useOtelLivePoll';
import { EMPTY_OTEL_NEW_KEYS, NO_OTEL_FILLED } from '../../otel/otel-merge';
import { parseSessionLogs } from '../log-parser';
import type { ParsedSession } from '../types';
import {
  emptyMapState,
  mergeSessionMapDelta,
  type SessionMapParseInputs,
  type SessionMapState,
  toParseInputs,
} from './session-map-delta-merge';
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
}

export interface SessionMapData {
  state: SessionMapState | null;
  parsed: ParsedSession | null;
  inputs: SessionMapParseInputs | null;
  model: SessionMapModel | null;
  /** True until the first snapshot arrived (or failed). */
  isLoading: boolean;
  /** The latest poll error; with a state on screen it is a transient "update failed". */
  error: unknown;
  /** 403 / 404: the state is dropped and polling stopped until the session changes. */
  fatal: boolean;
  indicator: OtelLiveIndicatorState;
  lastUpdatedAt: number | null;
  /** Bumped on every `{reload: true}`; the playback clamps its position on a change. */
  reloadGen: number;
  /** Polls now (the header Refresh button). */
  refresh: () => void;
}

const isMapLive = (s: SessionMapState): boolean => s.liveness.live;

function isFatalError(e: unknown): boolean {
  return (
    e instanceof ApiError && (e.statusCode === 403 || e.statusCode === 404)
  );
}

export function useSessionMapData({
  repoId,
  sessionId,
  teamId,
  pricing,
  repoConfig,
}: UseSessionMapDataOptions): SessionMapData {
  const queryClient = useQueryClient();
  const [reloadGen, setReloadGen] = useState(0);
  const baseKey = `${repoId}|${sessionId}|${teamId ?? ''}`;
  const resetKey = `${baseKey}|${reloadGen}`;

  // A fatal error is remembered per resetKey: a new session (or reload) polls again.
  const [fatalKey, setFatalKey] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<unknown>(null);
  const fatal = fatalKey === resetKey;

  const poll = useCallback<OtelPollStep<SessionMapState>>(
    async (prev, signal) => {
      const cursor = prev !== null && prev.cursor !== '' ? prev.cursor : null;
      const delta = await fetchSessionLogsDelta(
        repoId,
        sessionId,
        cursor,
        teamId,
        signal,
      );
      if (delta.reload) {
        setReloadGen((g) => g + 1);
        void queryClient.invalidateQueries({
          queryKey: ['session-logs', repoId, sessionId, teamId],
        });
        return {
          state: prev ?? emptyMapState,
          newKeys: EMPTY_OTEL_NEW_KEYS,
          filled: NO_OTEL_FILLED,
        };
      }
      return {
        state: mergeSessionMapDelta(cursor === null ? null : prev, delta),
        newKeys: EMPTY_OTEL_NEW_KEYS,
        filled: NO_OTEL_FILLED,
      };
    },
    [repoId, sessionId, teamId, queryClient],
  );

  const live = useOtelLivePoll<SessionMapState>({
    resetKey,
    enabled: !fatal,
    intervalMs: SESSION_MAP_POLL_MS,
    poll,
    isLive: isMapLive,
  });

  useEffect(() => {
    if (isFatalError(live.error)) {
      setFatalKey(resetKey);
      setFatalError(live.error);
    }
  }, [live.error, resetKey]);

  // The last good state of this session survives the reset a reload causes, so the Map does not
  // flash its loading state while the empty-cursor snapshot is on its way.
  const heldRef = useRef<{ key: string; state: SessionMapState } | null>(null);
  if (live.state !== null)
    heldRef.current = { key: baseKey, state: live.state };
  else if (fatal || heldRef.current?.key !== baseKey) heldRef.current = null;
  const state = live.state ?? heldRef.current?.state ?? null;

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

  return {
    state,
    parsed: derived?.parsed ?? null,
    inputs: derived?.inputs ?? null,
    model: derived?.model ?? null,
    isLoading: state === null && !fatal && live.isLoading,
    error: fatal ? fatalError : live.error,
    fatal,
    indicator: live.indicator,
    lastUpdatedAt: live.lastUpdatedAt,
    reloadGen,
    refresh: live.refresh,
  };
}
