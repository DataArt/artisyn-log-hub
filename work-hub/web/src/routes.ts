// Hash-router paths (D16). Pages navigate with these, never with hand-written strings.

export const ROUTE = {
  login: "/login",
  signup: "/signup",
  confirmEmail: "/confirm-email",
  forgotPassword: "/forgot-password",
  resetPassword: "/reset-password",
  workspaces: "/",
  workspace: "/w/:wsId",
  workstream: "/w/:wsId/s/:streamId",
  history: "/w/:wsId/history",
  settings: "/w/:wsId/settings",
} as const;

export const routes = {
  login: ROUTE.login,
  signup: ROUTE.signup,
  forgotPassword: ROUTE.forgotPassword,
  workspaces: ROUTE.workspaces,
  workspace: (wsId: string) => `/w/${encodeURIComponent(wsId)}`,
  workstream: (wsId: string, streamId: string) =>
    `/w/${encodeURIComponent(wsId)}/s/${encodeURIComponent(streamId)}`,
  history: (wsId: string) => `/w/${encodeURIComponent(wsId)}/history`,
  settings: (wsId: string) => `/w/${encodeURIComponent(wsId)}/settings`,
};

/** Where to go after signing in: the page the guard bounced from, else the workspaces list. */
export function returnPath(state: unknown): string {
  if (typeof state === "object" && state !== null && "from" in state) {
    const from = state.from;
    if (
      typeof from === "object" &&
      from !== null &&
      "pathname" in from &&
      typeof from.pathname === "string"
    ) {
      return from.pathname;
    }
  }
  return ROUTE.workspaces;
}
