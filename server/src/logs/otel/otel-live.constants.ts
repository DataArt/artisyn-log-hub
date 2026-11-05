// Constants of the OTEL Live view (2026-11-04 otel-live-view). The live rule itself
// (`OTEL_SESSION_ENDED_MS`) lives in `otel-facts.constants.ts`; the 5-minute grain
// (`OTEL_BUCKET_MS`) in `otel-classify.ts`.

/** Chart / top-list window: 2 h = 24 five-minute buckets (DD-7). */
export const OTEL_LIVE_WINDOW_MS = 7_200_000;

/** Cost-per-minute window: the last 5 min, divided by 5 (DD-8). */
export const OTEL_LIVE_COST_RATE_MS = 300_000;

/** Latest calls listed for an agent node (DD-9). */
export const OTEL_LIVE_AGENT_CALLS_LIMIT = 50;

/** Latest events in the session / agent details panel (DD-10). */
export const OTEL_LIVE_EVENTS_LIMIT = 20;

/** Length of the top users / models / repos lists (DD-10). */
export const OTEL_LIVE_TOP_N = 5;

/** Length of the top tools list (DD-10). */
export const OTEL_LIVE_TOP_TOOLS = 8;

/** First-prompt characters in a session node label (DD-20). */
export const OTEL_LIVE_PROMPT_EXCERPT_CHARS = 80;

/** Agents listed in a session breakdown; the rest count as "+N more" (DD-9, DD-23). */
export const OTEL_LIVE_BREAKDOWN_AGENTS = 50;

/**
 * Ended sessions and agents stay in the tree, greyed, for this long after their last activity
 * (2026-11-05 follow-up): the chart window, so what the charts show the tree lists too. They count
 * in the parents' sums; `liveSessions` / `liveAgents` and the header status stay live-only.
 */
export const OTEL_LIVE_RECENT_MS = OTEL_LIVE_WINDOW_MS;

/** Sankey rows returned at most (largest cost first); the rest are left out. */
export const OTEL_LIVE_FLOW_ROWS = 500;

/** A named (retained) root older than this is not retained, so the key falls back to home (DD-5). */
export const OTEL_LIVE_RETAIN_MAX_MS = 86_400_000;
