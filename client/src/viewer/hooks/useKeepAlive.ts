import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { pingSession } from '../api';

export function useKeepAlive(): void {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => {
      pingSession().catch(() => {
        // 401 is handled by apiFetch → setUnauthorizedHandler
      });
    }, 60_000);
    return () => clearInterval(id);
  }, [user]);
}
