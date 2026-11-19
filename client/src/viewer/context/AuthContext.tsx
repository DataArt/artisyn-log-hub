import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserProfile } from '../../models/auth';

export interface AuthContextValue {
  user: UserProfile | null;
  setUser: (u: UserProfile | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUserState] = useState<UserProfile | null>(null);
  const userIdRef = useRef<number | null>(null);

  // When a signed-in user logs out or another identity takes over, the cached
  // data of the previous one (their teams, repositories…) must not be shown
  // or refetched for the next one, so the whole query cache is dropped.
  const setUser = useCallback(
    (next: UserProfile | null) => {
      const previous = userIdRef.current;
      userIdRef.current = next?.id ?? null;
      if (previous !== null && previous !== userIdRef.current) {
        queryClient.removeQueries();
      }
      setUserState(next);
    },
    [queryClient],
  );

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
