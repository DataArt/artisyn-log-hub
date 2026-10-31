// S-OTEL-01. The OTEL tabs: repository, session and team views of Claude Code's own per-call
// cost (task 2026-10-30-otel-tabs-traces, impl-plan «Test coverage plan»; a new feature with no
// scenario before it; the OTEL tabs do not depend on the auth mode → mode A).
//
// Data: synthetic lines only (tests/scenarios/fixtures/otel/otel-lines.ts), relative to now. Every
// session has the shape of `otelTurn`: one interaction trace (two main-thread calls around a Bash
// tool), a standalone `prompt_suggestion` trace, and five `api_request` calls — two main, the
// suggestion, a `generate_session_title` call without a request id and a call with a
// `query_source` the server does not know. The transcript (artisyn + claude logs, POST
// /api/v2/logs) records the two main request ids. OTEL arrives the way a hook sends it: the
// regular `claude-otel` chunk upload (projected by the server's 5 s drain) and the 2.29.0 realtime
// channel `POST /api/v2/otel-realtime`.
//
// Three tests:
//   1. chunks — repository and session tabs: AC-1–AC-5, AC-9, AC-12, AC-13 (upgrade half), AC-19,
//      AC-21–AC-23, the no-OTEL empty state and the visual checks (sparklines, sorted tooltip,
//      «realtime off» banner, the repository banner from `hook_version`);
//   2. live — realtime batches into an open session tab: AC-6, AC-8, AC-16–AC-18, AC-25, AC-26
//      («gap then fill» too), and the idle indicator with a mocked clock (FR-10b);
//   3. team — the team tab of a restricted team: AC-27, AC-28, the seven-people fold, the team
//      realtime notice and slow banner.
//
// Task 2026-10-30-otel-shared-receiver adds to test 1 why a session has no OTEL — the reason
// panel of every DD-31 reason with its help link, the generic `no-status` panel and the partial
// banner (AC-C3, AC-G2), the hook's `otel-status` line riding in the artisyn log — and the
// coverage of the repository tab: the banner and its reason chips, the «Sessions with OTEL» tile,
// a chip filtering the Sessions list, the 0-of-M variant and no banner at full coverage (AC-C4).
// Test 3 adds the team coverage banner.
//
// Code facts that differ from the design text:
//   - the team detail tabs are component state (no URL), so «a direct link shows No access» is
//     the team-repository link `#/teams/:t/repos/:r?mtab=otel`: for a plain member or an ADLC
//     trainer the view falls back to the Sessions tab (no OTEL trigger) and the facts route
//     answers 403; «No access» itself is rendered only for a 403 inside a shown tab;
//   - money in the OTEL tabs is `$0.0125` below one cent and two decimals above it
//     (`otel-format.ts`), so a total of 0.036 USD prints `$0.04`;
//   - Claude Code exports a span when it ends, so a running turn is «turn 1 in progress — root span
//     not received yet» (its `interaction` root arrives last), not an open root span.
import type { Page, Request } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect, type ScenarioUser } from '../fixtures';
import {
  apiRequestLine,
  callLines,
  floor5m,
  micros,
  MODEL_A,
  MODEL_B,
  otelTurn,
  plus,
  spanLine,
  spanLines,
  UNKNOWN_QUERY_SOURCE,
  type OtelLine,
  type TranscriptSpec,
} from '../fixtures/otel/otel-lines';
import { createApiKey } from '../helpers/api-key';
import {
  otelUsd,
  repoFacts,
  repoFactsStatus,
  resetOtelProjection,
  sendRealtime,
  sessionOtel,
  sumMicros,
  teamFacts,
  teamFactsStatus,
  uploadOtelChunk,
  uploadTranscript,
  waitForOtelProjected,
  type OtelSpanRow,
} from '../helpers/otel';
import { ownRepoId } from '../helpers/prompt-session';
import { openSession } from '../helpers/session-view';
import { addTeamRepo, createTeam, inviteAndAccept, setMemberRoles, skipNewUserNudge } from '../helpers/teams';
import { shiftSessionTree } from '../helpers/time-shift';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The hook-reported reasons of a session without OTEL, with the panel title, help label and help
 * anchor the UI shows for each (2026-10-30 otel-shared-receiver DD-31, verbatim from
 * `wireframes/otel-reason-messages.svg`; `no-status` is checked on its own).
 */
const REASON_PANELS = [
  { reason: 'managed-endpoint', title: 'OTEL is managed by your organization', helpLabel: 'Admin-managed OTEL', anchor: 'admin-managed-otel' },
  { reason: 'managed-disabled', title: 'Telemetry is disabled by your organization', helpLabel: 'Admin-managed OTEL', anchor: 'admin-managed-otel' },
  { reason: 'project-only', title: 'OTEL keys are only in project settings', helpLabel: 'Claude Code 2.1.282 change', anchor: 'claude-code-21282-change' },
  { reason: 'not-configured', title: 'OTEL is not configured', helpLabel: 'Enable OTEL', anchor: 'enable-otel-and-traces' },
  { reason: 'receiver-down', title: 'The local OTEL receiver was not reachable', helpLabel: 'Troubleshooting', anchor: 'troubleshooting-otel-tab-is-empty' },
  { reason: 'unknown', title: 'No OTEL data — cause not determined', helpLabel: 'Troubleshooting', anchor: 'troubleshooting-otel-tab-is-empty' },
] as const;

/** `telemetry_cost` (micro-USD, the Σ of the session's `logs_otel` chunks) of one session. */
async function telemetryCost(db: import('pg').Pool, sessionId: string): Promise<number | null> {
  const { rows } = await db.query<{ telemetry_cost: string | null }>(
    `SELECT st.telemetry_cost FROM session_stats st JOIN sessions s ON s.id = st.session_id WHERE s.session_id = $1`,
    [sessionId],
  );
  return rows[0]?.telemetry_cost == null ? null : Number(rows[0].telemetry_cost);
}

/** A span reduced to what must not depend on delivery order or on the session's id tag. */
function spanShape(spans: OtelSpanRow[], tag: string) {
  const strip = (v: string | null) => (v === null ? null : v.split(tag).join('*'));
  return spans
    .map((sp) => ({
      span: strip(sp.spanId),
      parent: strip(sp.parentSpanId),
      name: sp.name,
      request: strip(sp.requestId),
      cost: sp.costUsdMicros,
      rollup: sp.rollupCostUsdMicros,
      hidden: sp.hidden,
    }))
    .sort((a, b) => String(a.span).localeCompare(String(b.span)));
}

/** Counts the session-route requests a page sends (`…/sessions/<sid>/otel?…`). */
function countOtelPolls(page: Page, sessionId: string): { count(): number; urls: string[] } {
  const urls: string[] = [];
  const needle = `/sessions/${encodeURIComponent(sessionId)}/otel?`;
  page.on('request', (r: Request) => {
    if (r.url().includes(needle)) urls.push(r.url());
  });
  return { count: () => urls.length, urls };
}

/** Pretends the page went to the background / came back (`document.visibilityState`). */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** Records every waterfall row key that is ever flagged `data-new="true"` (the 2 s highlight). */
async function watchNewRows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __otelNew: string[] };
    w.__otelNew = [];
    const record = (el: Element) => {
      if (el.getAttribute('data-new') !== 'true') return;
      const key = el.getAttribute('data-key');
      if (key && !w.__otelNew.includes(key)) w.__otelNew.push(key);
    };
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target instanceof Element) record(m.target);
        m.addedNodes.forEach((n) => {
          if (n instanceof Element) {
            record(n);
            n.querySelectorAll('[data-new="true"]').forEach(record);
          }
        });
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-new'] });
  });
}

async function newRows(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __otelNew: string[] }).__otelNew.slice());
}

async function clearNewRows(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __otelNew: string[] }).__otelNew.length = 0;
  });
}

function row(page: Page, key: string) {
  return page.locator(`[data-testid="otel-waterfall-row"][data-key="${key}"]`);
}

async function openRepoOtel(page: Page, user: ScenarioUser, repoId: number, extra = '', teamId?: number): Promise<void> {
  await skipNewUserNudge(page.context());
  await user.signIn(page);
  const scope = teamId === undefined ? `/#/repos/${repoId}` : `/#/teams/${teamId}/repos/${repoId}`;
  await page.goto(`${scope}?mtab=otel${extra}`);
  // A hash change to the URL already shown keeps the SPA state; a reload fetches fresh facts.
  await page.reload();
  await expect(page.getByTestId('repo-otel-tab')).toBeVisible({ timeout: 20_000 });
}

// =============================================================================================
// 1. Chunks: repository and session tabs
// =============================================================================================

