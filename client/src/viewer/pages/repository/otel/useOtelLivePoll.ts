/**
 * Live polling of an OTEL tab (2026-10-30 otel-tabs-traces, DD-20).
 *
 * One hook for the session tab (`since=` deltas merged with `mergeOtelDelta`) and the repository
 * / team tabs (snapshots compared with `diffOtelBuckets`): the caller passes a `poll` step that
 * fetches and merges, see `sessionOtelPollStep` / `snapshotOtelPollStep`.
 *
 * | Tab | Interval | Polls while |
 * |---|---|---|
 * | Session | `OTEL_SESSION_POLL_MS` | page visible, input within `OTEL_IDLE_STOP_MS`, `status.live` |
 * | Repository, team | `OTEL_REPO_POLL_MS` | the period includes now, plus visibility and idle |
 *
 * A return to a visible page, or the first input after an idle stop, sends one catch-up poll at
 * once. A change of `resetKey` (filters, interval, stack-by, tz) drops the state and loads a new
 * snapshot (DD-19). `newKeys` are cleared after `OTEL_HIGHLIGHT_MS`; `filled` after
 * `OTEL_FILLED_NOTICE_MS`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OtelBucket,
  SessionOtelResponse,
} from '../../../../models/repositories';
import {
  diffOtelBuckets,
  EMPTY_OTEL_NEW_KEYS,
  mergeOtelDelta,
  NO_OTEL_FILLED,
  type OtelFilledCounts,
  type OtelMergeResult,
  type OtelNewKeys,
} from './otel-merge';
import {
  OTEL_FILLED_NOTICE_MS,
  OTEL_HIGHLIGHT_MS,
  OTEL_IDLE_STOP_MS,
} from './otel.constants';

/**
 * What the live indicator shows:
 * - `loading` — no data yet;
 * - `live` — polling;
 * - `slow` — polling, but the data itself updates slowly (`isSlow`, DD-15);
 * - `hidden` — paused while the page is hidden;
 * - `idle` — paused after `OTEL_IDLE_STOP_MS` without input (any input resumes);
 * - `paused` — paused by the user's Pause button (FR-28); Resume sends one catch-up poll;
 * - `ended` — nothing more to wait for (session no longer live, or the period is over).
 */
export type OtelLiveIndicatorState =
  | 'loading'
  | 'live'
  | 'slow'
  | 'hidden'
  | 'idle'
  | 'paused'
  | 'ended';

/** One poll: fetches with the current state (`null` → snapshot) and merges the answer. */
export type OtelPollStep<S> = (
  prev: S | null,
  signal: AbortSignal,
) => Promise<OtelMergeResult<S>>;

export interface UseOtelLivePollOptions<S> {
  /** Any change drops the state and loads a fresh snapshot. */
  resetKey: string;
  /** False: no request at all (e.g. the tab is not shown). */
  enabled: boolean;
  intervalMs: number;
  poll: OtelPollStep<S>;
  /** Whether more data can still arrive (session `status.live`, repository period ≥ now). */
  isLive: (state: S) => boolean;
  /** The data updates slowly (old hook / realtime off), shown as `slow` while live. */
  isSlow?: (state: S) => boolean;
}

export interface OtelLivePollResult<S> {
  state: S | null;
  error: unknown;
  /** True until the first snapshot of the current `resetKey` arrived (or failed). */
  isLoading: boolean;
  /** Highlighted keys of the latest poll; empty again after `OTEL_HIGHLIGHT_MS`. */
  newKeys: OtelNewKeys;
  /** Rows filled from the regular upload by the latest poll; zero after a while. */
  filled: OtelFilledCounts;
  indicator: OtelLiveIndicatorState;
  /** The user's Pause (FR-28): no timer while true. */
  paused: boolean;
  /** Pause / Resume; resuming sends one catch-up poll, like the return from a hidden tab. */
  setPaused: (paused: boolean) => void;
  /** When the latest poll answered (ms epoch); null before the first answer. */
  lastUpdatedAt: number | null;
  /** Polls now (e.g. a manual refresh); ignored while a request is in flight. */
  refresh: () => void;
}

/** The session route step: `since=` from the state's cursor, merged by `mergeOtelDelta`. */
export function sessionOtelPollStep(
  fetchSession: (
    since: string | null,
    signal: AbortSignal,
  ) => Promise<SessionOtelResponse>,
): OtelPollStep<SessionOtelResponse> {
  return async (prev, signal) =>
    mergeOtelDelta(prev, await fetchSession(prev?.cursor ?? null, signal));
}

/** The repository / team step: a full snapshot each time, compared by `diffOtelBuckets`. */
export function snapshotOtelPollStep<S extends { buckets: OtelBucket[] }>(
  fetchSnapshot: (signal: AbortSignal) => Promise<S>,
): OtelPollStep<S> {
  return async (prev, signal) =>
    diffOtelBuckets(prev, await fetchSnapshot(signal));
}

const INPUT_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
] as const;

