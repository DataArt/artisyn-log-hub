import { useQuery } from '@tanstack/react-query';
import { fetchAuthConfig } from '../api';

/** Public (no-auth) endpoint the login page calls before mounting any form. */
export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config'],
    queryFn: fetchAuthConfig,
    staleTime: Infinity,
    retry: false,
  });
}
