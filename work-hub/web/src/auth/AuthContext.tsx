import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { fetchMe, isUnauthorized, type UserProfile } from "../api/auth";
import { clearUnauthorizedGuard, setUnauthorizedHandler } from "../api/client";

/** `loading` until the first `GET /auth/me` answers; `error` when the server is unreachable. */
export type AuthStatus = "loading" | "ready" | "error";

export interface AuthContextValue {
  user: UserProfile | null;
  status: AuthStatus;
  /** Sets the signed-in user (after login, identify, sign-up) or clears it (logout). */
  setUser: (u: UserProfile | null) => void;
  /** Re-runs `GET /auth/me` (the bootstrap "Retry"). */
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function goToLogin() {
  if (!window.location.hash.startsWith("#/login")) {
    window.location.hash = "#/login";
  }
}

/**
 * Holds the signed-in user, resolved from `GET /auth/me` on start. Any 401 from the API first
 * retries `me` (mode `none` re-identifies a local request silently), then clears the user and
 * goes to `#/login`.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUserState] = useState<UserProfile | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const userIdRef = useRef<number | null>(null);

  const setUser = useCallback(
    (u: UserProfile | null) => {
      // Another identity must never see the previous one's cached data.
      if ((u?.id ?? null) !== userIdRef.current) {
        queryClient.removeQueries({
          predicate: (q) => q.queryKey[0] !== "auth-config",
        });
      }
      userIdRef.current = u?.id ?? null;
      clearUnauthorizedGuard();
      setUserState(u);
    },
    [queryClient],
  );

  const refresh = useCallback(() => {
    setStatus("loading");
    fetchMe()
      .then((profile) => {
        setUser(profile);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) {
          setUser(null);
          setStatus("ready");
        } else {
          setStatus("error");
        }
      });
  }, [setUser]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      fetchMe()
        .then((profile) => setUser(profile))
        .catch(() => {
          setUser(null);
          goToLogin();
        })
        .finally(() => clearUnauthorizedGuard());
    });
    return () => setUnauthorizedHandler(null);
  }, [setUser]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, status, setUser, refresh }),
    [user, status, setUser, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
