// Route path builders — used throughout the app to construct typed URL paths.
// Navigation itself is done via React Router's useNavigate() hook.
// For in-page URL state syncing (filters, selected items) use setSearchParams from useSearchParams().
export const routes = {
  login: '/login',
  signup: '/signup',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  confirmEmail: '/confirm-email',
  main: '/main',
  teams: '/teams',
  team: (id: number) => `/teams/${id}`,
  apiKeys: '/api-keys',
  admin: '/admin',
  repo: (id: number) => `/repos/${id}`,
  teamRepo: (teamId: number, repoId: number) =>
    `/teams/${teamId}/repos/${repoId}`,
  hookState: (repoId: number) => `/repos/${repoId}/hook-state`,
  /** The All views map; the params prefill its context rail and filter. */
  map: (params?: MapRouteParams) => {
    const search = new URLSearchParams();
    if (params?.teamId !== undefined)
      search.set('teamId', String(params.teamId));
    if (params?.repoId !== undefined)
      search.set('repoId', String(params.repoId));
    if (params?.session) search.set('session', params.session);
    if (params?.q) search.set('q', params.q);
    const qs = search.toString();
    return qs ? `/map?${qs}` : '/map';
  },
};

export interface MapRouteParams {
  teamId?: number;
  repoId?: number;
  session?: string;
  q?: string;
}

export function projectKeyToPath(key: string): string {
  return key.replace(/^-/, '/').replaceAll('-', '/');
}

export function pathToProjectKey(path: string): string {
  return path.replace(/^\//, '-').replaceAll('/', '-');
}
