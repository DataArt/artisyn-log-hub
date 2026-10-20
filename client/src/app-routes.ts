/**
 * Every leaf route path of the app router in `main.tsx`.
 *
 * A pure module: no component, router, CSS or asset imports, so Node-side tooling (the scenario
 * tours and their meta-test) can load the route list without a bundler. `main.tsx` builds its
 * router from these values only — a vitest test fails on any string `path:` literal there.
 */
export const ROUTE = {
  login: '/login',
  signup: '/signup',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  confirmEmail: '/confirm-email',
  main: '/main',
  teams: '/teams',
  teamDetail: '/teams/:teamId',
  apiKeys: '/api-keys',
  repo: '/repos/:repoId',
  teamRepo: '/teams/:teamId/repos/:repoId',
  hookState: '/repos/:repoId/hook-state',
  admin: '/admin',
  // Catch-all: an unknown path inside the authenticated layout redirects to `/main`.
  notFound: '*',
} as const;

export type RouteKey = keyof typeof ROUTE;
export type RoutePath = (typeof ROUTE)[RouteKey];

export const APP_ROUTES: readonly RoutePath[] = Object.values(ROUTE);

/**
 * Who may reach each route: `public` sits outside `AuthGuard`, `auth` inside it, `admin`
 * additionally inside `AdminGuard`. Mirrors the guard nesting in `main.tsx`.
 */
export const ROUTE_ACCESS: Record<RoutePath, 'public' | 'auth' | 'admin'> = {
  [ROUTE.login]: 'public',
  [ROUTE.signup]: 'public',
  [ROUTE.forgotPassword]: 'public',
  [ROUTE.resetPassword]: 'public',
  [ROUTE.confirmEmail]: 'public',
  [ROUTE.main]: 'auth',
  [ROUTE.teams]: 'auth',
  [ROUTE.teamDetail]: 'auth',
  [ROUTE.apiKeys]: 'auth',
  [ROUTE.repo]: 'auth',
  [ROUTE.teamRepo]: 'auth',
  [ROUTE.hookState]: 'auth',
  [ROUTE.admin]: 'admin',
  [ROUTE.notFound]: 'auth',
};
