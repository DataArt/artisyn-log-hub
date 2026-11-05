import { useQuery } from '@tanstack/react-query';

/** `dist/build.origin.json` as served by `/health/version` — where and how the build was made. */
export interface BuildOrigin {
  branch: string;
  version: string;
  /** ISO 8601 UTC. */
  builtAt: string;
  officialRelease: boolean;
}

export interface BuildVersion {
  version: string;
  gitCommit: string;
  /** Absent on older servers and on unbundled (dev) servers without `build.origin.json`. */
  origin?: BuildOrigin;
}

async function fetchBuildVersion(): Promise<BuildVersion> {
  const res = await fetch('/health/version');
  if (!res.ok) {
    throw new Error(`Failed to fetch build version: ${res.status}`);
  }
  return res.json();
}

/** Public (no auth) endpoint — version never changes for a running process, so cache it forever. */
export function useBuildVersion() {
  return useQuery({
    queryKey: ['build-version'],
    queryFn: fetchBuildVersion,
    staleTime: Infinity,
    retry: false,
  });
}
