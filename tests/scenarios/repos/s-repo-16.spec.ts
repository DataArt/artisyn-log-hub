// S-REPO-16. Team-view analytics follow the team config: the file-category stats of every
// member's sessions are classified by the team's single config (the seed, then the owner's save,
// then the defaults after a `null` save), the personal view is untouched, and «Recompute all
// sessions» restores team stats (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-16;
// mode A).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3) with `reads` (Read tool calls of
// `docs/guide.md` and `src/app.ts`). `db` counts stats rows, and deletes the team-scoped rows once
// to stand for the stale pre-migration state no endpoint produces (`db-seed.ts` rule).
//
// Steps 7–11 — the OKF tab, team vs personal (2026-10-27-okf-usage-tab FR-5 / FR-17, response
// and view of 2026-11-21-okf-tab-minimal): owner and member each upload an OKF session tree
// (helpers/okf.ts, DD-36) whose snapshot has a tracked bundle `docs/kb-<run>` with one gitignored
// article (`secret.md`) and a gitignored bundle `docs/private-<run>`. The personal view counts
// both bundles and the ignored article; the team view (the repo tab and a session's OKF tab)
// drops every ignored path from the summary, the files and the bundle roots (fail-closed).
// «Recompute all sessions» refills `session_okf_access` after its rows are deleted; the bundle
// filter narrows the files and the read numbers and keeps `unitsTotal`. None of the blocks removed
// on 2026-11-21 (verdict card, KPI tiles, value signals, upkeep, thresholds) renders any more.
//
// Steps 12–13 — counting rules (2026-11-21-okf-tab-minimal FR-0): the owner uploads two trees
// against a new, well-formed bundle `docs/clean-<run>` (format 0.3) with a nested bundle: one on
// `main` with a file grep, a folder grep and a read of a `.md` outside every bundle, one on a
// feature branch whose own snapshot adds `gone.md` and reads it. Step 12 checks the response sums
// and the explorer (search row, nested root, «Not in this snapshot», never-opened files), then
// Versions / Wrong format of a clean bundle; step 13 the hot-files table (sort, index line, the
// same numbers as the explorer, the ≈ $ tooltip).
//
// Step 14 — OKF v0.3 front matter (2026-11-19): a hook 3.1.0 tree (bundle `docs/v03-<run>`,
// version 0.1, per-file `meta`): the Versions row, the five Wrong-format groups, no dot-path
// file, the 1600×1000 fit, and a recompute after the extract-version bump (4).
//
// Replaces: none (2026-10-16-team-vs-personal-config).
import { randomBytes } from 'crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { expectOkfTreeFits, expectOkfViewFits, uploadOkfSessionTree, type OkfAction } from '../helpers/okf';
import { ownRepoId, rangeAround, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept } from '../helpers/teams';

interface RepoConfig {
  fileCategories: Array<{ name: string; patterns: string[] }>;
  highCacheCreationThreshold?: number;
}

/** One file of `OkfUsageResponse.files` (2026-11-21-okf-tab-minimal, "API changes"). */
interface OkfUsageFile {
  bundle: string;
  path: string;
  inSnapshot: boolean;
  index: boolean;
  units: number;
  reads: number;
  tokens: number;
  cost: number | null;
}

interface OkfUsageFolder {
  bundle: string;
  path: string;
  units: number;
  search: { units: number; reads: number; tokens: number; cost: number | null } | null;
}

/** `GET …/reports/okf-usage` and `GET …/sessions/:id/okf-usage` — one shape for both. */
interface OkfUsage {
  unit: 'sessions' | 'agents';
  snapshot: { branch: string | null; takenAt: string; hasMeta: boolean } | null;
  bundleRoots: string[];
  currentFormat: string;
  summary: {
    unitsRead: number;
    unitsTotal: number;
    reads: number;
    tokens: number;
    cost: number | null;
    readsWithoutCost: number;
    spend: number | null;
  };
  versions: Array<{ root: string; files: number; okfVersion: string | null; older: boolean; ignored: boolean }>;
  format: {
    articles: number;
    indexFiles: number;
    withProblems: number;
    groups: Array<{ problem: string; files: Array<{ path: string; supersededBy?: string }> }>;
  } | null;
  files: OkfUsageFile[];
  folders: OkfUsageFolder[];
  notInSnapshotUnits: number;
}

/** Ids of the OKF blocks removed on 2026-11-21: none of them may render on the repo tab. */
const REMOVED_OKF_IDS = [
  'okf-verdict-card',
  'okf-kpi-tiles',
  'okf-section-b',
  'okf-upkeep-row',
  'okf-analysis-banner',
  'okf-thresholds-chip',
];

/** The ≈ $ tooltip's first paragraph (DD-20, exact). */
const OKF_COST_TIP =
  'For each agent: the KB share of what it put into its context × what that context cost (input + cache write + cache read; output is not included). Assumes KB text is carried and re-read from the cache like the rest of the context. Spend = total cost of the same sessions.';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * The invariants of the response ("API changes"): the files and the folder searches add up to
 * the summary, and the snapshot's files are the versions' files = articles + index files.
 */
function expectOkfSums(u: OkfUsage, label: string): void {
  const searches = u.folders.flatMap((f) => (f.search === null ? [] : [f.search]));
  expect(sum(u.files.map((f) => f.tokens)) + sum(searches.map((s) => s.tokens)), `${label}: tokens add up`).toBeCloseTo(u.summary.tokens, 6);
  expect(sum(u.files.map((f) => f.reads)) + sum(searches.map((s) => s.reads)), `${label}: reads add up`).toBe(u.summary.reads);
  expect(sum(u.files.map((f) => f.cost ?? 0)) + sum(searches.map((s) => s.cost ?? 0)), `${label}: costs add up`).toBeCloseTo(
    u.summary.cost ?? 0,
    9,
  );
  const inSnapshot = u.files.filter((f) => f.inSnapshot).length;
  if (u.snapshot?.hasMeta) {
    expect(sum(u.versions.map((v) => v.files)), `${label}: versions list every snapshot file`).toBe(inSnapshot);
    expect((u.format?.articles ?? 0) + (u.format?.indexFiles ?? 0), `${label}: articles + index files`).toBe(inSnapshot);
  }
}

