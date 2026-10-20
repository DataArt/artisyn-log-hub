import { useQuery } from '@tanstack/react-query';

interface BuildVersion {
  version: string;
  gitCommit: string;
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
