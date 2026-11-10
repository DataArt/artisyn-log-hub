/**
 * The one budget spend read (2026-11-05 budgets-threshold-alerts): the Spend tab, its
 * "opens matching sessions" list, the Budget burn view, the Budget report and the threshold job
 * all go through this service, so the bar, the report and the notices always agree.
 *
 * Per DD-3 / DD-4 / DD-5 a scope's spend is the sum of `selectBudgetTreeCostMicros` over the
 * root trees anchored in the period; DD-8 builds the cost slices, DD-9 the restricted
 * (own-spend) view of a plain team member and DD-19 the report / burn view.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { selectBudgetTreeCostMicros } from '../otel-cost.sql';
import { isValidOtelTimeZone } from '../otel/otel-classify';
import { readTreeCost } from '../session-tree-cost.sql';
import { maskFirstPrompt } from '../team-scope';
import {
  computeBudgetForecast,
  markAnomalyDays,
  markCostlySessions,
} from './budget-math';
import {
  BUDGET_MIN_OFFSET,
  BUDGET_SESSIONS_LIMIT,
  BUDGET_TZ_MAX_LENGTH,
} from './budget.constants';
import {
  budgetRowToDto,
  isBudgetPeriod,
  repoSegment,
  scopeOfBudget,
  type BudgetScope,
  type ScopeAccess,
} from './budget-scope';
import type {
  BudgetBurnPoint,
  BudgetBurnView,
  BudgetDto,
  BudgetForecast,
  BudgetPeriod,
  BudgetReport,
  BudgetReportPeriod,
  BudgetRow,
  PeriodBounds,
  SpendDailyBucket,
  SpendSessionDto,
  SpendSessionsResult,
  SpendSessionsSlice,
  SpendSlice,
  SpendSliceKind,
  SpendSliceRow,
  SpendView,
} from './budgets.types';
import {
  clampPeriodOffset,
  loadPeriodBounds,
  loadPeriodBoundsSeries,
  loadPeriodTrees,
  loadScopeBudgets,
  loadSliceParts,
  resolveScopeRows,
  type PeriodTree,
  type ScopeRows,
  type SliceParts,
} from './spend-read.sql';

/** Row key of the `Not reported` slice row (DD-8). */
export const SLICE_NOT_REPORTED_KEY = '__not_reported__';
const NOT_REPORTED_LABEL = 'Not reported';
const UTILITY_KEY = '__utility__';
const MAIN_AGENT_KEY = '__main__';
const UNKNOWN_MODEL = 'Unknown model';
const UNNAMED_SUBAGENT = 'Unnamed sub-agent';
const NO_BRANCH = 'no branch';

/** Slice kinds the Spend view shows, in display order. */
export const SPEND_SLICE_KINDS: readonly SpendSliceKind[] = [
  'model',
  'user',
  'repo',
  'branch',
  'subagent',
  'skill',
  'mcp',
];

function isSpendSliceKind(value: string): value is SpendSliceKind {
  return SPEND_SLICE_KINDS.some((k) => k === value);
}

/** Rows per slice kind in the Budget report's `topSlices` (plus `Not reported`). */
const REPORT_TOP_SLICE_ROWS = 5;

/** Budget preference when the burn view names no budget (DD-19 / API: month › week › day). */
const BURN_DEFAULT_ORDER: readonly BudgetPeriod[] = ['month', 'week', 'day'];

/** A period tree with its budget cost (DD-5). */
interface PricedTree extends PeriodTree {
  micros: number;
  source: 'hook' | 'otel' | 'none';
}

type PartMap = Map<string, { label: string; micros: number }>;
/** A tree's attributed cost per slice kind and row key. */
type TreeParts = Map<SpendSliceKind, PartMap>;

interface SpendQuery {
  period: BudgetPeriod;
  offset: number;
  tz: string;
}

const usdToMicros = (usd: number | null | undefined): number =>
  usd == null ? 0 : Math.round(usd * 1e6);