interface TimelineRow {
  sessionId: string;
  fileStatsByCategory: Record<string, { files: number; bytes: number }>;
}

const TEAM_DOCS: RepoConfig = { fileCategories: [{ name: 'team_docs', patterns: ['^docs/'] }], highCacheCreationThreshold: 55_000 };
const MEMBER_CAT: RepoConfig = { fileCategories: [{ name: 'member_src', patterns: ['^src/'] }] };

test('@S-REPO-16 team-view analytics follow the team config for every member’s sessions @mode-a', async ({
  api,
  browser,
  db,
  stand,
  users,
}) => {
  test.setTimeout(480_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/team-analytics`;
  const owner = await users.user('user', { label: 'r16-owner' });
  const member = await users.user('user', { label: 'r16-member' });
  const reads = ['docs/guide.md', 'src/app.ts'];
  const sid = (who: string) => `r16-${run}-${who}`;

  const { teamId, repo } = await test.step('setup: transparent team (owner + member); both upload sessions reading docs/guide.md and src/app.ts; the URL is linked', async () => {
    const teamId = await createTeam(owner, `Analytics-${run}`);
    expect((await owner.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
    await inviteAndAccept(owner, member, teamId, 'transparent');
    const repo = new Map<ScenarioUser, number>();
    for (const [who, user] of [
      ['owner', owner],
      ['member', member],
    ] as Array<[string, ScenarioUser]>) {
      const key = await createApiKey(user.api);
      await uploadPromptSession(api, key.key, { sessionId: sid(who), prompt: `${who} ${run}`, repoUrl, reads }, { db, userId: user.id });
      repo.set(user, await ownRepoId(user.api, repoUrl));
    }
    await addTeamRepo(owner, teamId, repoUrl);
    return { teamId, repo };
  });

  const repoOf = (user: ScenarioUser) => repo.get(user)!;
  const timeline = async (user: ScenarioUser, query: string) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/analytics/timeline?${query}${rangeAround()}`);
    expect(res.status(), `${user.email} timeline ${query}`).toBe(200);
    const rows = (await res.json()) as TimelineRow[];
    return new Map(rows.map((r) => [r.sessionId, Object.keys(r.fileStatsByCategory).sort()]));
  };
  const teamTimeline = (user: ScenarioUser) => timeline(user, `teamId=${teamId}&`);
  const personalTimeline = (user: ScenarioUser) => timeline(user, '');
  const putTeam = async (config: RepoConfig | null) => {
    const res = await owner.api.put(`/api/v1/repositories/${repoOf(owner)}/settings/team?teamId=${teamId}`, { data: { config } });
    expect(res.status()).toBe(200);
  };
  const causes = async (user: ScenarioUser, query: string) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/reports/cache-read-ratio?${query}${rangeAround()}`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { causes: { thresholdTokens: number; thresholdSource: string; sessionsWithoutCauseData: number } })
      .causes;
  };
  const teamRows = async (table: 'session_file_stats' | 'session_cause_stats') =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(DISTINCT t.session_id) AS n FROM ${table} t JOIN sessions s ON s.id = t.session_id
           WHERE t.team_id = $1 AND s.session_id = ANY($2)`,
          [teamId, [sid('owner'), sid('member')]],
        )
      ).rows[0].n,
    );

  // The member's personal config is set before anything else, so the personal view must keep it
  // through every team-side change below.
  expect((await member.api.put(`/api/v1/repositories/${repoOf(member)}/settings/user`, { data: { config: MEMBER_CAT } })).status()).toBe(
    200,
  );
  const personalBefore = await personalTimeline(member);
  expect(personalBefore.get(sid('member'))).toContain('member_src');

  await test.step('1. FR-9 seed: before any save the member’s team view shows the seeded `docs` for both members’ sessions', async () => {
    const t = await teamTimeline(member);
    expect(t.get(sid('owner'))).toContain('docs');
    expect(t.get(sid('member'))).toContain('docs');
  });

  await test.step('2. AC-6 / FR-7: after the owner saves team_docs, the member’s team view shows team_docs for both sessions; threshold = team', async () => {
    await putTeam(TEAM_DOCS);
    const t = await teamTimeline(member);
    for (const who of ['owner', 'member']) {
      expect(t.get(sid(who)), who).toContain('team_docs');
      expect(t.get(sid(who)), who).not.toContain('docs');
    }
    const c = await causes(member, `teamId=${teamId}&`);
    expect({ tokens: c.thresholdTokens, source: c.thresholdSource }).toEqual({ tokens: 55_000, source: 'team' });
    expect(c.sessionsWithoutCauseData).toBe(0);
    expect(await teamRows('session_file_stats')).toBe(2);
    expect(await teamRows('session_cause_stats')).toBe(2);
  });

  await test.step('3. Personal view is untouched; personal cache-read-ratio has the member’s own cause rows (DD 11)', async () => {
    expect(await personalTimeline(member)).toEqual(personalBefore);
    const c = await causes(member, '');
    expect(c.sessionsWithoutCauseData).toBe(0);
  });

  await test.step('4. UI (FR-12): team view Settings → File Categories shows team_docs; personal view shows the member’s own', async () => {
    const { context, page } = await browserAs(
      browser,
      stand.url,
      member,
      `/#/teams/${teamId}/repos/${repoOf(member)}?mtab=settings&stab=file-categories`,
    );
    try {
      await expect(page.getByPlaceholder('Category name').first()).toHaveValue('team_docs');
      await page.goto(`/#/repos/${repoOf(member)}?mtab=settings&stab=file-categories`);
      await page.reload();
      await expect(page.getByPlaceholder('Category name').first()).toHaveValue('member_src');
    } finally {
      await context.close();
    }
  });

  await test.step('5. FR-9: after PUT null the team view shows the default categories, not team_docs', async () => {
    await putTeam(null);
    const t = await teamTimeline(member);
    for (const who of ['owner', 'member']) {
      expect(t.get(sid(who)), who).toContain('docs');
      expect(t.get(sid(who)), who).not.toContain('team_docs');
    }
    expect(await personalTimeline(member)).toEqual(personalBefore);
  });

  await test.step('6. Recompute all sessions (team view, owner) restores deleted team-scoped stats rows', async () => {
    await db.query(
      `DELETE FROM session_file_stats WHERE team_id = $1 AND session_id IN (SELECT id FROM sessions WHERE session_id = ANY($2))`,
      [teamId, [sid('owner'), sid('member')]],
    );
    await db.query(
      `DELETE FROM session_cause_stats WHERE team_id = $1 AND session_id IN (SELECT id FROM sessions WHERE session_id = ANY($2))`,
      [teamId, [sid('owner'), sid('member')]],
    );
    expect(await teamRows('session_file_stats')).toBe(0);
    const res = await owner.api.post(`/api/v1/repositories/${repoOf(owner)}/recompute-all-sessions?teamId=${teamId}`);
    expect(res.status()).toBe(201);
    expect(await teamRows('session_file_stats')).toBe(2);
    expect(await teamRows('session_cause_stats')).toBe(2);
  });

  // ── OKF usage tab: team vs personal, recompute, bundle filter ─────────────────────────────
  const kb = `docs/kb-${run}`;
  const priv = `docs/private-${run}`;
  const secret = `${kb}/secret.md`;
  const okfSid = (who: string) => `r16-${run}-okf-${who}`;
  const okfSnapshot = {
    bundles: [
      { root: kb, files: [`${kb}/a.md`, `${kb}/b.md`, { path: secret, ignored: true }] },
      { root: priv, ignored: true, files: [{ path: `${priv}/notes.md`, ignored: true }] },
    ],
  };
  const okfReads: Record<string, OkfAction[]> = {
    owner: [{ read: `${kb}/index.md` }, { read: `${kb}/a.md` }, { read: secret, bytes: 5000 }, { read: `${priv}/notes.md`, bytes: 7000 }],
    member: [{ read: `${kb}/b.md` }, { read: `${priv}/notes.md`, bytes: 7000 }],
  };
  const repoOkf = async (user: ScenarioUser, query: Record<string, string>) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/reports/okf-usage?${rangeAround()}`, { params: query });
    expect(res.status(), `okf-usage ${JSON.stringify(query)}`).toBe(200);
    return (await res.json()) as OkfUsage;
  };
  const sessionOkf = async (user: ScenarioUser, query: Record<string, string>) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/sessions/${okfSid('owner')}/okf-usage`, { params: query });
    expect(res.status(), `session okf-usage ${JSON.stringify(query)}`).toBe(200);
    return (await res.json()) as OkfUsage;
  };
  const okfRowCount = async () =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM session_okf_access a JOIN sessions s ON s.id = a.session_id WHERE s.session_id = ANY($1)`,
          [[okfSid('owner'), okfSid('member')]],
        )
      ).rows[0].n,
    );

  await test.step('7. setup: owner and member each upload an OKF session tree (a tracked bundle with an ignored article, an ignored bundle)', async () => {
    for (const [who, user] of [
      ['owner', owner],
      ['member', member],
    ] as Array<[string, ScenarioUser]>) {
      const key = await createApiKey(user.api);
      await uploadOkfSessionTree(
        api,
        key.key,
        { sessionId: okfSid(who), repoUrl, prompt: `okf ${who} ${run}`, snapshot: okfSnapshot, actions: okfReads[who] },
        { db, userId: user.id },
      );
    }
    expect(await okfRowCount(), 'every read of both trees is stored, ignored paths too (filtered at read time)').toBe(6);
  });

  /** One explorer row by its kind and `data-path` (a folder key ends in `/`, a bundle is its root). */
  const treeRow = (page: Page, kind: 'bundle' | 'folder' | 'file' | 'search', path: string) =>
    page.locator(`[data-testid="okf-tree-row"][data-kind="${kind}"][data-path="${path}"]`);
  /** Opens (or closes) an expandable explorer row. */
  const toggleRow = (row: Locator) => row.getByRole('button').first().click();
  const hotRow = (page: Page, path: string) => page.locator(`[data-testid="okf-hot-row"][data-path="${path}"]`);
  const paths = (u: OkfUsage) => u.files.map((f) => f.path);

  await test.step('8. FR-17 repo OKF tab: the personal view counts both bundles and the ignored article; the team view drops every ignored path; no removed block renders', async () => {
    const personal = await repoOkf(owner, {});
    expect(personal.unit).toBe('sessions');
    expect(personal.snapshot, 'an old-hook snapshot: no metadata').toMatchObject({ branch: 'main', hasMeta: false });
    expect(personal.bundleRoots).toEqual([kb, priv].sort());
    expect(paths(personal), 'every snapshot file, the index files too').toEqual(
      [`${kb}/a.md`, `${kb}/b.md`, `${kb}/index.md`, secret, `${priv}/index.md`, `${priv}/notes.md`].sort(),
    );
    expect(personal.files.every((f) => f.inSnapshot)).toBe(true);
    // The owner's own sessions: the setup prompt session and the OKF tree; the tree read the
    // index, a.md, secret.md (5000 B) and the private notes (7000 B) — bytes / 4.
    expect(personal.summary).toMatchObject({ unitsRead: 1, unitsTotal: 2, reads: 4, tokens: 3500 });
    expect(personal.files.find((f) => f.path === secret)).toMatchObject({ units: 1, reads: 1, tokens: 1250 });
    expect(personal.files.find((f) => f.path === `${kb}/b.md`), 'the member’s read is not in the owner’s view').toMatchObject({ units: 0 });
    expect({ versions: personal.versions, format: personal.format }, 'no metadata: no versions, no format').toEqual({
      versions: [],
      format: null,
    });
    expectOkfSums(personal, 'personal');

    const team = await repoOkf(member, { teamId: String(teamId) });
    expect(team.bundleRoots).toEqual([kb]);
    expect(paths(team), 'a.md, b.md and the index — not secret.md, not the private bundle').toEqual([`${kb}/a.md`, `${kb}/b.md`, `${kb}/index.md`]);
    expect(team.summary, 'both members’ trees read a visible file; 4 sessions of the two members').toMatchObject({
      unitsRead: 2,
      unitsTotal: 4,
      reads: 3,
      tokens: 750,
    });
    expect(team.notInSnapshotUnits, 'a hidden path is not a "not in this snapshot" file either').toBe(0);
    expect(JSON.stringify(team)).not.toContain(secret);
    expect(JSON.stringify(team)).not.toContain(priv);
    expectOkfSums(team, 'team');

    const { context, page } = await browserAs(browser, stand.url, member, `/#/teams/${teamId}/repos/${repoOf(member)}?mtab=okf`);
    try {
      await expect(page.getByTestId('tab-repo-okf')).toHaveAttribute('data-state', 'active');
      const tab = page.getByTestId('repo-okf-tab');
      await expect(page.getByTestId('okf-summary-ratio')).toHaveText('KB read in 2 of 4 sessions');
      await expect(page.getByTestId('okf-summary-tokens')).toHaveText('≈ 0.8K tokens of context');
      await expect(page.getByTestId('okf-summary-snapshot')).toContainText('snapshot from main, ');
      await expect(page.getByTestId('okf-old-hook-line')).toHaveText('Update the hook to see versions and format problems.');
      await expect(page.getByTestId('okf-tree-header')).toHaveText('3 of 3 files opened');
      await expect(treeRow(page, 'bundle', kb)).toHaveCount(1);
      await expect(page.getByTestId('okf-tree-row')).toHaveCount(1);
      await expect(hotRow(page, `${kb}/a.md`)).toHaveCount(1);
      await expect(hotRow(page, `${kb}/b.md`)).toHaveCount(1);
      await toggleRow(treeRow(page, 'bundle', kb));
      await expect(treeRow(page, 'file', `${kb}/a.md`)).toHaveAttribute('data-opened', 'true');
      await expect(tab).not.toContainText('secret.md');
      await expect(tab).not.toContainText(priv);
      for (const id of REMOVED_OKF_IDS) await expect(page.getByTestId(id), `${id} is gone`).toHaveCount(0);
      await expectOkfViewFits(page);

      // The thresholds section left Settings → Analysis with the blocks that used it.
      await page.goto(`/#/teams/${teamId}/repos/${repoOf(member)}?mtab=settings&stab=analysis`);
      await expect(page.getByTestId('cache-creation-threshold-setting')).toBeVisible();
      await expect(page.getByTestId('okf-thresholds-setting')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  await test.step('9. FR-17 session OKF tab: the team URL hides the ignored article and bundle; the personal view keeps them', async () => {
    const personal = await sessionOkf(owner, {});
    expect(personal.unit).toBe('agents');
    expect(paths(personal)).toContain(secret);
    expect(paths(personal)).toContain(`${priv}/notes.md`);
    expect(personal.summary, 'one agent, four reads').toMatchObject({ unitsRead: 1, unitsTotal: 1, reads: 4, tokens: 3500 });
    expectOkfSums(personal, 'session personal');

    const team = await sessionOkf(member, { teamId: String(teamId) });
    expect(team.bundleRoots).toEqual([kb]);
    expect(paths(team)).toEqual([`${kb}/a.md`, `${kb}/b.md`, `${kb}/index.md`]);
    expect(team.summary, 'the index and a.md only').toMatchObject({ unitsRead: 1, unitsTotal: 1, reads: 2, tokens: 500 });
    expect(JSON.stringify(team)).not.toContain(secret);
    expect(JSON.stringify(team)).not.toContain(priv);

    const { context, page } = await browserAs(
      browser,
      stand.url,
      member,
      `/#/teams/${teamId}/repos/${repoOf(member)}?session=${encodeURIComponent(okfSid('owner'))}&tab=okf`,
    );
    try {
      const tab = page.getByTestId('session-okf-tab');
      await expect(tab).toBeVisible();
      await expect(tab.getByTestId('okf-summary-ratio')).toHaveText('KB read by 1 of 1 agents');
      await expect(tab.getByTestId('okf-tree-header')).toHaveText('2 of 3 files opened in this session');
      await toggleRow(treeRow(page, 'bundle', kb));
      await expect(treeRow(page, 'file', `${kb}/a.md`)).toHaveAttribute('data-opened', 'true');
      await expect(treeRow(page, 'file', `${kb}/b.md`)).toHaveAttribute('data-opened', 'false');
      await expect(tab).not.toContainText('secret.md');
      await expect(tab).not.toContainText('notes.md');
    } finally {
      await context.close();
    }
  });

  await test.step('10. FR-5: «Recompute all sessions» refills session_okf_access for sessions whose rows are gone', async () => {
    await db.query(`DELETE FROM session_okf_access WHERE session_id IN (SELECT id FROM sessions WHERE session_id = ANY($1))`, [
      [okfSid('owner'), okfSid('member')],
    ]);
    expect(await okfRowCount()).toBe(0);
    expect((await repoOkf(owner, {})).summary).toMatchObject({ unitsRead: 0, reads: 0, tokens: 0 });
    // A repository row is per user: the owner's recompute covers the sessions linked to the
    // owner's row (4 reads), the member's own recompute the member's (2 reads).
    const recompute = async (user: ScenarioUser) =>
      expect((await user.api.post(`/api/v1/repositories/${repoOf(user)}/recompute-all-sessions`)).status()).toBe(201);
    await recompute(owner);
    expect(await okfRowCount()).toBe(4);
    expect((await repoOkf(owner, {})).summary.unitsRead).toBe(1);
    await recompute(member);
    expect(await okfRowCount()).toBe(6);
    expect((await repoOkf(member, { teamId: String(teamId) })).summary.unitsRead).toBe(2);
  });

  await test.step('11. bundle filter (personal view): one bundle narrows the files and the read numbers, keeps the session total and the bundle list; the URL keeps it', async () => {
    const all = await repoOkf(owner, {});
    const one = await repoOkf(owner, { bundle: kb });
    expect(one.bundleRoots, 'the select keeps every bundle').toEqual([kb, priv].sort());
    expect(paths(one), 'the kb bundle’s files only').toEqual([`${kb}/a.md`, `${kb}/b.md`, `${kb}/index.md`, secret]);
    expect(JSON.stringify({ files: one.files, folders: one.folders })).not.toContain(priv);
    expect(one.summary, 'the private notes’ read (7000 B) is out').toMatchObject({ unitsRead: 1, reads: 3, tokens: 1750 });
    expect({ unitsTotal: one.summary.unitsTotal, spend: one.summary.spend }, 'the scope’s totals do not follow the bundle').toEqual({
      unitsTotal: all.summary.unitsTotal,
      spend: all.summary.spend,
    });
    expectOkfSums(one, 'one bundle');

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf`);
    try {
      await expect(page.getByTestId('okf-tree-header')).toHaveText('4 of 6 files opened');
      await expect(page.getByTestId('okf-summary-ratio')).toHaveText('KB read in 1 of 2 sessions');
      await expect(page.getByTestId('okf-tree')).toContainText(priv);
      await page.getByTestId('okf-bundle-select').click();
      await page.getByRole('option', { name: kb, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`okfBundle=${escapeRe(encodeURIComponent(kb))}`));
      await expect(page.getByTestId('okf-tree-header')).toHaveText('3 of 4 files opened');
      await expect(page.getByTestId('okf-summary-ratio'), 'the session total stays').toHaveText('KB read in 1 of 2 sessions');
      await expect(page.getByTestId('okf-tree')).toContainText(kb);
      await expect(page.getByTestId('okf-tree')).not.toContainText(priv);
      await expect(page.getByTestId('okf-hot-files')).not.toContainText('notes.md');
    } finally {
      await context.close();
    }
  });

  // ── Counting rules (2026-11-21 FR-0): a clean 0.3 bundle with a nested bundle ──────────────
  const clean = `docs/clean-${run}`;
  const nested = `${clean}/deep`;
  const article = { frontMatter: true, hasGenerated: true, hasTimestamp: false, type: 'Article' };
  const indexMeta = { ...article, type: 'Index' };
  const cleanFiles = [
    { path: `${clean}/index.md`, meta: indexMeta },
    { path: `${clean}/grepped.md`, meta: article },
    { path: `${clean}/read.md`, meta: article },
    { path: `${clean}/never.md`, meta: article },
    { path: `${clean}/sub/topic.md`, meta: article },
  ];
  const nestedBundle = {
    root: nested,
    okfVersion: '0.3',
    files: [
      { path: `${nested}/index.md`, meta: indexMeta },
      { path: `${nested}/inner.md`, meta: article },
    ],
  };
  const cleanSnapshot = { bundles: [{ root: clean, okfVersion: '0.3', files: cleanFiles }, nestedBundle] };
  // The feature branch added one article the `main` snapshot does not list.
  const goneSnapshot = {
    bundles: [{ root: clean, okfVersion: '0.3', files: [...cleanFiles, { path: `${clean}/gone.md`, meta: article }] }, nestedBundle],
  };
  const gone = `${clean}/gone.md`;
  const readMd = `${clean}/read.md`;

  await test.step('12. FR-0 counting: a file grep opens the file, a folder grep is a search row, a .md outside the bundle counts nowhere, a nested bundle is its own root, a file of another branch is «Not in this snapshot»; the sums hold', async () => {
    const key = (await createApiKey(owner.api)).key;
    // Older than the `main` tree and on a feature branch: its snapshot is never the reference.
    await uploadOkfSessionTree(
      api,
      key,
      {
        sessionId: okfSid('gone'),
        repoUrl,
        branch: `feat/gone-${run}`,
        prompt: `okf gone ${run}`,
        snapshot: goneSnapshot,
        actions: [{ read: gone, bytes: 2400 }, { read: readMd, bytes: 1200 }],
      },
      { db, userId: owner.id },
    );
    await uploadOkfSessionTree(
      api,
      key,
      {
        sessionId: okfSid('fr0'),
        repoUrl,
        prompt: `okf fr0 ${run}`,
        snapshot: cleanSnapshot,
        actions: [
          { grep: `${clean}/grepped.md`, bytes: 400 },
          { grep: clean, bytes: 800 },
          { read: 'docs/other.md', bytes: 4000 },
          { read: readMd, bytes: 2000 },
          { read: `${clean}/index.md`, bytes: 1200 },
          { read: `${nested}/inner.md`, bytes: 1600 },
        ],
      },
      { db, userId: owner.id },
    );

    const usage = await repoOkf(owner, {});
    expect(usage.snapshot, 'the newest tree on main, not the feature branch’s').toMatchObject({ branch: 'main', hasMeta: true });
    expect(usage.bundleRoots).toEqual([clean, nested]);
    expectOkfSums(usage, 'fr0');
    // Four own sessions (setup, the step-7 tree, the two trees here); the step-7 tree's reads
    // are outside the reference snapshot's bundles, so only the two new trees read this KB.
    expect(usage.summary, '7 reads: 100 + 200 + 500 + 300 + 400 (main) + 600 + 300 (branch) tokens').toMatchObject({
      unitsRead: 2,
      unitsTotal: 4,
      reads: 7,
      tokens: 2400,
    });
    const file = (path: string) => usage.files.find((f) => f.path === path);
    expect(file(`${clean}/grepped.md`), 'a file touched only by grep is opened').toMatchObject({ units: 1, reads: 1, tokens: 100, inSnapshot: true });
    expect(file(readMd), 'read by both trees').toMatchObject({ units: 2, reads: 2, tokens: 800 });
    expect(file(`${clean}/never.md`)).toMatchObject({ units: 0, reads: 0, tokens: 0, cost: 0 });
    expect(file(`${clean}/index.md`)).toMatchObject({ index: true, units: 1, tokens: 300 });
    expect(file(`${nested}/inner.md`), 'a nested bundle’s file belongs to the deepest root').toMatchObject({ bundle: nested, units: 1, tokens: 400 });
    expect(file(gone), 'read, but not in the reference snapshot').toMatchObject({ bundle: clean, inSnapshot: false, units: 1, tokens: 600 });
    expect(usage.notInSnapshotUnits).toBe(1);
    expect(JSON.stringify(usage), 'a .md outside every bundle counts nowhere').not.toContain('docs/other.md');
    const folder = (path: string) => usage.folders.find((f) => f.path === path);
    expect(usage.folders.map((f) => f.path)).toEqual([`${clean}/`, `${nested}/`, `${clean}/sub/`]);
    expect(folder(`${clean}/`), 'the folder grep is in no file; both trees opened a file of the folder').toMatchObject({
      bundle: clean,
      units: 2,
      search: { units: 1, reads: 1, tokens: 200 },
    });
    expect(folder(`${nested}/`)).toMatchObject({ bundle: nested, units: 1, search: null });
    expect(folder(`${clean}/sub/`)).toMatchObject({ units: 0, search: null });
    expect(usage.versions).toEqual([
      { root: clean, files: 5, okfVersion: '0.3', older: false, ignored: false },
      { root: nested, files: 2, okfVersion: '0.3', older: false, ignored: false },
    ]);
    expect(usage.format).toEqual({ articles: 5, indexFiles: 2, withProblems: 0, groups: [] });

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf`);
    try {
      // X = opened snapshot files (grepped, index, read, inner), Y = snapshot files.
      const opened = usage.files.filter((f) => f.inSnapshot && f.units > 0).length;
      const total = usage.files.filter((f) => f.inSnapshot).length;
      expect({ opened, total }).toEqual({ opened: 4, total: 7 });
      await expect(page.getByTestId('okf-summary-ratio')).toHaveText('KB read in 2 of 4 sessions');
      await expect(page.getByTestId('okf-summary-tokens')).toHaveText('≈ 2.4K tokens of context');
      await expect(page.getByTestId('okf-tree-header')).toHaveText(`${opened} of ${total} files opened`);
      await expect(page.getByTestId('okf-tree-filter-opened')).toHaveText(`Opened (${opened})`);
      await expect(page.getByTestId('okf-tree-filter-never')).toHaveText(`Never opened (${total - opened})`);

      // Collapsed at first: the two bundle roots (the nested one is its own root) and the
      // «Not in this snapshot» root.
      const rows = page.getByTestId('okf-tree-row');
      await expect(rows).toHaveCount(3);
      const cleanRoot = treeRow(page, 'bundle', clean);
      await expect(cleanRoot).toContainText('3 of 5');
      await expect(cleanRoot).toContainText('1.4K');
      await expect(treeRow(page, 'bundle', nested)).toContainText('1 of 2');
      const missingRoot = page.locator('[data-testid="okf-tree-row"][data-kind="missing-root"]');
      await expect(missingRoot).toContainText('Not in this snapshot');
      await expect(missingRoot).toContainText('1 file');

      await toggleRow(cleanRoot);
      const search = treeRow(page, 'search', `${clean}/`);
      await expect(search).toContainText('searches across this folder');
      await expect(search).toContainText('0.2K');
      await expect(treeRow(page, 'folder', `${clean}/sub/`)).toContainText('0 of 1');
      await expect(treeRow(page, 'file', `${clean}/grepped.md`)).toHaveAttribute('data-opened', 'true');
      await expect(treeRow(page, 'file', `${clean}/never.md`)).toHaveAttribute('data-opened', 'false');
      await expect(treeRow(page, 'file', `${nested}/inner.md`), 'the nested bundle’s file is not under the outer root').toHaveCount(0);
      await toggleRow(treeRow(page, 'bundle', nested));
      await expect(treeRow(page, 'file', `${nested}/inner.md`)).toHaveAttribute('data-opened', 'true');
      await expect(treeRow(page, 'file', gone)).toHaveCount(0);
      await toggleRow(missingRoot);
      await expect(treeRow(page, 'file', gone)).toHaveText(new RegExp(escapeRe(gone)));
      await expect(page.getByTestId('repo-okf-tab')).not.toContainText('other.md');
      await expectOkfTreeFits(page);

      // «Never opened»: only the never-opened files, no search row, no «Not in this snapshot».
      await page.getByTestId('okf-tree-filter-never').click();
      await expect(missingRoot).toHaveCount(0);
      await expect(search).toHaveCount(0);
      await expect(page.locator('[data-testid="okf-tree-row"][data-kind="file"][data-opened="true"]')).toHaveCount(0);
      await expect(treeRow(page, 'file', `${clean}/never.md`)).toHaveCount(1);
      await toggleRow(treeRow(page, 'folder', `${clean}/sub/`));
      await expect(page.locator('[data-testid="okf-tree-row"][data-kind="file"]')).toHaveCount(total - opened);

      // One clean bundle: Versions is one collapsed line, Wrong format one line.
      await page.getByTestId('okf-bundle-select').click();
      await page.getByRole('option', { name: clean, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`okfBundle=${escapeRe(encodeURIComponent(clean))}`));
      const versions = page.getByTestId('okf-versions');
      await expect(versions).toHaveAttribute('data-collapsed', 'true');
      await expect(versions).toContainText('1 KB folder, on format 0.3');
      await expect(page.getByTestId('okf-version-row')).toHaveCount(0);
      await page.getByTestId('okf-versions-toggle').click();
      await expect(versions).toHaveAttribute('data-collapsed', 'false');
      const versionRow = page.locator(`[data-testid="okf-version-row"][data-root="${clean}"]`);
      await expect(versionRow).toContainText('5 files');
      await expect(versionRow).toContainText('0.3');
      await expect(versionRow.getByTestId('okf-version-older')).toHaveCount(0);
      await expect(page.getByTestId('okf-format-ok')).toHaveText('✓ All 4 articles are well-formed · 1 index file is not checked');
      await expect(page.getByTestId('okf-format-group')).toHaveCount(0);
      await expect(page.getByTestId('okf-summary-ratio'), 'the nested bundle’s read is out, the total stays').toHaveText(
        'KB read in 2 of 4 sessions',
      );
      await expect(page.getByTestId('okf-tree-header')).toHaveText('3 of 5 files opened');
    } finally {
      await context.close();
    }
  });

  await test.step('13. hot files: sorted by ≈ Tokens at first, a click sorts by ≈ $; index files are one line below the table; a file has the same numbers as in the explorer; the ≈ $ tooltip', async () => {
    const usage = await repoOkf(owner, {});
    const hot = usage.files.filter((f) => f.units > 0 && !f.index);
    /** Descending by `value`, ties by path — the table's order. */
    const order = (value: (f: OkfUsageFile) => number) =>
      [...hot].sort((a, b) => value(b) - value(a) || (a.path < b.path ? -1 : 1)).map((f) => f.path);
    const byTokens = order((f) => f.tokens);
    expect(byTokens, 'read.md 800, gone.md 600, inner.md 400, grepped.md 100').toEqual([
      readMd,
      gone,
      `${nested}/inner.md`,
      `${clean}/grepped.md`,
    ]);

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf`);
    try {
      const table = page.getByTestId('okf-hot-files');
      const header = (key: string) => table.locator('th', { has: page.getByTestId(`okf-hot-sort-${key}`) });
      const shownPaths = () => table.getByTestId('okf-hot-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-path')));
      await expect(header('tokens')).toHaveAttribute('aria-sort', 'descending');
      await expect(header('cost')).toHaveAttribute('aria-sort', 'none');
      await expect(header('units')).toContainText('Sessions');
      await expect.poll(shownPaths).toEqual(byTokens);
      expect(byTokens.some((p) => p.endsWith('/index.md')), 'no index file among the hot files').toBe(false);
      await expect(table.getByTestId('okf-hot-show-all'), 'four files: nothing to show more of').toHaveCount(0);
      await expect(table.getByTestId('okf-hot-index-line')).toHaveText(
        /^1 index file is not listed: ≈ 0\.3K tokens, ≈ (\$\d+\.\d\d|< \$0\.01|—) — see the explorer$/,
      );

      // A file's sessions and ≈ tokens are the same in the table and in the explorer.
      const cells = hotRow(page, readMd).locator('td');
      await expect(cells.nth(1)).toHaveText('2');
      await expect(cells.nth(2)).toHaveText('2');
      await expect(cells.nth(3)).toHaveText('0.8K');
      await toggleRow(treeRow(page, 'bundle', clean));
      const explorerCells = treeRow(page, 'file', readMd).locator('> span');
      await expect(explorerCells.nth(2), 'sessions').toHaveText('2');
      await expect(explorerCells.nth(3), '≈ tokens').toHaveText('0.8K');

      await page.getByTestId('okf-hot-sort-cost').click();
      await expect(header('cost')).toHaveAttribute('aria-sort', 'descending');
      await expect(header('tokens')).toHaveAttribute('aria-sort', 'none');
      await expect.poll(shownPaths).toEqual(order((f) => f.cost ?? -1));
      await page.getByTestId('okf-hot-sort-cost').click();
      await expect(header('cost'), 'a second click flips the direction').toHaveAttribute('aria-sort', 'ascending');

      await table.getByTestId('okf-tip-cost').hover();
      const tip = page.getByRole('tooltip').first();
      await expect(tip).toContainText(OKF_COST_TIP);
      await expect(tip).toContainText(
        usage.summary.readsWithoutCost > 0
          ? `${usage.summary.readsWithoutCost} reads have no cost (their agent has no computed cost).`
          : 'All reads in this period have a cost.',
      );
    } finally {
      await context.close();
    }
  });

  await test.step('14. OKF v0.3 front matter (2026-11-19): the Versions row of an older bundle, the five Wrong-format groups, no dot-path file, the 1600×1000 fit; recompute after the extract-version bump', async () => {
    const v03 = `docs/v03-${run}`;
    const fm = { frontMatter: true, hasGenerated: true, hasTimestamp: false };
    const noFm = { frontMatter: false, hasGenerated: false, hasTimestamp: false };
    const sid = okfSid('v03');
    const key = await createApiKey(owner.api);
    await uploadOkfSessionTree(
      api,
      key.key,
      {
        sessionId: sid,
        repoUrl,
        prompt: `okf v03 ${run}`,
        snapshot: {
          bundles: [
            {
              root: v03,
              okfVersion: '0.1',
              title: 'Release notes',
              files: [
                { path: `${v03}/index.md`, meta: { ...fm, type: 'Index' } },
                { path: `${v03}/legacy.md`, meta: { ...fm, type: 'Article', status: 'deprecated', superseded_by: '/current.md' } },
                { path: `${v03}/current.md`, meta: { ...fm, type: 'Article', stale_after: '2000-01-01T00:00:00Z' } },
                // v0.1 `timestamp` instead of `generated`, and no `type`.
                { path: `${v03}/v01.md`, meta: { frontMatter: true, hasGenerated: false, hasTimestamp: true } },
                { path: `${v03}/plain.md`, meta: noFm },
                { path: `${v03}/log.md`, meta: noFm },
                { path: `${v03}/nested/index.md`, meta: noFm },
                { path: `${v03}/.drafts/wip.md`, meta: noFm },
              ],
            },
          ],
        },
        actions: [{ read: `${v03}/index.md` }, { read: `${v03}/legacy.md` }],
      },
      { db, userId: owner.id },
    );

    // The repo route takes the newest snapshot on main: this tree's bundle.
    const usage = await repoOkf(owner, {});
    expect(usage.bundleRoots).toEqual([v03]);
    expect(usage.currentFormat).toBe('0.3');
    expect(usage.versions, 'seven files — the dot-path file is not part of the KB').toEqual([
      { root: v03, files: 7, okfVersion: '0.1', older: true, ignored: false },
    ]);
    // `/current.md` is relative to the bundle root. index.md, log.md and nested/index.md are
    // index files: not checked.
    expect(usage.format).toEqual({
      articles: 4,
      indexFiles: 3,
      withProblems: 4,
      groups: [
        { problem: 'no_front_matter', files: [{ path: `${v03}/plain.md` }] },
        { problem: 'no_type', files: [{ path: `${v03}/v01.md` }] },
        { problem: 'v01_timestamp', files: [{ path: `${v03}/v01.md` }] },
        { problem: 'deprecated', files: [{ path: `${v03}/legacy.md`, supersededBy: `${v03}/current.md` }] },
        { problem: 'past_stale_after', files: [{ path: `${v03}/current.md` }] },
      ],
    });
    expect(JSON.stringify(usage)).not.toContain('wip.md');
    expect(usage.summary, 'only this tree read the reference snapshot’s bundle').toMatchObject({ unitsRead: 1, unitsTotal: 5, reads: 2 });
    expectOkfSums(usage, 'v03');

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf`);
    try {
      // A bundle behind the current format: Versions starts expanded.
      const versions = page.getByTestId('okf-versions');
      await expect(versions).toHaveAttribute('data-collapsed', 'false');
      await expect(versions).toContainText('1 KB folder, 1 older than the current format 0.3');
      const versionRow = page.locator(`[data-testid="okf-version-row"][data-root="${v03}"]`);
      await expect(versionRow).toContainText('7 files');
      await expect(versionRow).toContainText('0.1');
      await expect(versionRow.getByTestId('okf-version-older')).toHaveText('older than the current format 0.3');

      const format = page.getByTestId('okf-format');
      await expect(format).toContainText('Wrong format — 4 of 4 articles');
      await expect(format.getByTestId('okf-format-ok')).toHaveCount(0);
      const group = (problem: string) => format.locator(`[data-testid="okf-format-group"][data-problem="${problem}"]`);
      for (const [problem, title] of [
        ['no_front_matter', 'No front matter'],
        ['no_type', 'No "type" in the front matter'],
        ['v01_timestamp', 'Old "timestamp" key (format 0.1)'],
        ['deprecated', 'Deprecated'],
        ['past_stale_after', 'Past its "stale after" date'],
      ]) {
        const spans = group(problem).locator('button > span');
        await expect(spans.first(), problem).toHaveText(title);
        await expect(spans.last(), `${problem}: one article`).toHaveText('1');
      }
      await expect(format.getByTestId('okf-format-group')).toHaveCount(5);
      await group('deprecated').getByRole('button').click();
      await expect(group('deprecated').getByTestId('okf-format-file')).toHaveText(`${v03}/legacy.md → replaced by ${v03}/current.md`);
      await group('deprecated').getByRole('button').click();

      // Index files are in the explorer, never among the hot files.
      await expect(page.getByTestId('okf-hot-row')).toHaveCount(1);
      await expect(hotRow(page, `${v03}/legacy.md`)).toHaveCount(1);
      await expect(page.getByTestId('okf-hot-index-line')).toContainText('1 index file is not listed');
      await toggleRow(treeRow(page, 'bundle', v03));
      await expect(treeRow(page, 'file', `${v03}/log.md`)).toHaveAttribute('data-opened', 'false');
      await expect(treeRow(page, 'folder', `${v03}/nested/`)).toContainText('0 of 1');
      await expect(page.getByTestId('repo-okf-tab')).not.toContainText('wip.md');
      for (const id of REMOVED_OKF_IDS) await expect(page.getByTestId(id), `${id} is gone`).toHaveCount(0);
      await expectOkfTreeFits(page);
      await expectOkfViewFits(page);
    } finally {
      await context.close();
    }

    // Recompute after the extract-version bump: a session stamped by the previous extractor (3)
    // carries the current version (5) once recomputed.
    await db.query('UPDATE sessions SET okf_extract_version = 3 WHERE session_id = $1', [sid]);
    expect((await owner.api.post(`/api/v1/repositories/${repoOf(owner)}/recompute-all-sessions`)).status()).toBe(201);
    const after = await db.query<{ v: number | null }>('SELECT okf_extract_version AS v FROM sessions WHERE session_id = $1', [sid]);
    expect(after.rows[0].v).toBe(5);
    expect((await repoOkf(owner, {})).summary, 'the recompute keeps the reads').toMatchObject({ unitsRead: 1, reads: 2 });
  });
});
