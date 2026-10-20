import { useEffect, useRef, useState } from 'react';

/**
 * Countdown used by every "Resend" action (Signup's confirmation panel, the
 * Admin Panel's pending-registrations table) — mirrors the server's 60s
 * per-account cooldown. `start(seconds)` reseeds the countdown, e.g. from a
 * 429 response's `Retry-After` value instead of the default 60.
 */
export function useCooldown() {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function start(seconds: number) {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setSecondsLeft(seconds);
    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  return { secondsLeft, start };
}
