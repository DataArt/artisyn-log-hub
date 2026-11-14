import { useQuery } from "@tanstack/react-query";

import { fetchAuthConfig } from "../api/auth";

export const authConfigKey = ["auth-config"] as const;

/** Public `GET /auth/config`; the mode never changes while the server runs. */
export function useAuthConfig() {
  return useQuery({
    queryKey: authConfigKey,
    queryFn: fetchAuthConfig,
    staleTime: Infinity,
    retry: false,
  });
}