function addPart(
  map: PartMap,
  key: string,
  label: string,
  micros: number,
): void {
  if (micros <= 0) return;
  const cur = map.get(key);
  if (cur) cur.micros += micros;
  else map.set(key, { label, micros });
}

function priceTree(tree: PeriodTree): PricedTree {
  const { micros, source } = selectBudgetTreeCostMicros({
    hookUsd: readTreeCost(tree.treeCost).total,
    otelMicros: tree.otelMicros,
  });
  return { ...tree, micros, source };
}

function sumMicros(trees: readonly PricedTree[]): number {
  return trees.reduce((s, t) => s + t.micros, 0);
}

/** `spend × 100 ≥ t × amount`, in BigInt (as `selectThresholdNotices`). */
function crossedThresholds(
  thresholds: readonly number[],
  spendMicros: number,
  amountMicros: number,
): number[] {
  const spend100 = BigInt(Math.round(spendMicros)) * 100n;
  const amount = BigInt(Math.round(amountMicros));
  return [...thresholds]
    .filter((t) => spend100 >= BigInt(t) * amount)
    .sort((a, b) => a - b);
}

/** Every bucket key of a period, in order: local dates (unit day) or hours `HH` (unit hour). */
export function periodBucketKeys(
  bounds: Pick<PeriodBounds, 'start' | 'totalUnits' | 'unit' | 'timeZone'>,
): string[] {
  if (bounds.unit === 'hour') {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: bounds.timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    });
    const keys: string[] = [];
    for (let i = 0; i < bounds.totalUnits; i++) {
      const key = fmt
        .format(new Date(bounds.start.getTime() + i * 3_600_000))
        .padStart(2, '0');
      // A 25-hour DST day repeats one local hour; to_char buckets both into the same key.
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }
  const first = new Intl.DateTimeFormat('en-CA', {
    timeZone: bounds.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(bounds.start);
  const [y, m, d] = first.split('-').map(Number);
  const keys: string[] = [];
  for (let i = 0; i < bounds.totalUnits; i++) {
    keys.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
  }
  return keys;
}

function bucketMicros(
  trees: readonly PricedTree[],
  keys: readonly string[],
): number[] {
  const index = new Map(keys.map((k, i) => [k, i]));
  const out = keys.map(() => 0);
  for (const t of trees) {
    const i = index.get(t.bucketKey);
    if (i !== undefined) out[i] += t.micros;
  }
  return out;
}

function forecastOf(
  spendMicros: number,
  amountMicros: number | null,
  bounds: PeriodBounds,
): BudgetForecast {
  return {
    ...computeBudgetForecast({
      spendMicros,
      amountMicros,
      elapsedUnits: bounds.elapsedUnits,
      totalUnits: bounds.totalUnits,
      isCurrent: bounds.isCurrent,
    }),
    unit: bounds.unit,
  };
}

function cumulative(
  trees: readonly PricedTree[],
  keys: readonly string[],
  upTo: number,
): BudgetBurnPoint[] {
  const per = bucketMicros(trees, keys);
  const out: BudgetBurnPoint[] = [];
  let acc = 0;
  for (let i = 0; i < Math.min(upTo, keys.length); i++) {
    acc += per[i];
    out.push({ key: keys[i], cumulativeMicros: acc });
  }
  return out;
}

/**
 * Per-tree attribution of the budget cost to slice rows (DD-8). Whatever a tree's parts do not
 * cover lands in `Not reported` at aggregation time.
 */
function buildTreeParts(
  trees: readonly PricedTree[],
  parts: SliceParts,
): Map<number, TreeParts> {
  const subByRoot = new Map<number, SliceParts['subagents']>();
  for (const p of parts.subagents) {
    const list = subByRoot.get(p.rootId) ?? [];
    list.push(p);
    subByRoot.set(p.rootId, list);
  }
  const otelByRoot = new Map<number, SliceParts['otel']>();
  for (const p of parts.otel) {
    const list = otelByRoot.get(p.rootId) ?? [];
    list.push(p);
    otelByRoot.set(p.rootId, list);
  }

  const out = new Map<number, TreeParts>();
  for (const t of trees) {
    const model: PartMap = new Map();
    const subagent: PartMap = new Map();
    const skill: PartMap = new Map();
    const mcp: PartMap = new Map();
    const subs = subByRoot.get(t.id) ?? [];
    const calls = otelByRoot.get(t.id) ?? [];

    if (t.source === 'hook') {
      const cost = readTreeCost(t.treeCost);
      const mainModel = t.treeCost?.main_model ?? UNKNOWN_MODEL;
      addPart(model, mainModel, mainModel, usdToMicros(cost.mainCost));
      addPart(
        model,
        UTILITY_KEY,
        'Utility calls',
        usdToMicros(cost.utilityCost),
      );
      addPart(
        subagent,
        MAIN_AGENT_KEY,
        'Main agent',
        usdToMicros(cost.mainCost) + usdToMicros(cost.utilityCost),
      );
      for (const s of subs) {
        const micros = usdToMicros(s.costUsd);
        const modelName = s.model ?? UNKNOWN_MODEL;
        addPart(model, modelName, modelName, micros);
        const label =
          s.description && s.description !== ''
            ? s.description
            : UNNAMED_SUBAGENT;
        addPart(subagent, label, label, micros);
      }
    } else if (t.source === 'otel') {
      for (const c of calls) {
        const modelName = c.model ?? UNKNOWN_MODEL;
        addPart(model, modelName, modelName, c.micros);
        if (c.isMain) {
          addPart(subagent, MAIN_AGENT_KEY, 'Main agent', c.micros);
        } else {
          const label = c.agentName ?? UNNAMED_SUBAGENT;
          addPart(subagent, label, label, c.micros);
        }
      }
    }

    // Skill / MCP slices read the OTEL calls of every period root, whatever its source.
    for (const c of calls) {
      if (c.skillName) addPart(skill, c.skillName, c.skillName, c.micros);
      if (c.mcpServerName) {
        addPart(mcp, c.mcpServerName, c.mcpServerName, c.micros);
      }
    }

    const branch = t.branch ?? NO_BRANCH;
    // Whole-tree slices keep zero-cost trees too, so their session counts are complete.
    const user: PartMap = new Map([
      [t.userEmail, { label: t.userEmail, micros: t.micros }],
    ]);
    const repo: PartMap = new Map([
      [t.repoUrl, { label: repoSegment(t.repoUrl), micros: t.micros }],
    ]);
    const branchParts: PartMap = new Map([
      [branch, { label: branch, micros: t.micros }],
    ]);
    const m: TreeParts = new Map<SpendSliceKind, PartMap>([
      ['model', model],
      ['user', user],
      ['repo', repo],
      ['branch', branchParts],
      ['subagent', subagent],
      ['skill', skill],
      ['mcp', mcp],
    ]);
    out.set(t.id, m);
  }
  return out;
}

function attributedMicros(parts: PartMap | undefined): number {
  let s = 0;
  for (const p of parts?.values() ?? []) s += p.micros;
  return s;
}

/**
 * The part of a tree's budget cost its parts of one slice kind leave unattributed. Each part was
 * rounded to whole micros on its own, so a gap no larger than the number of parts is rounding,
 * not a missing part, and counts as 0.
 */
function treeGapMicros(tree: PricedTree, parts: PartMap | undefined): number {
  const gap = tree.micros - attributedMicros(parts);
  return gap > (parts?.size ?? 0) ? gap : 0;
}

/** Aggregates the per-tree parts into the DD-8 slices (sorted, `Not reported` last). */
function aggregateSlices(
  trees: readonly PricedTree[],
  treeParts: Map<number, TreeParts>,
  spendMicros: number,
  topRows?: number,
): SpendSlice[] {
  return SPEND_SLICE_KINDS.map((kind) => {
    const rows = new Map<string, SpendSliceRow>();
    let notReported = 0;
    let gapSessions = 0;
    for (const t of trees) {
      const parts = treeParts.get(t.id)?.get(kind);
      const gap = treeGapMicros(t, parts);
      notReported += gap;
      if (gap > 0) gapSessions++;
      for (const [key, p] of parts ?? []) {
        const row = rows.get(key) ?? {
          key,
          label: p.label,
          sessions: 0,
          micros: 0,
          share: 0,
        };
        row.sessions++;
        row.micros += p.micros;
        rows.set(key, row);
      }
    }
    const share = (micros: number): number =>
      spendMicros > 0 ? micros / spendMicros : 0;
    let list = [...rows.values()]
      .map((r) => ({ ...r, share: share(r.micros) }))
      .sort((a, b) => b.micros - a.micros || a.label.localeCompare(b.label));
    if (topRows !== undefined) list = list.slice(0, topRows);
    if (notReported > 0) {
      list.push({
        key: SLICE_NOT_REPORTED_KEY,
        label: NOT_REPORTED_LABEL,
        sessions: gapSessions,
        micros: notReported,
        share: share(notReported),
      });
    }
    return { kind, rows: list };
  });
}

function emptyCostly(): SpendView['costlySessions'] {
  return { mean: 0, sigma: 0, items: [] };
}

@Injectable()
export class SpendService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Query normalisation ──────────────────────────────────────────────────────────────────

  private normalizeQuery(q: SpendQuery): SpendQuery {
    if (!isBudgetPeriod(q.period)) {
      throw new BadRequestException('period must be one of day, week, month');
    }
    const offset = Number(q.offset);
    if (!Number.isFinite(offset) || offset > 0) {
      throw new BadRequestException('offset must be a number ≤ 0');
    }
    this.assertTimeZone(q.tz);
    return { period: q.period, offset: clampPeriodOffset(offset), tz: q.tz };
  }

  private assertTimeZone(tz: string): void {
    if (
      typeof tz !== 'string' ||
      tz.length > BUDGET_TZ_MAX_LENGTH ||
      !isValidOtelTimeZone(tz)
    ) {
      throw new BadRequestException('tz must be a valid IANA time zone');
    }
  }

  private assertFullView(access: ScopeAccess): void {
    if (!access.fullView) throw new ForbiddenException();
  }

  // ── Shared reads ─────────────────────────────────────────────────────────────────────────

  private async pricedTrees(
    rows: ScopeRows,
    bounds: Pick<PeriodBounds, 'start' | 'end' | 'unit' | 'timeZone'>,
    filters?: { branches: string[]; userEmails: string[] },
  ): Promise<PricedTree[]> {
    const trees = await loadPeriodTrees(this.db, rows, bounds, filters);
    return trees.map(priceTree);
  }

  /** The budget DTO with its current period (offset 0 in the budget's own tz). */
  private async toDto(
    row: BudgetRow,
    known?: PeriodBounds,
  ): Promise<BudgetDto> {
    const current =
      known &&
      known.isCurrent &&
      known.period === row.period &&
      known.timeZone === row.timeZone
        ? known
        : await loadPeriodBounds(this.db, {
            period: row.period,
            tz: row.timeZone,
            offset: 0,
          });
    return budgetRowToDto(row, current);
  }

  private teamIdOf(scope: BudgetScope): number | null {
    return scope.kind === 'repo' ? null : scope.teamId;
  }

  private toSessionDto(
    access: ScopeAccess,
    viewerId: number,
    t: PricedTree,
    level?: 2 | 3,
  ): SpendSessionDto {
    const dto: SpendSessionDto = {
      sessionId: t.sessionId,
      repoId: t.repoId,
      teamId: this.teamIdOf(access.scope),
      startTime: t.startTime.toISOString(),
      userEmail: t.userEmail,
      branch: t.branch,
      micros: t.micros,
      source: t.source,
      firstPrompt: maskFirstPrompt(
        access.teamScope,
        viewerId,
        t.userId,
        t.firstPrompt,
      ),
    };
    if (level !== undefined) dto.level = level;
    return dto;
  }

  /** The period, its budget (if any) and its priced trees — the core of the Spend view. */
  private async loadSpendPeriod(
    access: ScopeAccess,
    q: SpendQuery,
    userFilterOverride?: number[],
  ): Promise<{
    budget: BudgetRow | null;
    bounds: PeriodBounds;
    rows: ScopeRows;
    trees: PricedTree[];
  }> {
    const budgets = await loadScopeBudgets(this.db, access.scope);
    const budget = budgets.find((b) => b.period === q.period) ?? null;
    const tz = budget?.timeZone ?? q.tz;
    const bounds = await loadPeriodBounds(this.db, {
      period: q.period,
      tz,
      offset: q.offset,
    });
    const rows = await resolveScopeRows(
      this.db,
      access.scope,
      userFilterOverride,
    );
    const trees = await this.pricedTrees(rows, bounds);
    return { budget, bounds, rows, trees };
  }

  // ── Spend view ───────────────────────────────────────────────────────────────────────────

  /**
   * `GET …/spend`: the period's spend, its budget card, daily buckets, slices and costly
   * sessions. A caller without `fullView` gets the DD-9 restricted view (own spend only).
   */
  async getSpendView(
    access: ScopeAccess,
    viewerId: number,
    query: SpendQuery,
  ): Promise<SpendView> {
    const q = this.normalizeQuery(query);
    const { budget, bounds, rows, trees } = await this.loadSpendPeriod(
      access,
      q,
      access.fullView ? undefined : [viewerId],
    );
    const spendMicros = sumMicros(trees);
    const base = {
      period: q.period,
      offset: bounds.offset,
      timeZone: bounds.timeZone,
      periodStart: bounds.start.toISOString(),
      periodEnd: bounds.end.toISOString(),
      isCurrent: bounds.isCurrent,
      elapsedUnits: bounds.elapsedUnits,
      totalUnits: bounds.totalUnits,
      canManage: access.canManage,
      spendMicros,
      sessions: trees.length,
      unpricedTrees: trees.filter((t) => t.source === 'none').length,
      otelOnlyTrees: trees.filter((t) => !t.hasClaudeLog).length,
    };

    if (!access.fullView) {
      // DD-9: only a budget the caller's own spend has gone over is shown.
      const over = budget !== null && spendMicros > budget.amountMicros;
      return {
        ...base,
        restricted: true,
        budget: over ? await this.toDto(budget, bounds) : null,
        forecast: null,
        previous: null,
        daily: [],
        slices: [],
        costlySessions: emptyCostly(),
        crossedThresholds: over
          ? crossedThresholds(
              budget.thresholds,
              spendMicros,
              budget.amountMicros,
            )
          : [],
      };
    }

    const amount = budget?.amountMicros ?? null;
    const keys = periodBucketKeys(bounds);
    const dailyMicros = bucketMicros(trees, keys);
    const anomalies = new Set(
      markAnomalyDays({
        dailyMicros,
        elapsedUnits: bounds.elapsedUnits,
        spendMicros,
      }),
    );
    const average =
      bounds.elapsedUnits > 0 ? spendMicros / bounds.elapsedUnits : 0;
    const daily: SpendDailyBucket[] = keys.map((key, i) => ({
      key,
      micros: dailyMicros[i],
      anomaly: anomalies.has(i),
      ratioToAverage: average > 0 ? dailyMicros[i] / average : 0,
    }));

    let previous: SpendView['previous'] = null;
    if (q.offset - 1 >= BUDGET_MIN_OFFSET) {
      const prevBounds = await loadPeriodBounds(this.db, {
        period: q.period,
        tz: bounds.timeZone,
        offset: q.offset - 1,
      });
      const prevSpend = sumMicros(await this.pricedTrees(rows, prevBounds));
      previous = {
        spendMicros: prevSpend,
        percentOfCurrentAmount: amount ? (prevSpend * 100) / amount : null,
      };
    }

    const parts = await loadSliceParts(
      this.db,
      trees.map((t) => t.id),
    );
    const treeParts = buildTreeParts(trees, parts);
    const costly = markCostlySessions(trees);
    const byId = new Map(trees.map((t) => [t.id, t]));
    const costlyItems = costly.marks
      .flatMap((mark) => {
        const t = byId.get(mark.id);
        return t ? [this.toSessionDto(access, viewerId, t, mark.level)] : [];
      })
      .sort((a, b) => b.micros - a.micros);

    return {
      ...base,
      restricted: false,
      budget: budget ? await this.toDto(budget, bounds) : null,
      forecast: forecastOf(spendMicros, amount, bounds),
      previous,
      daily,
      slices: aggregateSlices(trees, treeParts, spendMicros),
      costlySessions: {
        mean: costly.mean,
        sigma: costly.sigma,
        items: costlyItems,
      },
      crossedThresholds: budget
        ? crossedThresholds(budget.thresholds, spendMicros, budget.amountMicros)
        : [],
    };
  }

  // ── "Opens matching sessions" (DD-20) ────────────────────────────────────────────────────

  /**
   * `GET …/spend/sessions`: the period's root sessions behind one slice row (`slice` + row
   * `key`), one anomaly day (`slice=day`, `key=YYYY-MM-DD` / `HH`) or the costly list
   * (`slice=costly`, `key=all|2|3`), costliest first, at most `BUDGET_SESSIONS_LIMIT`.
   * Full-view callers only (DD-9: 403 otherwise).
   */
  async getSpendSessions(
    access: ScopeAccess,
    viewerId: number,
    query: SpendQuery & { slice: SpendSessionsSlice; key: string },
  ): Promise<SpendSessionsResult> {
    this.assertFullView(access);
    const q = this.normalizeQuery(query);
    const slice = query.slice;
    const key = String(query.key ?? '');
    const { trees } = await this.loadSpendPeriod(access, q);

    let matched: { tree: PricedTree; level?: 2 | 3 }[];
    if (slice === 'day') {
      matched = trees
        .filter((t) => t.bucketKey === key)
        .map((tree) => ({ tree }));
    } else if (slice === 'costly') {
      const byId = new Map(trees.map((t) => [t.id, t]));
      matched = markCostlySessions(trees)
        .marks.filter((m) => key === 'all' || key === String(m.level))
        .flatMap((m) => {
          const tree = byId.get(m.id);
          return tree ? [{ tree, level: m.level }] : [];
        });
    } else if (isSpendSliceKind(slice)) {
      const parts = await loadSliceParts(
        this.db,
        trees.map((t) => t.id),
      );
      const treeParts = buildTreeParts(trees, parts);
      matched = trees
        .filter((t) => {
          const p = treeParts.get(t.id)?.get(slice);
          if (key === SLICE_NOT_REPORTED_KEY) {
            return treeGapMicros(t, p) > 0;
          }
          return p?.has(key) === true;
        })
        .map((tree) => ({ tree }));
    } else {
      throw new BadRequestException(
        'slice must be one of model, user, repo, branch, subagent, skill, mcp, day, costly',
      );
    }

    matched.sort(
      (a, b) => b.tree.micros - a.tree.micros || a.tree.id - b.tree.id,
    );
    return {
      sessions: matched
        .slice(0, BUDGET_SESSIONS_LIMIT)
        .map((m) => this.toSessionDto(access, viewerId, m.tree, m.level)),
      truncated: matched.length > BUDGET_SESSIONS_LIMIT,
    };
  }

  // ── Budget burn view (DD-19) ─────────────────────────────────────────────────────────────

  /**
   * `GET …/analytics/budget-burn`: the cumulative spend line of the current period of one
   * budget (default month › week › day), the budget's forecast, the previous period's line
   * and the anomaly days. `branches` / `users` narrow only the cumulative lines
   * (`filtered: true` when they drop at least one session tree of the current period);
   * `spendMicros`, the forecast and the anomalies stay whole-scope. With
   * no budget the view covers the current calendar month in `tz`, with no forecast.
   */
  async getBudgetBurn(
    access: ScopeAccess,
    viewerId: number,
    q: { budgetId?: number; branches: string[]; users: string[]; tz: string },
  ): Promise<BudgetBurnView> {
    this.assertFullView(access);
    this.assertTimeZone(q.tz);
    void viewerId;
    const budgets = await loadScopeBudgets(this.db, access.scope);
    let budget: BudgetRow | null = null;
    if (q.budgetId !== undefined) {
      budget = budgets.find((b) => b.id === q.budgetId) ?? null;
      if (!budget) throw new NotFoundException('Budget not found');
    } else {
      for (const p of BURN_DEFAULT_ORDER) {
        budget = budgets.find((b) => b.period === p) ?? null;
        if (budget) break;
      }
    }

    const period: BudgetPeriod = budget?.period ?? 'month';
    const tz = budget?.timeZone ?? q.tz;
    const [bounds, prevBounds] = await loadPeriodBoundsSeries(this.db, {
      period,
      tz,
      fromOffset: -1,
      toOffset: 0,
    });
    const rows = await resolveScopeRows(this.db, access.scope);
    const hasFilters = q.branches.length > 0 || q.users.length > 0;
    const filters = hasFilters
      ? { branches: q.branches, userEmails: q.users }
      : undefined;

    const wholeTrees = await this.pricedTrees(rows, bounds);
    const lineTrees = hasFilters
      ? await this.pricedTrees(rows, bounds, filters)
      : wholeTrees;
    const prevTrees = await this.pricedTrees(rows, prevBounds, filters);
    // The Analytics controls send every user / branch when nothing is narrowed, so "a filter
    // was sent" is not "the line is narrower": only a filter that drops a session tree of the
    // current period makes the line differ from the budget's scope.
    const filtered = lineTrees.length < wholeTrees.length;

    const keys = periodBucketKeys(bounds);
    const spendMicros = sumMicros(wholeTrees);
    const anomalyIdx = markAnomalyDays({
      dailyMicros: bucketMicros(wholeTrees, keys),
      elapsedUnits: bounds.elapsedUnits,
      spendMicros,
    });
    const prevKeys = periodBucketKeys(prevBounds);

    const dtos = await Promise.all(budgets.map((b) => this.toDto(b, bounds)));
    return {
      budget: budget ? (dtos.find((d) => d.id === budget.id) ?? null) : null,
      budgets: dtos,
      filtered,
      periodStart: bounds.start.toISOString(),
      periodEnd: bounds.end.toISOString(),
      points: cumulative(lineTrees, keys, bounds.elapsedUnits),
      forecastMicros: budget
        ? forecastOf(spendMicros, budget.amountMicros, bounds).forecastMicros
        : null,
      previousCumulative: cumulative(prevTrees, prevKeys, prevKeys.length),
      anomalyKeys: anomalyIdx.map((i) => keys[i]),
      spendMicros,
    };
  }

  // ── Budget report (DD-19) ────────────────────────────────────────────────────────────────

  /**
   * The periods of `period` in `tz` that overlap `[startDate, endDate]`, newest first. The
   * offset window is estimated from the shortest possible period length, then filtered.
   */
  private async overlappingPeriods(
    period: BudgetPeriod,
    tz: string,
    startDate: Date,
    endDate: Date,
  ): Promise<PeriodBounds[]> {
    const minUnitMs: Record<BudgetPeriod, number> = {
      day: 23 * 3_600_000,
      week: 7 * 86_400_000 - 3_600_000,
      month: 28 * 86_400_000,
    };
    const back = Math.max(0, Date.now() - startDate.getTime());
    const fromOffset = Math.max(
      BUDGET_MIN_OFFSET,
      -(Math.ceil(back / minUnitMs[period]) + 1),
    );
    const series = await loadPeriodBoundsSeries(this.db, {
      period,
      tz,
      fromOffset,
      toOffset: 0,
    });
    return series.filter(
      (b) =>
        b.start.getTime() <= endDate.getTime() &&
        b.end.getTime() > startDate.getTime(),
    );
  }

  /** Priced trees of several consecutive periods in one read, split per period. */
  private async treesByPeriod(
    rows: ScopeRows,
    periods: readonly PeriodBounds[],
  ): Promise<PricedTree[][]> {
    if (periods.length === 0) return [];
    const start = new Date(Math.min(...periods.map((p) => p.start.getTime())));
    const end = new Date(Math.max(...periods.map((p) => p.end.getTime())));
    const all = await this.pricedTrees(rows, {
      start,
      end,
      unit: periods[0].unit,
      timeZone: periods[0].timeZone,
    });
    return periods.map((p) =>
      all.filter(
        (t) =>
          t.anchor.getTime() >= p.start.getTime() &&
          t.anchor.getTime() < p.end.getTime(),
      ),
    );
  }

  /**
   * `GET …/reports/budget`: for each budget, every period overlapping
   * `[startDate, endDate]` — the current one with its forecast, past ones with spend and
   * percent — plus the top slices over those periods. With no budget on the scope,
   * `noBudgetPeriods` lists the calendar months (in `tz`) with their spend.
   */
  async getBudgetReport(
    access: ScopeAccess,
    viewerId: number,
    q: { startDate: Date; endDate: Date; tz: string },
  ): Promise<BudgetReport> {
    this.assertFullView(access);
    this.assertTimeZone(q.tz);
    void viewerId;
    const budgets = await loadScopeBudgets(this.db, access.scope);
    const rows = await resolveScopeRows(this.db, access.scope);

    if (budgets.length === 0) {
      const months = await this.overlappingPeriods(
        'month',
        q.tz,
        q.startDate,
        q.endDate,
      );
      const perMonth = await this.treesByPeriod(rows, months);
      return {
        budgets: [],
        noBudgetPeriods: months.map((m, i) => ({
          start: m.start.toISOString(),
          end: m.end.toISOString(),
          spendMicros: sumMicros(perMonth[i]),
        })),
      };
    }

    const out: BudgetReport['budgets'] = [];
    for (const budget of budgets) {
      const periods = await this.overlappingPeriods(
        budget.period,
        budget.timeZone,
        q.startDate,
        q.endDate,
      );
      const perPeriod = await this.treesByPeriod(rows, periods);
      const reportPeriods: BudgetReportPeriod[] = periods.map((p, i) => {
        const trees = perPeriod[i];
        const spend = sumMicros(trees);
        const keys = periodBucketKeys(p);
        const anomalies = markAnomalyDays({
          dailyMicros: bucketMicros(trees, keys),
          elapsedUnits: p.elapsedUnits,
          spendMicros: spend,
        });
        return {
          start: p.start.toISOString(),
          end: p.end.toISOString(),
          isCurrent: p.isCurrent,
          spendMicros: spend,
          percentUsed: (spend * 100) / budget.amountMicros,
          forecast: p.isCurrent
            ? forecastOf(spend, budget.amountMicros, p)
            : null,
          crossedThresholds: crossedThresholds(
            budget.thresholds,
            spend,
            budget.amountMicros,
          ),
          anomalyDays: anomalies.map((idx) => keys[idx]),
        };
      });

      const allTrees = perPeriod.flat();
      const parts = await loadSliceParts(
        this.db,
        allTrees.map((t) => t.id),
      );
      const topSlices = aggregateSlices(
        allTrees,
        buildTreeParts(allTrees, parts),
        sumMicros(allTrees),
        REPORT_TOP_SLICE_ROWS,
      );

      const current = periods.find((p) => p.isCurrent);
      out.push({
        budget: await this.toDto(budget, current),
        periods: reportPeriods,
        topSlices,
      });
    }
    return { budgets: out, noBudgetPeriods: null };
  }

  // ── Threshold job (DD-14) ────────────────────────────────────────────────────────────────

  /**
   * The current-period spend of one budget, caller-independent (DD-3): the same rows the
   * Spend tab's full view reads, so the notices agree with the bar.
   */
  async computeBudgetSpend(budget: BudgetRow): Promise<{
    spendMicros: number;
    bounds: PeriodBounds;
    scope: BudgetScope;
  }> {
    const scope = scopeOfBudget(budget);
    const bounds = await loadPeriodBounds(this.db, {
      period: budget.period,
      tz: budget.timeZone,
      offset: 0,
    });
    const rows = await resolveScopeRows(this.db, scope);
    const trees = await this.pricedTrees(rows, bounds);
    return { spendMicros: sumMicros(trees), bounds, scope };
  }
}
