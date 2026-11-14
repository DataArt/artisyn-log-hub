import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Countdown of the "Resend confirmation email" button, mirroring the server's 60 s per-account
 * cooldown. `start(seconds)` reseeds it, e.g. from a 429's `Retry-After`.
 */
export function useCooldown() {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const start = useCallback((seconds: number) => {
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
  }, []);

  return { secondsLeft, start };
}
