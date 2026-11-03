/**
 * The Session Map's time position (session-map DD-18).
 *
 * - `t` is an epoch-ms position within `[start, end]`; `null` while there is no timeline.
 * - **Following** (realtime only): `t` is pinned to the server's "now",
 *   `serverTime + (Date.now() − receivedAt)`, refreshed every `FOLLOW_TICK_MS`. Any scrub
 *   (`setT`), Play or End stops following; Live (`goLive`) resumes it.
 * - **Play**: a `requestAnimationFrame` loop advances `t` by `dtReal × speed` and stops at the end;
 *   Play at the end restarts from the start.
 * - Not following, `t` is clamped into `[start, end]` whenever they change (e.g. a reload's new
 *   snapshot ends earlier, DD-12). A replay opens at the end, a live session following now.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SPEED, FOLLOW_TICK_MS } from './session-map.constants';

export interface UseSessionMapPlaybackOptions {
  /** Timeline start (epoch ms); `null` = no timeline yet. */
  start: number | null;
  /** Timeline end (epoch ms); `null` = no timeline yet. */
  end: number | null;
  /** The session is live (OTEL liveness): following is possible. */
  live: boolean;
  /** Server clock of the last response, epoch ms. */
  serverTimeMs: number | null;
  /** Client epoch ms the last response arrived. */
  receivedAt: number;
}

export interface SessionMapPlayback {
  t: number | null;
  following: boolean;
  playing: boolean;
  speed: number;
  /** Scrub: sets the position and stops following. */
  setT: (t: number) => void;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: number) => void;
  /** Follow now again (realtime). */
  goLive: () => void;
  /** Jump to the end and stop following. */
  goEnd: () => void;
}

function clamp(t: number, start: number, end: number): number {
  return Math.min(end, Math.max(start, t));
}

export function useSessionMapPlayback({
  start,
  end,
  live,
  serverTimeMs,
  receivedAt,
}: UseSessionMapPlaybackOptions): SessionMapPlayback {
  const [following, setFollowing] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  // The scrubbed / played position; `null` = not chosen yet (shows the end, or now).
  const [manualT, setManualT] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const isFollowing = live && following;
  const hasRange = start !== null && end !== null;

  // The server's "now", ticking once per FOLLOW_TICK_MS while following.
  useEffect(() => {
    if (!isFollowing) return;
    setNowTick(Date.now());
    const timer = window.setInterval(
      () => setNowTick(Date.now()),
      FOLLOW_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [isFollowing]);

  let t: number | null = null;
  if (hasRange) {
    if (isFollowing && serverTimeMs !== null) {
      t = Math.max(start, serverTimeMs + Math.max(0, nowTick - receivedAt));
    } else {
      t = clamp(manualT ?? end, start, end);
    }
  }

  // Latest values for the animation loop, which must not restart every frame.
  const tRef = useRef(t);
  tRef.current = t;
  const rangeRef = useRef({ start, end });
  rangeRef.current = { start, end };
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const { start: s, end: e } = rangeRef.current;
      const cur = tRef.current;
      if (s === null || e === null || cur === null) {
        setPlaying(false);
        return;
      }
      const next = Math.min(e, cur + dt * speedRef.current);
      tRef.current = next;
      setManualT(next);
      if (next >= e) {
        setPlaying(false);
        return;
      }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [playing]);

  const setT = useCallback((next: number) => {
    setFollowing(false);
    setManualT(next);
  }, []);

  const play = useCallback(() => {
    const { start: s, end: e } = rangeRef.current;
    const cur = tRef.current;
    if (s === null || e === null) return;
    setFollowing(false);
    setManualT(cur === null || cur >= e ? s : cur);
    setPlaying(true);
  }, []);

  const pause = useCallback(() => setPlaying(false), []);

  const goLive = useCallback(() => {
    setPlaying(false);
    setManualT(null);
    setFollowing(true);
  }, []);

  const goEnd = useCallback(() => {
    setPlaying(false);
    setFollowing(false);
    setManualT(rangeRef.current.end);
  }, []);

  return {
    t,
    following: isFollowing,
    playing,
    speed,
    setT,
    play,
    pause,
    setSpeed,
    goLive,
    goEnd,
  };
}
