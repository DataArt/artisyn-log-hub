/**
 * budgets.ts — budgets, the Spend view and budget notices (task 2026-11-05
 * budgets-threshold-alerts) for S-BUDG-01 and the budget steps of S-TEAM-02 / S-AUTH-01.
 *
 *  - writes go through the public API with the user's cookie (`R/budgets`, `T/budgets`), the way
 *    the Settings › Budgets form sends them;
 *  - the threshold job runs every 200 ms on the stand (`FAST_TICK_ENV.BUDGET_CHECK_INTERVAL_MS`),
 *    so {@link waitForUnreadNotices} polls `GET /api/v1/budget-notices` instead of sleeping;
 *  - {@link usd2} prints micros exactly as the client's `formatUsdMicros` does (`$1,234.56`).
 */
import { expect, type APIRequestContext } from '@playwright/test';

export type BudgetPeriod = 'day' | 'week' | 'month';

export interface BudgetDto {
  id: number;
  scopeKind: 'repo' | 'team-repo' | 'team';
  period: BudgetPeriod;
  amountMicros: number;
  thresholds: number[];
  timeZone: string;
  label: string;
}

export interface SpendSliceRow {
  key: string;
  label: string;
  sessions: number;
  micros: number;
  share: number;
}

export interface SpendSlice {
  kind: string;
  rows: SpendSliceRow[];
}

export interface BudgetForecast {
  forecastMicros: number;
  percentUsed: number | null;
  status: string;
  overspendRisk: boolean;
}

export interface SpendView {
  restricted: boolean;
  period: BudgetPeriod;
  periodStart: string;
  periodEnd: string;
  budget: BudgetDto | null;
  canManage: boolean;
  spendMicros: number;
  sessions: number;
  otelOnlyTrees: number;
  unpricedTrees: number;
  forecast: BudgetForecast | null;
  slices: SpendSlice[];
  daily: { key: string; micros: number }[];
  crossedThresholds: number[];
}

export interface BudgetEventDto {
  id: number;
  actorEmail: string | null;
  budgetId: number | null;
  budgetDeleted: boolean;
  eventType: string;
  details: Record<string, unknown>;
}

export interface BudgetNoticeDto {
  id: number;
  read: boolean;
  threshold: number;
  spendMicros: number;
  amountMicros: number;
  link: { teamId?: number; repoId?: number; period: BudgetPeriod; offset: number };
}

/** A budget scope as the routes address it: a repository (personal or `teamId`) or a team. */
export type ScopeRef = { repoId: number; teamId?: number } | { teamId: number };

function scopeBase(scope: ScopeRef): { base: string; query: string } {
  if ('repoId' in scope) {
    return {
      base: `/api/v1/repositories/${scope.repoId}`,
      query: scope.teamId != null ? `teamId=${scope.teamId}` : '',
    };
  }
  return { base: `/api/v1/teams/${scope.teamId}`, query: '' };
}

function url(scope: ScopeRef, path: string, params: Record<string, string> = {}): string {
  const { base, query } = scopeBase(scope);
  const q = new URLSearchParams(query);
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  const s = q.toString();
  return `${base}${path}${s ? `?${s}` : ''}`;
}

/** `$1,234.56` — the client's `formatUsdMicros`. */
export function usd2(micros: number): string {
  return `$${(micros / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A prompt time inside the current day (and so the current week and month) of the UTC calendar:
 * `minutesAgo` back, but never before 00:00:01 UTC today.
 */
export function recentAt(minutesAgo = 10): Date {
  const now = Date.now();
  const startOfUtcDay = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(Math.max(now - minutesAgo * 60_000, startOfUtcDay + 1_000));
}

/** `YYYY-MM-DD` of the first day of the current UTC month and of today (UTC). */
export function currentUtcMonthDays(): { first: string; today: string } {
  const today = new Date().toISOString().slice(0, 10);
  return { first: `${today.slice(0, 8)}01`, today };
}

/** `POST <scope>/budgets`; asserts 201 and returns the budget. */
export async function createBudget(
  api: APIRequestContext,
  scope: ScopeRef,
  input: { period: BudgetPeriod; amountUsd: number; thresholds?: number[]; timeZone?: string },
): Promise<BudgetDto> {
  const res = await api.post(url(scope, '/budgets'), {
    data: { thresholds: [75, 90, 100], timeZone: 'UTC', ...input },
  });
  expect(res.status(), `create budget: ${await res.text()}`).toBe(201);
  return (await res.json()) as BudgetDto;
}

/** `PUT <scope>/budgets/:id`; asserts 200 and returns the budget. */
export async function updateBudget(
  api: APIRequestContext,
  scope: ScopeRef,
  budget: BudgetDto,
  amountUsd: number,
): Promise<BudgetDto> {
  const res = await api.put(url(scope, `/budgets/${budget.id}`), {
    data: { period: budget.period, amountUsd, thresholds: budget.thresholds, timeZone: budget.timeZone },
  });
  expect(res.status(), `update budget ${budget.id}: ${await res.text()}`).toBe(200);
  return (await res.json()) as BudgetDto;
}

/** `GET <scope>/budgets`; asserts 200. */
export async function listBudgets(api: APIRequestContext, scope: ScopeRef): Promise<{ budgets: BudgetDto[]; canManage: boolean }> {
  const res = await api.get(url(scope, '/budgets'));
  expect(res.status(), `list budgets: ${await res.text()}`).toBe(200);
  return (await res.json()) as { budgets: BudgetDto[]; canManage: boolean };
}

/** `GET <scope>/spend` of the current period in UTC; asserts 200. */
export async function getSpend(
  api: APIRequestContext,
  scope: ScopeRef,
  period: BudgetPeriod = 'month',
  tz = 'UTC',
): Promise<SpendView> {
  const res = await api.get(url(scope, '/spend', { period, offset: '0', tz }));
  expect(res.status(), `spend: ${await res.text()}`).toBe(200);
  return (await res.json()) as SpendView;
}

/** `GET <scope>/budgets/events` (newest first); asserts 200. */
export async function listBudgetEvents(
  api: APIRequestContext,
  scope: ScopeRef,
  params: Record<string, string> = {},
): Promise<BudgetEventDto[]> {
  const res = await api.get(url(scope, '/budgets/events', params));
  expect(res.status(), `budget events: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { items: BudgetEventDto[] }).items;
}

/** `GET /api/v1/budget-notices` of the caller. */
export async function listNotices(api: APIRequestContext): Promise<{ items: BudgetNoticeDto[]; unreadCount: number }> {
  const res = await api.get('/api/v1/budget-notices');
  expect(res.status(), `budget notices: ${await res.text()}`).toBe(200);
  return (await res.json()) as { items: BudgetNoticeDto[]; unreadCount: number };
}

/** Waits until the threshold job has left exactly `count` unread notices for the caller. */
export async function waitForUnreadNotices(api: APIRequestContext, count: number, timeoutMs = 20_000): Promise<BudgetNoticeDto[]> {
  await expect
    .poll(async () => (await listNotices(api)).unreadCount, { timeout: timeoutMs, message: `${count} unread budget notices` })
    .toBe(count);
  return (await listNotices(api)).items;
}

/** An amount (whole cents) that puts `spendMicros` at about `percent` % of the budget. */
export function amountForPercent(spendMicros: number, percent: number): number {
  return Math.round((spendMicros / 1e6 / (percent / 100)) * 100) / 100;
}

