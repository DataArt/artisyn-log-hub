import { RequestMethod } from '@nestjs/common';

/**
 * Request-body size limits.
 *
 * - Every route gets the small {@link GLOBAL_BODY_LIMIT} json/urlencoded/text parsers
 *   (`app.module.ts`), except the routes listed below.
 * - The log-ingest route(s) keep their own parsers at `getLogsBodyLimit()`
 *   (`logs/logs.module.ts`).
 * - The hook's small JSON APIs ({@link HOOK_API_ROUTES}) get {@link HOOK_API_BODY_LIMIT}
 *   (`app.module.ts`).
 *
 * An oversize body is rejected by body-parser with 413.
 */

/** Default body limit for every route that is not a hook/log route: 500 KB. */
export const GLOBAL_BODY_LIMIT = 512_000;

/** Body limit for the hook's JSON APIs ({@link HOOK_API_ROUTES}): 1 MiB. */
export const HOOK_API_BODY_LIMIT = 1_048_576;

/**
 * POST routes the hook calls besides log upload. Paths are read from the controllers'
 * `@Controller`/`@Post` decorators:
 * - `TurnEndCostAdvisorController` — `api/v2/turn-end-cost-advisor`
 * - `SessionAttributionController` — `api/v2/session-attribution`
 * - `LogsController.logEcho` — `api/v1/log-echo`
 * - `OtelRealtimeController` — `api/v2/otel-realtime` (hook ≥ 2.29.0 realtime OTEL batches;
 *   the hook caps one batch at 768 KiB uncompressed, under this limit)
 *
 * `PostTurnAnalysisController` exposes only `GET config`, so it has no entry here.
 */
export const HOOK_API_ROUTES: ReadonlyArray<{
  path: string;
  method: RequestMethod;
}> = [
  { path: 'api/v2/turn-end-cost-advisor', method: RequestMethod.POST },
  { path: 'api/v2/session-attribution', method: RequestMethod.POST },
  { path: 'api/v1/log-echo', method: RequestMethod.POST },
  { path: 'api/v2/otel-realtime', method: RequestMethod.POST },
];

/**
 * Log-ingest POST routes. These parse at `getLogsBodyLimit()` in `LogsModule` and are
 * excluded from the global parsers. `api/v2/logs` is the only upload route: the v1
 * route was removed.
 */
export const LOG_INGEST_ROUTES: ReadonlyArray<{
  path: string;
  method: RequestMethod;
}> = [{ path: 'api/v2/logs', method: RequestMethod.POST }];
