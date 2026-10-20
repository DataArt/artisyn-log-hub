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
};

export function projectKeyToPath(key: string): string {
  return key.replace(/^-/, '/').replaceAll('-', '/');
}

export function pathToProjectKey(path: string): string {
  return path.replace(/^\//, '-').replaceAll('/', '-');
}
