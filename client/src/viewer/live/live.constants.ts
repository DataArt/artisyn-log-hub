/**
 * Live view constants (2026-11-04 otel-live-view, DD-21). Polling intervals reuse
 * `OTEL_SESSION_POLL_MS` / `OTEL_REPO_POLL_MS` from `pages/repository/otel/otel.constants.ts`.
 */

/** A session with no OTEL data for this long is ended; mirror of server `OTEL_SESSION_ENDED_MS`. */
export const OTEL_LIVE_ENDED_MS = 600_000;

/** Default width of the left tree pane; the user can drag its splitter (stored per browser). */
export const LIVE_TREE_WIDTH_PX = 260;
export const LIVE_TREE_MIN_WIDTH_PX = 180;

/** Default width of the right details panel; draggable like the tree pane. */
export const LIVE_DETAILS_WIDTH_PX = 320;
export const LIVE_DETAILS_MIN_WIDTH_PX = 240;

/** The middle view pane never gets narrower than this while a splitter is dragged. */
export const LIVE_VIEW_MIN_WIDTH_PX = 360;

/** Header status poll (`LiveNavItem`), only while the page is visible. */
export const LIVE_STATUS_POLL_MS = 10_000;

/** React Query key of the header status (`fetchOtelLiveStatus`). */
export const LIVE_STATUS_QUERY_KEY = ['otel-live-status'] as const;
