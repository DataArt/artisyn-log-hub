/**
 * Budget, spend and budget-notice responses (2026-11-05 budgets-threshold-alerts, API changes).
 * Mirrors `server/src/logs/budgets/budgets.types.ts`; fetched by `src/viewer/api.ts`.
 */

export type BudgetPeriod = 'day' | 'week' | 'month';

export type BudgetScopeKind = 'repo' | 'team-repo' | 'team';

/** `budget_events.event_type` (DD-11). */
export type BudgetEventType =
  | 'created'
  | 'edited'
  | 'deleted'
  | 'threshold_crossed'
  | 'threshold_superseded'
  | 'email_sent'
  | 'email_skipped'
  | 'email_failed';

/** Create / update body (DD-12). */
export interface BudgetInput {
  period: BudgetPeriod;
  amountUsd: number;
  thresholds: number[];
  timeZone: string;
}

export interface BudgetDto {
  id: number;
  scopeKind: BudgetScopeKind;
  period: BudgetPeriod;
  amountMicros: number;
  thresholds: number[];
  timeZone: string;
  label: string;
  currentPeriod: { start: string; end: string };
  createdAt: string;
  updatedAt: string;
}

/** `GET …/budgets`. */
export interface BudgetsListResponse {
  budgets: BudgetDto[];
  canManage: boolean;
}

export interface BudgetForecast {
  burnRateMicrosPerUnit: number;
  forecastMicros: number;
  percentUsed: number | null;
  unitsLeft: number | null;
  status: 'ok' | 'exceeded' | 'no-rate';
  overspendRisk: boolean;
  unit: 'day' | 'hour';
}

export type SpendSliceKind =
  | 'model'
  | 'user'
  | 'repo'
  | 'branch'
  | 'subagent'
  | 'skill'
  | 'mcp';

export interface SpendSliceRow {
  key: string;
  label: string;
  sessions: number;
  micros: number;
  share: number;
}

export interface SpendSlice {
  kind: SpendSliceKind;
  rows: SpendSliceRow[];
}

export interface SpendSessionDto {
  sessionId: string;
  repoId: number | null;
  teamId: number | null;
  startTime: string;
  userEmail: string;
  branch: string | null;
  micros: number;
  source: 'hook' | 'otel' | 'none';
  firstPrompt: string | null;
  level?: 2 | 3;
}

/** One daily bucket (`YYYY-MM-DD`), or hourly (`HH`) for a day budget. */
export interface SpendDailyBucket {
  key: string;
  micros: number;
  anomaly: boolean;
  ratioToAverage: number;
}

export interface SpendView {
  restricted: boolean;
  period: BudgetPeriod;
  offset: number;
  timeZone: string;
  periodStart: string;
  periodEnd: string;
  isCurrent: boolean;
  elapsedUnits: number;
  totalUnits: number;
  budget: BudgetDto | null;
  canManage: boolean;
  spendMicros: number;
  sessions: number;
  unpricedTrees: number;
  otelOnlyTrees: number;
  forecast: BudgetForecast | null;
  previous: {
    spendMicros: number;
    percentOfCurrentAmount: number | null;
  } | null;
  daily: SpendDailyBucket[];
  slices: SpendSlice[];
  costlySessions: { mean: number; sigma: number; items: SpendSessionDto[] };
  crossedThresholds: number[];
}

/** `spend/sessions` `slice` param: a slice kind, an anomaly day or the costly list. */
export type SpendSessionsSlice = SpendSliceKind | 'day' | 'costly';

export interface SpendSessionsResult {
  sessions: SpendSessionDto[];
  truncated: boolean;
}

export interface BudgetBurnPoint {
  key: string;
  cumulativeMicros: number;
}

export interface BudgetBurnView {
  budget: BudgetDto | null;
  budgets: BudgetDto[];
  filtered: boolean;
  periodStart: string;
  periodEnd: string;
  points: BudgetBurnPoint[];
  forecastMicros: number | null;
  previousCumulative: BudgetBurnPoint[];
  anomalyKeys: string[];
  spendMicros: number;
}

export interface BudgetReportPeriod {
  start: string;
  end: string;
  isCurrent: boolean;
  spendMicros: number;
  percentUsed: number;
  forecast: BudgetForecast | null;
  crossedThresholds: number[];
  anomalyDays: string[];
}

export interface BudgetReport {
  budgets: {
    budget: BudgetDto;
    periods: BudgetReportPeriod[];
    topSlices: SpendSlice[];
  }[];
  noBudgetPeriods: { start: string; end: string; spendMicros: number }[] | null;
}

export interface BudgetEventDto {
  id: number;
  createdAt: string;
  actorEmail: string | null;
  budgetId: number | null;
  budgetLabel: string;
  budgetDeleted: boolean;
  eventType: string;
  details: Record<string, unknown>;
}

/** `GET …/budgets/events`. */
export interface BudgetEventsPage {
  items: BudgetEventDto[];
  nextBefore: number | null;
}

/** Where a notice points (DD-15); the client builds the hash path with `budgetNoticeHref`. */
export interface BudgetNoticeLink {
  teamId?: number;
  repoId?: number;
  period: BudgetPeriod;
  offset: number;
}

export interface BudgetNoticeDto {
  id: number;
  createdAt: string;
  read: boolean;
  threshold: number;
  spendMicros: number;
  amountMicros: number;
  budgetLabel: string;
  scopeLabel: string;
  period: BudgetPeriod;
  periodStart: string;
  periodEnd: string;
  link: BudgetNoticeLink;
}

/** `GET /api/v1/budget-notices`. */
export interface BudgetNoticesPage {
  items: BudgetNoticeDto[];
  unreadCount: number;
  nextBefore: number | null;
}
