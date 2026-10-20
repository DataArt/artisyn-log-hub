import type { SessionAttributionAttributeDef } from '../../database/schema/index';
import type { SessionAttributionGate } from '../session-attribution/session-attribution.service';
import type { TurnEndAdvisorGate } from '../turn-end-cost-advisor/turn-end-cost-advisor.service';

/**
 * Response shape for the combined `GET /api/v2/post-turn-analysis/config`.
 * This file is the canonical, controller-facing name for the two
 * feature services' own gate shapes (each still owns its real definition —
 * `turn-end-cost-advisor.service.ts` / `session-attribution.service.ts` — so nothing here
 * is duplicated, only re-exported under the names the API changes section documents) plus
 * `AttributeDef`, the per-API-changes alias for `SessionAttributionAttributeDef`
 * (`database/schema/index.ts`).
 */
export type { TurnEndAdvisorGate, SessionAttributionGate };
export type AttributeDef = SessionAttributionAttributeDef;

/** `GET /api/v2/post-turn-analysis/config`'s full response body. */
export interface PostTurnAnalysisConfigResponse {
  advisor: TurnEndAdvisorGate;
  attribution: SessionAttributionGate;
}