test('@S-OTEL-01 repository and session OTEL tabs from uploaded chunks @mode-a', async ({ api, db, users, page }) => {
  test.setTimeout(300_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('user', { label: 'otel01-owner' });
  const key = await createApiKey(owner.api);
  const queue = { db, userId: owner.id };
  const repoUrl = `https://git.arrakis.test/scn/${run}/otel-main`;
  const base = floor5m(new Date(Date.now() - 3 * HOUR_MS));

  const s1 = `otel01-${run}-s1`;
  const tag1 = `a${run}`;
  const turn1 = otelTurn(tag1, base);
  const nb = `otel01-${run}-nobranch`;
  const nbCall = { requestId: `nb${run}-req-1`, querySource: 'repl_main_thread', model: MODEL_B, at: plus(base, 12 * 60), costUsd: 0.01, input: 400, output: 40 };
  const s1Spec: TranscriptSpec = { sessionId: s1, prompt: `otel main session ${run}`, repoUrls: [repoUrl], branch: 'feature/otel', at: plus(base, 20), requestIds: turn1.transcriptRequestIds };
  const totalMain = turn1.totalMicros + micros(nbCall.costUsd);

  const repoId = await test.step('setup: S1 (artisyn, its OTEL chunk, then the claude log), a no-branch session, all in one repository', async () => {
    await uploadTranscript(api, key.key, s1Spec, queue, 'artisyn');
    await uploadOtelChunk(api, key.key, s1, [...callLines(s1, turn1), ...spanLines(s1, turn1)], queue);
    await waitForOtelProjected(db, s1);
    await uploadTranscript(api, key.key, s1Spec, queue, 'claude');
    await waitForOtelProjected(db, s1);
    await uploadTranscript(api, key.key, { sessionId: nb, prompt: `no branch ${run}`, repoUrls: [repoUrl], branch: null, at: plus(base, 11 * 60), requestIds: [nbCall.requestId] }, queue);
    await uploadOtelChunk(api, key.key, nb, [apiRequestLine(nb, nbCall)], queue);
    await waitForOtelProjected(db, nb);
    return ownRepoId(owner.api, repoUrl);
  });

  await test.step('AC-1 (API). the facts route: OTEL present, total = Σ cost_usd of every call, buckets keyed by structure', async () => {
    const f = await repoFacts(owner, repoId);
    expect(f.hasOtel).toBe(true);
    expect(f.hasOtelInPeriod).toBe(true);
    expect(Number(f.kpis.totalCostUsdMicros)).toBe(totalMain);
    expect(f.kpis.apiCalls).toBe(6);
    expect(new Set(f.buckets.map((b) => b.key))).toEqual(new Set(['main', 'hidden']));
    expect(sumMicros(f.buckets)).toBe(totalMain);
    const onlyB = await repoFacts(owner, repoId, { model: [MODEL_B] });
    expect(Number(onlyB.kpis.totalCostUsdMicros), 'model filter').toBe(micros(nbCall.costUsd));
    const hiddenOnly = await repoFacts(owner, repoId, { calls: 'hidden' });
    expect(Number(hiddenOnly.kpis.totalCostUsdMicros), 'calls=hidden').toBe(turn1.hiddenMicros);
  });

  await test.step('AC-2. at 5-minute interval S1’s call made at base+3:00 sits in the base bucket although its chunk was uploaded ~3 h later', async () => {
    const f = await repoFacts(owner, repoId, { from: new Date(base.getTime() - HOUR_MS).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), interval: '5m' });
    expect(f.interval).toBe('5m');
    const main = f.buckets.filter((b) => b.key === 'main');
    const atBase = main.find((b) => b.start === base.toISOString());
    expect(atBase, JSON.stringify(main)).toBeTruthy();
    expect(atBase!.calls).toBe(2);
    expect(Number(atBase!.costUsdMicros)).toBe(turn1.interactionMicros);
    expect(main.find((b) => b.start === plus(base, 10 * 60).toISOString())?.calls, 'the no-branch call at base+12:00').toBe(1);
  });

  await test.step('AC-3, AC-9. structure: prompt_suggestion is a hidden source with its share; the unknown query_source is listed raw with known=false; hidden total = Σ otel_api_calls.cost_usd_micros of the calls no transcript records', async () => {
    const f = await repoFacts(owner, repoId);
    const qs = new Map(f.querySources.map((q) => [q.querySource, q]));
    expect(qs.get('prompt_suggestion')).toMatchObject({ hidden: true, known: true, calls: 1, costUsdMicros: String(micros(0.004)) });
    expect(qs.get(UNKNOWN_QUERY_SOURCE)).toMatchObject({ known: false, calls: 1 });
    expect(qs.get('repl_main_thread')).toMatchObject({ hidden: false, calls: 3 });
    const { rows } = await db.query<{ utility: string }>(
      `SELECT coalesce(sum(c.cost_usd_micros), 0) AS utility
         FROM otel_api_calls c JOIN sessions s ON s.id = c.session_id
        WHERE s.session_id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM session_request_ids r WHERE r.session_id = c.session_id AND r.request_id = c.request_id)`,
      [[s1, nb]],
    );
    expect(Number(f.kpis.hiddenCostUsdMicros)).toBe(Number(rows[0].utility));
    expect(Number(f.kpis.hiddenCostUsdMicros)).toBe(turn1.hiddenMicros);
    expect(f.kpis.hiddenCalls).toBe(3);
  });

  await test.step('AC-1 (UI), AC-3, AC-9. the tab: chart on top with the cost source, hidden bars with prompt_suggestion, the «new» chip of the unknown source', async () => {
    await openRepoOtel(page, owner, repoId);
    await expect(page.getByText('Claude Code per-call estimate (cost_usd)')).toBeVisible();
    await expect(page.getByTestId('otel-realtime-badge')).toHaveText('Realtime data');
    await expect(page.getByTestId('otel-cost-chart')).toBeVisible();
    const legend = page.getByTestId('otel-chart-legend');
    await expect(legend).toContainText('Main thread');
    await expect(legend).toContainText('Hidden calls');
    await expect(page.getByTestId('otel-kpi-total')).toContainText(otelUsd(totalMain));
    await expect(page.getByTestId('otel-hidden-bars')).toContainText('prompt_suggestion');
    const unknownRow = page.getByTestId('otel-qs-row').filter({ hasText: UNKNOWN_QUERY_SOURCE });
    await expect(unknownRow.getByTestId('otel-qs-new')).toBeVisible();
    await expect(page.getByTestId('otel-qs-row').filter({ hasText: 'prompt_suggestion' }).getByTestId('otel-qs-new')).toHaveCount(0);
  });

  await test.step('AC-C4 (full coverage). both sessions carry OTEL: coverage 2 of 2, the «Sessions with OTEL» tile says 2 / 2 · 100 %, and no coverage banner', async () => {
    const f = await repoFacts(owner, repoId);
    expect(f.coverage).toEqual({ otelSessions: 2, totalSessions: 2, otelUsers: 1, reasons: [] });
    const tile = page.getByTestId('otel-kpi-coverage');
    await expect(tile).toContainText('2 / 2');
    await expect(tile).toContainText('100 % coverage · 1 user');
    await expect(page.getByTestId('otel-coverage-banner')).toHaveCount(0);
  });

  await test.step('AC-1 (UI). every control redraws: stack-by, interval, view, cumulative, calls, model and period each change the request or the chart', async () => {
    const facts: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes(`/repositories/${repoId}/otel/facts?`)) facts.push(r.url());
    });
    const lastQuery = async (param: string, value: string) => {
      await expect.poll(() => facts.map((u) => new URL(u).searchParams.get(param)).includes(value), { message: `${param}=${value}` }).toBe(true);
    };
    const controls = page.getByTestId('otel-chart-controls');
    await controls.getByRole('button', { name: 'Model', exact: true }).click();
    await lastQuery('stackBy', 'model');
    await expect(page.getByTestId('otel-chart-legend')).toContainText(MODEL_A);
    await expect(page.getByTestId('otel-chart-legend')).toContainText(MODEL_B);
    await controls.getByRole('button', { name: '5 min', exact: true }).click();
    await lastQuery('interval', '5m');
    await controls.getByRole('button', { name: '100 %', exact: true }).click();
    await expect(controls.getByRole('button', { name: '100 %', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await controls.getByRole('button', { name: 'On', exact: true }).click();
    await expect(page.getByTestId('otel-chart-legend')).toContainText('Cumulative (right axis)');
    await page.getByTestId('otel-calls-filter').getByRole('button', { name: 'Hidden only', exact: true }).click();
    await lastQuery('calls', 'hidden');
    await expect(page.getByTestId('otel-kpi-total')).toContainText(otelUsd(turn1.hiddenMicros));
    const allCalls = page.getByTestId('otel-calls-filter').getByRole('button', { name: 'All', exact: true });
    await allCalls.click();
    // Wait for the re-render: the next control's handler must see the new URL state.
    await expect(allCalls).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('otel-kpi-total')).toContainText(otelUsd(totalMain));
    await page.getByTestId('otel-model-filter').selectOption(MODEL_B);
    await lastQuery('model', MODEL_B);
    await expect(page.getByTestId('otel-kpi-total')).toContainText(otelUsd(micros(nbCall.costUsd)));
    await page.getByTestId('otel-model-filter').selectOption('');
    await expect(page.getByTestId('otel-kpi-total')).toContainText(otelUsd(totalMain));
    await page.getByTestId('otel-filter-strip').getByRole('button', { name: '24 h', exact: true }).click();
    await expect.poll(() => {
      const u = facts.length > 0 ? new URL(facts[facts.length - 1]) : null;
      return u ? Date.parse(u.searchParams.get('to')!) - Date.parse(u.searchParams.get('from')!) : 0;
    }).toBe(24 * HOUR_MS);
  });

  await test.step('FR-27. the chart tooltip lists the bucket’s series sorted by value with share bars, then the total', async () => {
    await openRepoOtel(page, owner, repoId, '&otelInterval=5m&otelPeriod=24h');
    const bar = page.getByTestId('otel-cost-chart').locator('.recharts-bar-rectangle path, .recharts-rectangle').first();
    await bar.hover();
    const tip = page.getByTestId('otel-chart-tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Total');
    const values = await tip.locator('.font-mono').allTextContents();
    const nums = values.slice(0, -1).map((t) => Number(t.replace(/[^0-9.]/g, '')));
    expect([...nums].sort((a, b) => b - a), 'series sorted by value').toEqual(nums);
  });

  await test.step('AC-4, FR-22. S1’s session tab: chart, KPIs and cost by source; total = the session’s telemetry_cost; a 2.29.0 session without realtime data shows the «realtime off» banner', async () => {
    const snap = await sessionOtel(owner, repoId, s1);
    expect(snap.status).toMatchObject({ hasOtel: true, hasSpans: true, slowUpdates: true, slowReason: 'realtime-off', otelHookVersion: '2.29.0' });
    expect(snap.status.realtime.unconfirmedCalls).toBe(0);
    expect(Number(snap.kpis!.totalCostUsdMicros)).toBe(turn1.totalMicros);
    expect(Number(snap.kpis!.totalCostUsdMicros)).toBe(await telemetryCost(db, s1));
    expect(snap.calls.every((c) => c.confirmed && !c.provisional)).toBe(true);

    await openSession(page, owner, repoId, s1, { tab: 'otel' });
    const tab = page.getByTestId('session-otel-tab');
    await expect(tab.getByTestId('session-otel-header')).toContainText('hook 2.29.0 · traces on');
    await expect(tab.getByTestId('otel-cost-chart')).toBeVisible();
    await expect(tab.getByTestId('otel-kpi-total')).toContainText(otelUsd(turn1.totalMicros));
    await expect(tab.getByTestId('otel-kpi-hidden')).toContainText(otelUsd(turn1.hiddenMicros));
    await expect(tab.getByTestId('otel-structure')).toBeVisible();
    const banner = tab.getByTestId('otel-slow-banner');
    await expect(banner).toHaveAttribute('data-reason', 'realtime-off');
    await expect(banner).toContainText("realtime channel is off or cannot reach the server");
  });

  await test.step('AC-5. one trace per turn; tool and execution nested; each llm_request shows its call’s cost; the interaction’s Σ = its two LLM calls; the standalone suggestion is hidden', async () => {
    const snap = await sessionOtel(owner, repoId, s1);
    expect(snap.spans).toHaveLength(6);
    const byId = new Map(snap.spans.map((sp) => [sp.spanId, sp]));
    expect(byId.get(`${tag1}l1`)?.costUsdMicros).toBe(String(micros(0.0125)));
    expect(byId.get(`${tag1}l2`)?.costUsdMicros).toBe(String(micros(0.0175)));
    expect(byId.get(`${tag1}i1`)?.rollupCostUsdMicros).toBe(String(turn1.interactionMicros));
    expect(byId.get(`${tag1}x1`)?.parentSpanId).toBe(`${tag1}t1`);
    expect(byId.get(`${tag1}l3`)?.hidden).toBe(true);

    const tab = page.getByTestId('session-otel-tab');
    await expect(tab.getByTestId('otel-turn-label')).toContainText('Turn 1 of 1');
    await expect(row(page, `${tag1}i1`).getByTestId('otel-waterfall-sum')).toHaveText(`Σ ${otelUsd(turn1.interactionMicros)}`);
    await expect(row(page, `${tag1}l1`)).toContainText(otelUsd(micros(0.0125)));
    await expect(row(page, `${tag1}t1`)).toBeVisible();
    await expect(row(page, `${tag1}x1`)).toBeVisible();
    await expect(row(page, `${tag1}l3`)).toHaveAttribute('data-hidden', 'true');
    await row(page, `${tag1}l1`).click();
    await expect(page.getByTestId('otel-span-details')).toContainText(`${tag1}-req-1`);
  });

  const ooo = `otel01-${run}-ooo`;
  const tag2 = `b${run}`;
  const repoOoo = `https://git.arrakis.test/scn/${run}/otel-ooo`;
  await test.step('AC-19. the same turn delivered out of order — children first, then the interaction root together with the api_request records — ends in the same tree and costs as S1', async () => {
    const turn2 = otelTurn(tag2, base);
    const spec: TranscriptSpec = { sessionId: ooo, prompt: `out of order ${run}`, repoUrls: [repoOoo], branch: 'main', at: plus(base, 20), requestIds: turn2.transcriptRequestIds, hookVersion: '2.28.0' };
    await uploadTranscript(api, key.key, spec, queue, 'artisyn');
    const { interaction, ...children } = turn2.spans;
    await uploadOtelChunk(api, key.key, ooo, Object.values(children).map((sp) => spanLine(ooo, sp)), queue);
    await waitForOtelProjected(db, ooo);
    await uploadOtelChunk(api, key.key, ooo, [spanLine(ooo, interaction), ...callLines(ooo, turn2)], queue);
    await waitForOtelProjected(db, ooo);
    await uploadTranscript(api, key.key, spec, queue, 'claude');
    await waitForOtelProjected(db, ooo);
    const oooRepoId = await ownRepoId(owner.api, repoOoo);
    const a = await sessionOtel(owner, repoId, s1);
    const b = await sessionOtel(owner, oooRepoId, ooo);
    expect(spanShape(b.spans, tag2)).toEqual(spanShape(a.spans, tag1));
    expect(b.kpis).toEqual(a.kpis);
  });

  await test.step('visual: a repository whose hook_version is 2.28.0 shows the «update the hook» banner with the version', async () => {
    await openRepoOtel(page, owner, await ownRepoId(owner.api, repoOoo));
    const banner = page.getByTestId('otel-slow-banner');
    await expect(banner).toContainText('Data updates slowly — update the hook');
    await expect(banner).toContainText('(hook 2.28.0)');
  });

  await test.step('AC-12, AC-13 (upgrade half). S1’s OTEL facts dropped and its chunks unprojected (the state migration 0078 leaves): the drain rebuilds the same buckets, calls and waterfall by event time, nothing re-uploaded', async () => {
    const before = await sessionOtel(owner, repoId, s1);
    const factsBefore = await repoFacts(owner, repoId, { interval: '5m', from: new Date(base.getTime() - HOUR_MS).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
    await resetOtelProjection(db, s1);
    await waitForOtelProjected(db, s1);
    const after = await sessionOtel(owner, repoId, s1);
    expect(spanShape(after.spans, tag1)).toEqual(spanShape(before.spans, tag1));
    expect(after.kpis?.totalCostUsdMicros).toBe(before.kpis?.totalCostUsdMicros);
    expect(after.kpis?.hiddenCostUsdMicros).toBe(before.kpis?.hiddenCostUsdMicros);
    const factsAfter = await repoFacts(owner, repoId, { interval: '5m', from: new Date(base.getTime() - HOUR_MS).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
    const shape = (f: typeof factsAfter) => f.buckets.map((x) => `${x.start}|${x.key}|${x.calls}|${x.costUsdMicros}`).sort();
    expect(shape(factsAfter)).toEqual(shape(factsBefore));
    await openSession(page, owner, repoId, s1, { tab: 'otel' });
    await expect(row(page, `${tag1}t1`)).toBeVisible();
  });

  await test.step('AC-23. Sankey: each column sums to the total; the no-branch session is «(unknown)»; the private repository has no user column', async () => {
    const f = await repoFacts(owner, repoId);
    expect(sumMicros(f.flows)).toBe(Number(f.kpis.totalCostUsdMicros));
    const byBranch = new Map<string, number>();
    for (const fl of f.flows) byBranch.set(fl.branch ?? '(unknown)', (byBranch.get(fl.branch ?? '(unknown)') ?? 0) + Number(fl.costUsdMicros));
    expect(Object.fromEntries(byBranch)).toEqual({ 'feature/otel': turn1.totalMicros, '(unknown)': micros(nbCall.costUsd) });
    await openRepoOtel(page, owner, repoId);
    const flow = page.getByTestId('otel-cost-flow');
    await expect(flow).toContainText('model → branch (of the session)');
    await expect(flow.locator('svg text').filter({ hasText: /^Branch \(of the session\)$/ })).toHaveCount(1);
    await expect(flow.locator('svg text').filter({ hasText: /^User$/ })).toHaveCount(0);
    await expect(flow.locator('svg text').filter({ hasText: '(unknown)' })).toHaveCount(1);
  });

  await test.step('AC-22. the cache read ratio = Σ cache read / Σ (input + cache read + cache write) over the same calls; the tile prints it', async () => {
    const f = await repoFacts(owner, repoId);
    const { rows } = await db.query<{ r: string; d: string }>(
      `SELECT sum(c.cache_read_tokens) AS r, sum(c.input_tokens + c.cache_read_tokens + c.cache_write_tokens) AS d
         FROM otel_calls c JOIN sessions s ON s.id = c.session_id WHERE s.session_id = ANY($1)`,
      [[s1, nb]],
    );
    const ratio = Number(rows[0].r) / Number(rows[0].d);
    expect(Number(f.kpis.cacheReadTokens) / (Number(f.kpis.inputTokens) + Number(f.kpis.cacheReadTokens) + Number(f.kpis.cacheWriteTokens))).toBeCloseTo(ratio, 9);
    await expect(page.getByTestId('otel-kpi-cache-ratio')).toContainText(`${(ratio * 100).toFixed(1)} %`);
  });

  await test.step('AC-22 (n/a). a repository whose calls carry no input or cache tokens shows «n/a», not 0 %', async () => {
    const zeroUrl = `https://git.arrakis.test/scn/${run}/otel-zero`;
    const sid = `otel01-${run}-zero`;
    await uploadTranscript(api, key.key, { sessionId: sid, prompt: `zero tokens ${run}`, repoUrls: [zeroUrl], branch: 'main', at: plus(base, 60), requestIds: [] }, queue);
    await uploadOtelChunk(api, key.key, sid, [apiRequestLine(sid, { requestId: null, querySource: 'repl_main_thread', model: MODEL_A, at: plus(base, 90), costUsd: 0.001, input: 0, output: 50 })], queue);
    await waitForOtelProjected(db, sid);
    await openRepoOtel(page, owner, await ownRepoId(owner.api, zeroUrl));
    await expect(page.getByTestId('otel-kpi-cache-ratio')).toContainText('n/a');
  });

  await test.step('no OTEL, AC-C4 (0 of M), AC-C3 (no-status). a repository whose only session has no OTEL and no reported status: the «reason» empty state (0 of 1, the no-status message, Show 1 month) under the coverage banner with the «no status (older hook)» chip; the session tab shows the generic no-status panel without a status line; the session’s other tabs are unchanged', async () => {
    const noUrl = `https://git.arrakis.test/scn/${run}/otel-none`;
    const sid = `otel01-${run}-none`;
    await uploadTranscript(api, key.key, { sessionId: sid, prompt: `no otel ${run}`, repoUrls: [noUrl], branch: 'main', at: plus(base, 60), requestIds: [`none${run}-req`] }, queue);
    const noRepo = await ownRepoId(owner.api, noUrl);
    const f = await repoFacts(owner, noRepo);
    expect(f).toMatchObject({ hasOtel: false, hasOtelInPeriod: false });
    expect(f.coverage).toEqual({ otelSessions: 0, totalSessions: 1, otelUsers: 0, reasons: [{ reason: 'no-status', count: 1 }] });
    await openRepoOtel(page, owner, noRepo);
    const empty = page.getByTestId('otel-empty-reason');
    await expect(empty).toHaveAttribute('data-reason', 'no-status');
    await expect(empty).toContainText('No OTEL data in this period (0 of 1 session)');
    await expect(empty).toContainText('Most sessions report: No OTEL data for this session.');
    await expect(empty.getByTestId('otel-show-month')).toBeVisible();
    await expect(page.getByTestId('otel-coverage-text')).toHaveText(
      'OTEL for 0 of 1 sessions — totals and averages below cover these 0 sessions only; the other 1 are not counted as zero.',
    );
    await expect(page.getByTestId('otel-coverage-chip')).toHaveText(['no status (older hook) · 1']);
    await expect(page.getByTestId('otel-kpi-tiles'), 'the reason variant replaces the chart and the tiles').toHaveCount(0);
    await openSession(page, owner, noRepo, sid, { tab: 'otel' });
    const panel = page.getByTestId('otel-reason-panel');
    await expect(panel).toHaveAttribute('data-reason', 'no-status');
    await expect(panel.getByTestId('otel-reason-title')).toHaveText('No OTEL data for this session');
    await expect(panel.getByTestId('otel-reason-body')).toContainText('uploaded by an older hook that does not report why');
    await expect(panel.getByTestId('otel-reason-status-line')).toHaveCount(0);
    await expect(panel.getByTestId('otel-reason-received')).toHaveCount(0);
    await expect(panel).toContainText('Still works');
    await expect(panel).toContainText('Not available');
    await panel.getByRole('button', { name: 'Help: OTEL tab is empty' }).click();
    await expect(page.getByRole('dialog').locator('[id="otel-tab-is-empty"]')).toBeInViewport();
    await page.keyboard.press('Escape');
    await page.getByTestId('tab-session-summary').click();
    await expect(page.getByTestId('summary-executive-band')).toBeVisible();
  });

  // 2026-10-30 otel-shared-receiver: why a session has no OTEL (DD-31), coverage (DD-29) and the
  // sessions-list reason filter (DD-33).
  const reasonsUrl = `https://git.arrakis.test/scn/${run}/otel-reasons`;
  const reasonSid = (reason: string) => `otel01-${run}-why-${reason}`;
  const olderSid = `otel01-${run}-older-hook`;
  const partialSid = `otel01-${run}-partial`;
  const reasonsRepo = await test.step('setup (reasons): one session per hook-reported reason (state none), one of an older hook (no status) and one partial session (logs only, managed-endpoint) that has OTEL data — all in one repository', async () => {
    for (const [i, reason] of REASON_PANELS.map((r) => r.reason).entries()) {
      await uploadTranscript(api, key.key, {
        sessionId: reasonSid(reason), prompt: `why ${reason} ${run}`, repoUrls: [reasonsUrl], branch: 'main',
        at: plus(base, 30 * 60 + i * 60), requestIds: [`why${i}${run}-req`], otelStatus: { state: 'none', reason },
      }, queue);
    }
    await uploadTranscript(api, key.key, { sessionId: olderSid, prompt: `older hook ${run}`, repoUrls: [reasonsUrl], branch: 'main', at: plus(base, 40 * 60), requestIds: [`older${run}-req`] }, queue);
    const partialReq = `partial${run}-req`;
    await uploadTranscript(api, key.key, {
      sessionId: partialSid, prompt: `partial ${run}`, repoUrls: [reasonsUrl], branch: 'main', at: plus(base, 45 * 60), requestIds: [partialReq],
      otelStatus: { state: 'partial', reason: 'managed-endpoint', received: { logs: 3, metrics: 0, spans: 0 }, forward: 'ok' },
    }, queue);
    await uploadOtelChunk(api, key.key, partialSid, [apiRequestLine(partialSid, { requestId: partialReq, querySource: 'repl_main_thread', model: MODEL_A, at: plus(base, 46 * 60), costUsd: 0.02, input: 100, output: 10 })], queue);
    await waitForOtelProjected(db, partialSid);
    return ownRepoId(owner.api, reasonsUrl);
  });

  await test.step('AC-C3, AC-C4 (API). coverage 1 of 8 (one user) with one reason row per cause plus no-status; the session route returns each root’s status and the utility-call flag', async () => {
    const f = await repoFacts(owner, reasonsRepo);
    expect(f.coverage).toMatchObject({ otelSessions: 1, totalSessions: 8, otelUsers: 1 });
    expect(Object.fromEntries(f.coverage.reasons.map((r) => [r.reason, r.count]))).toEqual(
      Object.fromEntries([...REASON_PANELS.map((r) => [r.reason, 1]), ['no-status', 1]]),
    );
    const projectOnly = await sessionOtel(owner, reasonsRepo, reasonSid('project-only'));
    expect(projectOnly.status.otelStatus).toMatchObject({
      state: 'none', reason: 'project-only', hookVersion: '2.30.0', receiverVersion: '2.30.0', claudeVersion: '2.1.300', forward: 'off',
      received: { logs: 0, metrics: 0, spans: 0, firstAt: null },
    });
    expect(projectOnly.status.costExcludesUtilityCalls).toBe(true);
    expect((await sessionOtel(owner, reasonsRepo, olderSid)).status.otelStatus).toBeNull();
    const partial = await sessionOtel(owner, reasonsRepo, partialSid);
    expect(partial.status.otelStatus).toMatchObject({ state: 'partial', reason: 'managed-endpoint', received: { logs: 3, metrics: 0, spans: 0 } });
    expect(partial.status.costExcludesUtilityCalls, 'the root has OTEL calls').toBe(false);
  });

  for (const r of REASON_PANELS) {
    await test.step(`AC-C3, AC-G2. ${r.reason}: the session OTEL tab shows its reason panel (status line, «${r.title}», the shared lists, the counts at Stop) and «Help: ${r.helpLabel}» opens the in-app help at #${r.anchor}`, async () => {
      await openSession(page, owner, reasonsRepo, reasonSid(r.reason), { tab: 'otel' });
      const panel = page.getByTestId('otel-reason-panel');
      await expect(panel).toHaveAttribute('data-reason', r.reason, { timeout: 20_000 });
      await expect(panel.getByTestId('otel-reason-status-line')).toHaveText(`OTEL status: none · reason ${r.reason} · hook 2.30.0 · Claude Code 2.1.300 · forward off`);
      await expect(panel.getByTestId('otel-reason-title')).toHaveText(r.title);
      await expect(panel).toContainText('Utility-call cost');
      await expect(panel.getByTestId('otel-reason-received')).toHaveText('Received by the receiver at Stop: logs 0 · metrics 0 · spans 0 · first record —');
      await panel.getByRole('button', { name: `Help: ${r.helpLabel}` }).click();
      await expect(page.getByRole('dialog').locator(`[id="${r.anchor}"]`)).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  }

  await test.step('AC-C3 (partial). the partial session: the chart with the amber banner «Only logs arrived — metrics and spans missing (reason managed-endpoint).» and its help link; no reason panel', async () => {
    await openSession(page, owner, reasonsRepo, partialSid, { tab: 'otel' });
    const banner = page.getByTestId('otel-partial-banner');
    await expect(banner).toContainText('Only logs arrived — metrics and spans missing (reason managed-endpoint).', { timeout: 20_000 });
    await expect(page.getByTestId('otel-cost-chart')).toBeVisible();
    await expect(page.getByTestId('otel-reason-panel')).toHaveCount(0);
    await banner.getByRole('button', { name: 'Help →' }).click();
    await expect(page.getByRole('dialog').locator('[id="admin-managed-otel"]')).toBeInViewport();
    await page.keyboard.press('Escape');
  });

  await test.step('AC-C4. the repository tab: «OTEL for 1 of 8 sessions…», seven reason chips coloured per cause, the «Sessions with OTEL» tile 1 / 8 · 13 % coverage · 1 user, «Why no OTEL?» help; the project-only chip lists only that session on the Sessions tab under a removable «OTEL: project-only» chip', async () => {
    await openRepoOtel(page, owner, reasonsRepo);
    await expect(page.getByTestId('otel-coverage-text')).toHaveText(
      'OTEL for 1 of 8 sessions — totals and averages below cover these 1 sessions only; the other 7 are not counted as zero.',
    );
    const chips = page.getByTestId('otel-coverage-chip');
    await expect(chips).toHaveCount(7);
    await expect(chips.filter({ hasText: 'managed-endpoint · 1' })).toHaveClass(/border-red-300/);
    await expect(chips.filter({ hasText: 'project-only · 1' })).toHaveClass(/border-amber-300/);
    await expect(chips.filter({ hasText: 'no status (older hook) · 1' })).toHaveClass(/border-slate-300/);
    const tile = page.getByTestId('otel-kpi-coverage');
    await expect(tile).toContainText('1 / 8');
    await expect(tile).toContainText('13 % coverage · 1 user');
    await page.getByTestId('otel-coverage-banner').getByRole('button', { name: 'Why no OTEL?' }).click();
    await expect(page.getByRole('dialog').locator('[id="troubleshooting-otel-tab-is-empty"]')).toBeInViewport();
    await page.keyboard.press('Escape');

    await chips.filter({ hasText: 'project-only · 1' }).click();
    await expect(page).toHaveURL(/otelReason=project-only/);
    const filterChip = page.getByTestId('session-list-otel-reason-chip');
    await expect(filterChip).toHaveText('OTEL: project-only');
    const items = page.getByTestId('session-item');
    await expect(items).toHaveCount(1, { timeout: 20_000 });
    await expect(items).toContainText(`why project-only ${run}`);
    await filterChip.click();
    await expect(filterChip).toHaveCount(0);
    await expect(page).not.toHaveURL(/otelReason=/);
  });

  await test.step('AC-21. 1-week period: no change chip while the previous 7 days are empty; a session moved 8 days back makes «Total OTEL cost» show ▲/▼ against it', async () => {
    expect((await repoFacts(owner, repoId)).kpisPrev).toBeNull();
    await openRepoOtel(page, owner, repoId);
    await expect(page.getByTestId('otel-kpi-total').locator('[title="Change vs the previous period of equal length"]')).toHaveCount(0);

    const prev = `otel01-${run}-prev`;
    await uploadTranscript(api, key.key, { sessionId: prev, prompt: `previous week ${run}`, repoUrls: [repoUrl], branch: 'main', at: plus(base, 30), requestIds: [`prev${run}-req`] }, queue);
    await uploadOtelChunk(api, key.key, prev, [apiRequestLine(prev, { requestId: `prev${run}-req`, querySource: 'repl_main_thread', model: MODEL_A, at: plus(base, 60), costUsd: 0.02, input: 100, output: 10 })], queue);
    await waitForOtelProjected(db, prev);
    await shiftSessionTree(db, prev, 8);
    const f = await repoFacts(owner, repoId);
    expect(Number(f.kpisPrev?.totalCostUsdMicros)).toBe(micros(0.02));
    expect(Number(f.kpis.totalCostUsdMicros)).toBe(totalMain);
    await openRepoOtel(page, owner, repoId);
    const chip = page.getByTestId('otel-kpi-total').locator('[title="Change vs the previous period of equal length"]');
    const change = (totalMain - micros(0.02)) / micros(0.02);
    await expect(chip).toHaveText(`▲ ${Math.round(change * 100)} %`);
  });

  await test.step('FR-24. with a hidden call two days back as well, total cost, per day, API calls and hidden cost draw a sparkline; per session and sessions do not', async () => {
    const old = `otel01-${run}-old`;
    await uploadTranscript(api, key.key, { sessionId: old, prompt: `two days ago ${run}`, repoUrls: [repoUrl], branch: 'main', at: plus(base, 30), requestIds: [] }, queue);
    await uploadOtelChunk(api, key.key, old, [apiRequestLine(old, { requestId: `old${run}-req`, querySource: 'prompt_suggestion', model: MODEL_A, at: plus(base, 60), costUsd: 0.001, input: 100, output: 10 })], queue);
    await waitForOtelProjected(db, old);
    await shiftSessionTree(db, old, 2);
    await openRepoOtel(page, owner, repoId);
    await expect(page.getByTestId('otel-kpi-total')).toContainText(otelUsd(totalMain + micros(0.001)));
    for (const id of ['otel-kpi-total', 'otel-kpi-per-day', 'otel-kpi-api-calls', 'otel-kpi-hidden']) {
      await expect(page.getByTestId(id).getByTestId('otel-sparkline'), id).toHaveCount(1);
    }
    for (const id of ['otel-kpi-per-session', 'otel-kpi-sessions']) {
      await expect(page.getByTestId(id).getByTestId('otel-sparkline'), id).toHaveCount(0);
    }
  });
});

// =============================================================================================
// 2. Live: realtime batches into an open session tab
// =============================================================================================

test('@S-OTEL-01 live session tab: realtime batches, highlight, delta polls, pause, confirm and gap fill @mode-a', async ({ api, db, users, page }) => {
  test.setTimeout(360_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('user', { label: 'otel01-live' });
  const key = await createApiKey(owner.api);
  const queue = { db, userId: owner.id };
  const repoUrl = `https://git.arrakis.test/scn/${run}/otel-live`;
  const base = new Date(Date.now() - 6 * 60_000);

  const live = `otel01-${run}-live`;
  const tag = `l${run}`;
  const turn = otelTurn(tag, base);
  const sp = (name: keyof typeof turn.spans): OtelLine => spanLine(live, turn.spans[name]);
  const call = (name: keyof typeof turn.calls): OtelLine => apiRequestLine(live, turn.calls[name]);
  // What Claude Code exports, in the order spans end: the root arrives last.
  const batch1 = [sp('llm1'), call('main1'), sp('suggestion'), call('suggestion')];
  const batch2 = [sp('tool'), sp('toolExec')];
  const batch3 = [sp('llm2'), call('main2'), call('title'), call('unknown'), sp('interaction')];
  const allLines = [...batch1, ...batch2, ...batch3];
  const liveSpec: TranscriptSpec = { sessionId: live, prompt: `live session ${run}`, repoUrls: [repoUrl], branch: 'main', at: base, requestIds: turn.transcriptRequestIds };
  const receiver = `rcv-${run}`;

  const repoId = await test.step('setup: the running session’s artisyn log and a transcript holding only the prompt (no answer, no request id yet)', async () => {
    await uploadTranscript(api, key.key, { ...liveSpec, requestIds: [] }, queue);
    return ownRepoId(owner.api, repoUrl);
  });

  await test.step('AC-18 (running turn). realtime batch 1: the main-thread call is provisional and NOT hidden, the prompt_suggestion call is hidden; the answer carries minIntervalMs 5000', async () => {
    const res = await sendRealtime(api, key.key, { sessionId: live, receiverId: receiver, batchSeq: 1, lines: batch1 });
    expect(res).toMatchObject({ accepted: { calls: 2, spans: 2 }, minIntervalMs: 5000 });
    const snap = await sessionOtel(owner, repoId, live);
    expect(snap.status).toMatchObject({ hasOtel: true, live: true, slowUpdates: false });
    expect(snap.status.realtime).toMatchObject({ active: true, unconfirmedCalls: 2, gap: false });
    const byReq = new Map(snap.calls.map((c) => [c.requestId, c]));
    expect(byReq.get(`${tag}-req-1`)).toMatchObject({ structure: 'main', provisional: true, confirmed: false, changeKind: 'new' });
    expect(byReq.get(`${tag}-req-3`)).toMatchObject({ structure: 'hidden', confirmed: false });
  });

  const polls = countOtelPolls(page, live);
  await test.step('AC-26. the open tab: «Realtime data» badge, the unconfirmed notice, dotted unconfirmed rows; the running turn has no root yet', async () => {
    await openSession(page, owner, repoId, live, { tab: 'otel' });
    const tab = page.getByTestId('session-otel-tab');
    await expect(tab.getByTestId('otel-realtime-badge')).toBeVisible();
    await expect(tab.getByTestId('otel-notice-unconfirmed')).toContainText('Includes 2 calls received in realtime and not yet confirmed');
    await expect(row(page, `${tag}l1`)).toHaveAttribute('data-unconfirmed', 'true');
    await expect(tab.getByTestId('otel-waterfall-row').filter({ hasText: 'root span not received yet' })).toHaveCount(1);
    await expect(tab.getByTestId('otel-live-indicator')).toHaveAttribute('data-state', 'live');
  });

  await test.step('AC-6, AC-16. a span selected, its node expanded; realtime batch 2 (the finished Bash tool) shows up within 15 s, only the new rows are highlighted, existing rows are not re-mounted, selection and expansion stay', async () => {
    await watchNewRows(page);
    await row(page, `${tag}l1`).click();
    const details = page.getByTestId('otel-span-details');
    await expect(details).toContainText(`${tag}-req-1`);
    await row(page, `${tag}l1`).evaluate((el) => {
      (el as HTMLElement).dataset.scnMark = 'kept';
    });
    const toggle = page.getByTestId('otel-waterfall-row').filter({ hasText: 'root span not received yet' }).locator('button[aria-expanded]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const sentAt = Date.now();
    await sendRealtime(api, key.key, { sessionId: live, receiverId: receiver, batchSeq: 2, lines: batch2 });
    await expect(row(page, `${tag}t1`)).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - sentAt, 'within one 5 s poll plus slack, under the 15 s of AC-6').toBeLessThan(15_000);
    await expect(row(page, `${tag}x1`)).toBeVisible();
    await expect.poll(() => newRows(page)).toEqual(expect.arrayContaining([`${tag}t1`, `${tag}x1`]));
    expect(await newRows(page), 'nothing old is highlighted').not.toContain(`${tag}l1`);
    await expect(row(page, `${tag}l1`)).toHaveAttribute('data-scn-mark', 'kept');
    await expect(details).toContainText(`${tag}-req-1`);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The highlight fades after OTEL_HIGHLIGHT_MS (2 s).
    await expect(row(page, `${tag}t1`)).not.toHaveAttribute('data-new', 'true', { timeout: 5_000 });
  });

  await test.step('AC-17. a since= request with nothing new is an empty delta; a hidden tab sends no poll; on return one catch-up delta arrives and is highlighted', async () => {
    const snap = await sessionOtel(owner, repoId, live);
    const delta = await sessionOtel(owner, repoId, live, { since: snap.cursor });
    expect(delta).toMatchObject({ full: false, cursor: snap.cursor, calls: [], spans: [], buckets: [], kpis: null });

    await setVisibility(page, 'hidden');
    await expect(page.getByTestId('otel-live-indicator')).toHaveAttribute('data-state', 'hidden');
    const before = polls.count();
    await clearNewRows(page);
    await sendRealtime(api, key.key, { sessionId: live, receiverId: receiver, batchSeq: 3, lines: batch3 });
    await page.waitForTimeout(11_000);
    expect(polls.count(), 'no poll while hidden').toBe(before);
    await setVisibility(page, 'visible');
    await expect.poll(() => polls.count(), { timeout: 3_000 }).toBe(before + 1);
    expect(new URL(polls.urls[polls.urls.length - 1]).searchParams.get('since'), 'the catch-up is a delta').toMatch(/^v1\.\d+$/);
    await expect(row(page, `${tag}l2`)).toBeVisible();
    await expect.poll(() => newRows(page)).toEqual(expect.arrayContaining([`${tag}l2`]));
    await expect(page.getByTestId('otel-turn-label')).toContainText('Turn 1 of 1');
    await expect(page.getByTestId('otel-waterfall-row').filter({ hasText: 'root span not received yet' })).toHaveCount(0);
  });

  await test.step('AC-25. Pause: no poll request; Resume: exactly one catch-up request at once', async () => {
    const pause = page.getByTestId('otel-pause-toggle');
    await pause.click();
    await expect(page.getByTestId('otel-live-indicator')).toHaveAttribute('data-state', 'paused');
    const before = polls.count();
    await page.waitForTimeout(11_000);
    expect(polls.count(), 'paused').toBe(before);
    await pause.click();
    await expect.poll(() => polls.count(), { timeout: 2_000 }).toBe(before + 1);
    await page.waitForTimeout(1_500);
    expect(polls.count(), 'one catch-up, the timer only after a full interval').toBe(before + 1);
    await expect(page.getByTestId('otel-live-indicator')).toHaveAttribute('data-state', 'live');
  });

  await test.step('AC-26 (repository). the sessions table marks the live session «unconfirmed»; the repository notice counts its calls', async () => {
    const f = await repoFacts(owner, repoId);
    expect(f.realtime.unconfirmedCalls).toBe(5);
    expect(f.sessions.find((x) => x.sessionId === live)?.unconfirmedCalls).toBe(5);
    const other = await page.context().newPage();
    await other.goto(`/#/repos/${repoId}?mtab=otel`);
    await expect(other.getByTestId('otel-session-row').filter({ hasText: `live session ${run}` }).getByTestId('otel-session-unconfirmed')).toBeVisible({ timeout: 20_000 });
    await expect(other.getByTestId('otel-notice-unconfirmed')).toContainText('Includes 5 calls');
    await other.close();
  });

  await test.step('AC-18 (after the transcript). the claude log records the two main request ids: nothing is provisional any more, hidden total = the turn’s three hidden calls (AC-3’s rule)', async () => {
    await uploadTranscript(api, key.key, liveSpec, queue, 'claude');
    await waitForOtelProjected(db, live);
    const snap = await sessionOtel(owner, repoId, live);
    expect(snap.calls.filter((c) => c.provisional)).toEqual([]);
    expect(Number(snap.kpis!.hiddenCostUsdMicros)).toBe(turn.hiddenMicros);
    expect(snap.calls.filter((c) => c.structure === 'main').map((c) => c.requestId).sort()).toEqual(turn.transcriptRequestIds);
  });

  await test.step('AC-8, AC-26, AC-4. the same lines as a regular chunk: no duplicate calls or spans, every row confirmed without a highlight, the notice gone; the total equals telemetry_cost', async () => {
    await clearNewRows(page);
    await uploadOtelChunk(api, key.key, live, allLines, queue);
    await waitForOtelProjected(db, live);
    const snap = await sessionOtel(owner, repoId, live);
    expect(snap.calls).toHaveLength(5);
    expect(snap.spans).toHaveLength(6);
    expect(snap.calls.every((c) => c.confirmed)).toBe(true);
    expect(snap.spans.every((x) => x.confirmed)).toBe(true);
    expect(snap.status.realtime.unconfirmedCalls).toBe(0);
    expect(Number(snap.kpis!.totalCostUsdMicros)).toBe(turn.totalMicros);
    expect(Number(snap.kpis!.totalCostUsdMicros)).toBe(await telemetryCost(db, live));

    await expect(page.getByTestId('otel-notice-unconfirmed')).toHaveCount(0, { timeout: 15_000 });
    await expect(row(page, `${tag}l1`)).not.toHaveAttribute('data-unconfirmed', 'true');
    await expect(page.locator('[data-testid="otel-waterfall-row"][data-unconfirmed="true"]')).toHaveCount(0);
    expect(await newRows(page), 'a confirm is never highlighted').toEqual([]);
  });

  await test.step('AC-8. the same chunk uploaded again changes nothing: same cursor, same rows, same total', async () => {
    const before = await sessionOtel(owner, repoId, live);
    await uploadOtelChunk(api, key.key, live, allLines, queue);
    await waitForOtelProjected(db, live);
    const after = await sessionOtel(owner, repoId, live);
    expect(after.calls).toHaveLength(5);
    expect(after.spans).toHaveLength(6);
    expect(after.kpis).toEqual(before.kpis);
    const delta = await sessionOtel(owner, repoId, live, { since: before.cursor });
    expect(delta.calls).toEqual([]);
    expect(delta.spans).toEqual([]);
  });

  const gapSid = `otel01-${run}-gap`;
  const gTag = `g${run}`;
  const gTurn = otelTurn(gTag, base);
  const gsp = (name: keyof typeof gTurn.spans): OtelLine => spanLine(gapSid, gTurn.spans[name]);
  const gcall = (name: keyof typeof gTurn.calls): OtelLine => apiRequestLine(gapSid, gTurn.calls[name]);
  const g1 = [gsp('llm1'), gcall('main1')];
  const g2 = [gsp('tool'), gsp('toolExec'), gsp('suggestion'), gcall('suggestion'), gcall('title'), gcall('unknown')];
  const g3 = [gsp('llm2'), gcall('main2'), gsp('interaction')];

  await test.step('AC-26 (gap). batch 2 never arrives: batch 3 after batch 1 marks a gap; the tab shows the gap notice', async () => {
    await uploadTranscript(api, key.key, { sessionId: gapSid, prompt: `gap session ${run}`, repoUrls: [repoUrl], branch: 'main', at: base, requestIds: gTurn.transcriptRequestIds }, queue);
    await sendRealtime(api, key.key, { sessionId: gapSid, receiverId: `rcv-g-${run}`, batchSeq: 1, lines: g1 });
    await sendRealtime(api, key.key, { sessionId: gapSid, receiverId: `rcv-g-${run}`, batchSeq: 3, lines: g3 });
    expect((await sessionOtel(owner, repoId, gapSid)).status.realtime.gap).toBe(true);
    await openSession(page, owner, repoId, gapSid, { tab: 'otel' });
    // The SPA's session list was loaded before this session existed.
    await page.reload();
    await expect(page.getByTestId('otel-notice-gap')).toContainText('Some realtime data was missed');
    await expect(row(page, `${gTag}t1`)).toHaveCount(0);
  });

  await test.step('AC-26 (fill). the regular chunk fills the gap: the «Filled N calls / M spans» notice, a complete waterfall, totals = telemetry_cost', async () => {
    await uploadOtelChunk(api, key.key, gapSid, [...g1, ...g2, ...g3], queue);
    await waitForOtelProjected(db, gapSid);
    await expect(page.getByTestId('otel-notice-filled')).toContainText('Filled 3 calls / 3 spans from the regular upload', { timeout: 15_000 });
    await expect(row(page, `${gTag}t1`)).toBeVisible();
    await expect(row(page, `${gTag}x1`)).toBeVisible();
    await expect(row(page, `${gTag}l3`)).toBeVisible();
    const snap = await sessionOtel(owner, repoId, gapSid);
    expect(snap.calls).toHaveLength(5);
    expect(snap.spans).toHaveLength(6);
    expect(Number(snap.kpis!.totalCostUsdMicros)).toBe(gTurn.totalMicros);
    expect(Number(snap.kpis!.totalCostUsdMicros)).toBe(await telemetryCost(db, gapSid));
  });

  await test.step('FR-10b. with a mocked clock, OTEL_IDLE_STOP_MS (10 min) without input pauses the indicator («idle»)', async () => {
    const fresh = await page.context().newPage();
    await fresh.clock.install();
    await fresh.goto(`/#/repos/${repoId}?session=${encodeURIComponent(live)}&tab=otel`);
    const indicator = fresh.getByTestId('otel-live-indicator');
    await expect(indicator).toHaveAttribute('data-state', 'live', { timeout: 20_000 });
    await fresh.clock.fastForward('10:30');
    await expect(indicator).toHaveAttribute('data-state', 'idle');
    await fresh.close();
  });
});

// =============================================================================================
// 3. Team tab
// =============================================================================================

interface Person {
  user: ScenarioUser;
  apiKey: string;
}

test('@S-OTEL-01 team OTEL tab: two repositories, shared session counted once, restricted-team access, seven people @mode-a', async ({ api, db, users, page }) => {
  test.setTimeout(360_000);
  const run = randomBytes(4).toString('hex');
  const urlA = `https://git.arrakis.test/scn/${run}/team-a`;
  const urlB = `https://git.arrakis.test/scn/${run}/team-b`;
  const base = floor5m(new Date(Date.now() - 2 * HOUR_MS));
  const person = async (label: string): Promise<Person> => {
    const user = await users.user('user', { label: `otel01-${label}` });
    return { user, apiKey: (await createApiKey(user.api)).key };
  };
  /** One session with one main call of `usd`; `urls` = the repositories its turns are in. */
  const session = async (p: Person, name: string, urls: string[], usd: number, model = MODEL_A, hookVersion?: string) => {
    const sid = `otel01-${run}-${name}`;
    const req = `${name}${run}-req`;
    await uploadTranscript(api, p.apiKey, { sessionId: sid, prompt: `${name} ${run}`, repoUrls: urls, branch: `br-${name}`, at: plus(base, 60), requestIds: [req], hookVersion }, { db, userId: p.user.id });
    await uploadOtelChunk(api, p.apiKey, sid, [apiRequestLine(sid, { requestId: req, querySource: 'repl_main_thread', model, at: plus(base, 120), costUsd: usd, input: 1000, output: 100, cacheRead: 500 })], { db, userId: p.user.id });
    await waitForOtelProjected(db, sid);
    return sid;
  };

  const owner = await person('t-owner');
  const manager = await person('t-manager');
  const member = await person('t-member');
  const trainer = await person('t-trainer');

  const { teamId, shared } = await test.step('setup: a restricted team (owner, manager, plain member, ADLC trainer), repositories A and B; sessions: owner A 0.10, owner A+B 0.20, manager B 0.30, member A 0.40', async () => {
    await session(owner, 'oa', [urlA], 0.1, MODEL_A, '2.28.0');
    const shared = await session(owner, 'oab', [urlA, urlB], 0.2, MODEL_B);
    await session(manager, 'mb', [urlB], 0.3);
    await session(member, 'pa', [urlA], 0.4);
    const teamId = await createTeam(owner.user, `OTEL team ${run}`);
    for (const p of [manager, member, trainer]) await inviteAndAccept(owner.user, p.user, teamId, 'restricted');
    await setMemberRoles(owner.user, teamId, manager.user.id, { isManager: true });
    await setMemberRoles(owner.user, teamId, trainer.user.id, { isAdlcTrainer: true });
    await addTeamRepo(owner.user, teamId, urlA);
    await addTeamRepo(owner.user, teamId, urlB);
    return { teamId, shared };
  });
  const ownerRepoA = await ownRepoId(owner.user.api, urlA);
  const ownerRepoB = await ownRepoId(owner.user.api, urlB);

  await test.step('AC-27 (API). team total = repository A + repository B − the session linked to both; People, Repositories and the cost flow reconcile with it', async () => {
    const t = await teamFacts(owner.user, teamId);
    const a = await repoFacts(owner.user, ownerRepoA, { teamId });
    const b = await repoFacts(owner.user, ownerRepoB, { teamId });
    expect(Number(a.kpis.totalCostUsdMicros)).toBe(micros(0.7));
    expect(Number(b.kpis.totalCostUsdMicros)).toBe(micros(0.5));
    expect(Number(t.kpis.totalCostUsdMicros)).toBe(micros(0.7) + micros(0.5) - micros(0.2));
    expect(t.kpis.sessions).toBe(4);
    expect(sumMicros(t.people)).toBe(micros(1.0));
    expect(t.people.map((p) => p.email).sort()).toEqual([owner, manager, member].map((p) => p.user.email).sort());
    expect(Object.fromEntries(t.repositories.map((r) => [r.repoUrl, Number(r.costUsdMicros)]))).toEqual({ [urlA]: micros(0.7), [urlB]: micros(0.5) });
    expect(sumMicros(t.flows)).toBe(micros(1.0));
    expect(t.filterOptions.people).toHaveLength(3);
    expect(shared).toBeTruthy();
  });

  await test.step('AC-28 (API). the manager sees every acknowledged member; a plain member and an ADLC trainer get 403 on the team and team-repository routes; the plain member’s personal view has their own data', async () => {
    expect((await teamFacts(manager.user, teamId)).people).toHaveLength(3);
    for (const p of [member, trainer]) {
      expect(await teamFactsStatus(p.user, teamId), p.user.email).toBe(403);
    }
    const memberRepoA = await ownRepoId(member.user.api, urlA);
    expect(await repoFactsStatus(member.user, memberRepoA, { teamId })).toBe(403);
    expect(await repoFactsStatus(trainer.user, ownerRepoA, { teamId })).toBe(403);
    const own = await repoFacts(member.user, memberRepoA);
    expect(Number(own.kpis.totalCostUsdMicros)).toBe(micros(0.4));
  });

  await test.step('AC-27 (UI). the team tab: total, three people, two repositories, the user column; the Repository / Branch switch; a People row filters and the picker keeps everyone', async () => {
    await skipNewUserNudge(page.context());
    await owner.user.signIn(page);
    await page.goto(`/#/teams/${teamId}`);
    await page.getByTestId('tab-team-otel').click();
    const tab = page.getByTestId('team-otel-tab');
    await expect(tab.getByTestId('otel-kpi-total')).toContainText(otelUsd(micros(1.0)), { timeout: 20_000 });
    await expect(tab.getByTestId('otel-person-row')).toHaveCount(3);
    await expect(tab.getByTestId('otel-repository-row')).toHaveCount(2);
    const flow = tab.getByTestId('otel-cost-flow');
    await expect(flow.locator('svg text').filter({ hasText: /^User$/ })).toHaveCount(1);
    await expect(flow.locator('svg text').filter({ hasText: /^Repository$/ })).toHaveCount(1);
    await tab.getByTestId('otel-flow-branch-switch').click();
    await expect(flow.locator('svg text').filter({ hasText: /^Repository · branch$/ })).toHaveCount(1);
    await expect(tab.getByTestId('otel-flow-branch-switch')).toHaveText('show repository');

    await tab.getByTestId('otel-person-row').filter({ hasText: member.user.email }).click();
    await expect(tab.getByTestId('otel-kpi-total')).toContainText(otelUsd(micros(0.4)));
    await expect(tab.getByTestId('otel-people-filter').locator('option')).toHaveCount(4);
    await tab.getByTestId('otel-people-filter').selectOption('');
    await expect(tab.getByTestId('otel-kpi-total')).toContainText(otelUsd(micros(1.0)));
  });

  await test.step('AC-27 (UI), visual. a Repositories row opens that repository’s OTEL tab in the team context (with the user column); the team slow banner names the 2.28.0 hook', async () => {
    const tab = page.getByTestId('team-otel-tab');
    await expect(tab.getByTestId('otel-slow-banner')).toContainText('(hook 2.28.0)');
    await tab.getByTestId('otel-repository-row').filter({ hasText: urlA }).click();
    await expect(page).toHaveURL(new RegExp(`#/teams/${teamId}/repos/\\d+\\?mtab=otel`));
    await expect(page.getByTestId('repo-otel-tab').getByTestId('otel-kpi-total')).toContainText(otelUsd(micros(0.7)), { timeout: 20_000 });
    await expect(page.getByTestId('otel-cost-flow').locator('svg text').filter({ hasText: /^User$/ })).toHaveCount(1);
  });

  await test.step('AC-28 (UI). plain member and ADLC trainer: no OTEL tab on the team page or the team repository; the direct link falls back to Sessions; the member’s personal repository OTEL tab shows their own cost', async () => {
    for (const p of [member, trainer]) {
      const ctx = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin });
      await skipNewUserNudge(ctx);
      const other = await ctx.newPage();
      await p.user.signIn(other);
      await other.goto(`/#/teams/${teamId}`);
      await expect(other.getByTestId('tab-team-members')).toBeVisible();
      await expect(other.getByTestId('tab-team-otel'), p.user.email).toHaveCount(0);
      await other.goto(`/#/teams/${teamId}/repos/${ownerRepoA}?mtab=otel`);
      await expect(other.getByTestId('tab-repo-sessions')).toBeVisible();
      await expect(other.getByTestId('tab-repo-otel')).toHaveCount(0);
      await expect(other.getByTestId('repo-otel-tab')).toHaveCount(0);
      if (p === member) {
        await other.goto(`/#/repos/${await ownRepoId(member.user.api, urlA)}?mtab=otel`);
        await expect(other.getByTestId('otel-kpi-total')).toContainText(otelUsd(micros(0.4)), { timeout: 20_000 });
      }
      await ctx.close();
    }
  });

  await test.step('team realtime: an unconfirmed realtime call of a member shows the team notice', async () => {
    const sid = `otel01-${run}-rt`;
    await uploadTranscript(api, member.apiKey, { sessionId: sid, prompt: `team realtime ${run}`, repoUrls: [urlA], branch: 'main', at: new Date(Date.now() - 120_000), requestIds: [] }, { db, userId: member.user.id });
    await sendRealtime(api, member.apiKey, {
      sessionId: sid,
      receiverId: `rcv-t-${run}`,
      batchSeq: 1,
      lines: [apiRequestLine(sid, { requestId: `rt${run}-req`, querySource: 'repl_main_thread', model: MODEL_A, at: new Date(Date.now() - 60_000), costUsd: 0.05, input: 10, output: 1 })],
    });
    expect((await teamFacts(owner.user, teamId)).realtime.unconfirmedCalls).toBe(1);
    await page.goto(`/#/teams/${teamId}`);
    await page.getByTestId('tab-team-otel').click();
    await expect(page.getByTestId('team-otel-tab').getByTestId('otel-notice-unconfirmed')).toContainText('Includes 1 call received in realtime', { timeout: 20_000 });
  });

  await test.step('seven people: the chart legend and the cost flow show the top five plus «others (2)», the People table lists all seven', async () => {
    for (const [n, usd] of [[1, 0.011], [2, 0.012], [3, 0.013], [4, 0.014]] as const) {
      const p = await person(`t-extra${n}`);
      await inviteAndAccept(owner.user, p.user, teamId, 'restricted');
      await session(p, `x${n}`, [urlA], usd);
    }
    const t = await teamFacts(owner.user, teamId);
    expect(t.people).toHaveLength(7);
    await page.goto(`/#/teams/${teamId}`);
    await page.getByTestId('tab-team-otel').click();
    const tab = page.getByTestId('team-otel-tab');
    await expect(tab.getByTestId('otel-person-row')).toHaveCount(7, { timeout: 20_000 });
    const legend = tab.getByTestId('otel-chart-legend');
    await expect(legend.getByRole('button')).toHaveCount(6);
    await expect(legend).toContainText('others (2)');
    await expect(tab.getByTestId('otel-cost-flow').locator('svg text').filter({ hasText: 'others (2)' })).toHaveCount(1);
  });

  await test.step('AC-C4 (team). a member session without OTEL (project-only): the team coverage counts it once, the team tab shows «OTEL for N of M sessions» with a plain (not clickable) project-only chip and the tile N / M', async () => {
    const before = (await teamFacts(owner.user, teamId)).coverage;
    const countOf = (c: typeof before, reason: string) => c.reasons.find((r) => r.reason === reason)?.count ?? 0;
    const sid = `otel01-${run}-team-no-otel`;
    await uploadTranscript(api, member.apiKey, {
      sessionId: sid, prompt: `team no otel ${run}`, repoUrls: [urlA], branch: 'main', at: plus(base, 90), requestIds: [`tno${run}-req`],
      otelStatus: { state: 'none', reason: 'project-only' },
    }, { db, userId: member.user.id });
    const after = (await teamFacts(owner.user, teamId)).coverage;
    expect(after.totalSessions).toBe(before.totalSessions + 1);
    expect(after.otelSessions).toBe(before.otelSessions);
    expect(countOf(after, 'project-only')).toBe(countOf(before, 'project-only') + 1);

    // The URL already shown keeps the SPA state; a reload fetches fresh facts.
    await page.goto(`/#/teams/${teamId}`);
    await page.reload();
    await page.getByTestId('tab-team-otel').click();
    const tab = page.getByTestId('team-otel-tab');
    const n = after.otelSessions;
    const m = after.totalSessions;
    await expect(tab.getByTestId('otel-coverage-text')).toHaveText(
      `OTEL for ${n} of ${m} sessions — totals and averages below cover these ${n} sessions only; the other ${m - n} are not counted as zero.`,
      { timeout: 20_000 },
    );
    const chip = tab.getByTestId('otel-coverage-chip').filter({ hasText: 'project-only' });
    await expect(chip).toHaveCount(1);
    expect(await chip.evaluate((el) => el.tagName), 'the team tab has no sessions list to filter').toBe('SPAN');
    await expect(tab.getByTestId('otel-kpi-coverage')).toContainText(`${n} / ${m}`);
  });
});