function pageVisible(): boolean {
  return (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
}

export function useOtelLivePoll<S>({
  resetKey,
  enabled,
  intervalMs,
  poll,
  isLive,
  isSlow,
}: UseOtelLivePollOptions<S>): OtelLivePollResult<S> {
  const [state, setState] = useState<S | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [newKeys, setNewKeys] = useState<OtelNewKeys>(EMPTY_OTEL_NEW_KEYS);
  const [filled, setFilled] = useState<OtelFilledCounts>(NO_OTEL_FILLED);
  const [visible, setVisible] = useState(pageVisible);
  const [idle, setIdle] = useState(false);
  const [paused, setPausedState] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  // Latest values for the async loop, which must not restart on every render.
  const stateRef = useRef<S | null>(null);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);
  const lastInputRef = useRef(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const runPoll = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await pollRef.current(stateRef.current, controller.signal);
      if (generation !== generationRef.current) return;
      stateRef.current = result.state;
      setState(result.state);
      setError(null);
      setLastUpdatedAt(Date.now());
      const k = result.newKeys;
      if (k.spans.size > 0 || k.calls.size > 0 || k.buckets.size > 0) {
        setNewKeys(k);
      }
      if (result.filled.calls > 0 || result.filled.spans > 0) {
        setFilled(result.filled);
      }
    } catch (e) {
      if (generation !== generationRef.current || controller.signal.aborted) {
        return;
      }
      setError(e);
    } finally {
      if (generation === generationRef.current) {
        inFlightRef.current = false;
        abortRef.current = null;
        setIsLoading(false);
      }
    }
  }, []);

  // A new resetKey: drop everything and load a snapshot.
  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    stateRef.current = null;
    setState(null);
    setError(null);
    setNewKeys(EMPTY_OTEL_NEW_KEYS);
    setFilled(NO_OTEL_FILLED);
    setLastUpdatedAt(null);
    setIsLoading(true);
    if (enabled) void runPoll();
  }, [resetKey, enabled, runPoll]);

  // Abort the request in flight on unmount.
  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  // Page visibility: hidden stops polling, the return sends one catch-up poll.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => {
      const nowVisible = pageVisible();
      setVisible(nowVisible);
      if (
        nowVisible &&
        enabled &&
        !pausedRef.current &&
        stateRef.current !== null
      ) {
        void runPoll();
      }
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [enabled, runPoll]);

  // Input tracking: idle after OTEL_IDLE_STOP_MS without input; input resumes with a catch-up.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let idleNow = false;
    const onInput = () => {
      lastInputRef.current = Date.now();
      if (idleNow) {
        idleNow = false;
        setIdle(false);
        if (enabled && !pausedRef.current && stateRef.current !== null) {
          void runPoll();
        }
      }
    };
    const check = window.setInterval(
      () => {
        if (
          !idleNow &&
          Date.now() - lastInputRef.current >= OTEL_IDLE_STOP_MS
        ) {
          idleNow = true;
          setIdle(true);
        }
      },
      Math.min(OTEL_IDLE_STOP_MS, 30_000),
    );
    for (const ev of INPUT_EVENTS) {
      window.addEventListener(ev, onInput, { passive: true });
    }
    return () => {
      window.clearInterval(check);
      for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput);
    };
  }, [enabled, runPoll]);

  const live = state !== null && isLive(state);
  const polling = enabled && visible && !idle && !paused && live;

  // The poll timer: one request every intervalMs while polling.
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => void runPoll(), intervalMs);
    return () => window.clearInterval(timer);
  }, [polling, intervalMs, runPoll]);

  // Highlights fade after OTEL_HIGHLIGHT_MS; a newer poll restarts the timer.
  useEffect(() => {
    if (newKeys === EMPTY_OTEL_NEW_KEYS) return;
    const t = window.setTimeout(
      () => setNewKeys(EMPTY_OTEL_NEW_KEYS),
      OTEL_HIGHLIGHT_MS,
    );
    return () => window.clearTimeout(t);
  }, [newKeys]);

  // The "filled" notice is transient.
  useEffect(() => {
    if (filled === NO_OTEL_FILLED) return;
    const t = window.setTimeout(
      () => setFilled(NO_OTEL_FILLED),
      OTEL_FILLED_NOTICE_MS,
    );
    return () => window.clearTimeout(t);
  }, [filled]);

  const refresh = useCallback(() => {
    if (enabled) void runPoll();
  }, [enabled, runPoll]);

  const setPaused = useCallback(
    (next: boolean) => {
      setPausedState(next);
      if (!next && enabled && stateRef.current !== null) void runPoll();
    },
    [enabled, runPoll],
  );

  let indicator: OtelLiveIndicatorState;
  if (state === null) indicator = 'loading';
  else if (!live) indicator = 'ended';
  else if (paused) indicator = 'paused';
  else if (!visible) indicator = 'hidden';
  else if (idle) indicator = 'idle';
  else if (isSlow?.(state)) indicator = 'slow';
  else indicator = 'live';

  return {
    state,
    error,
    isLoading,
    newKeys,
    filled,
    indicator,
    paused,
    setPaused,
    lastUpdatedAt,
    refresh,
  };
}
