/**
 * The session view's "Change surface" tab, in a real browser.
 *
 * Everything here is what the node-environment client unit tests cannot reach: the tree's
 * toolbar interactions in a real DOM. The unit tests render the tree through
 * `renderToStaticMarkup` and cannot click anything — so expand/collapse-all, the
 * single-child-collapse checkbox, the path filter, the sort switch and the full render of a
 * several-hundred-file tree only exist here.
 *
 * The fixture is a genuinely large session: ~390 distinct changed paths across 16 modules, plus
 * three deliberately shaped corners that make each assertion deterministic rather than
 * incidental —
 *
 *   - `alpha/`      sorts first by PATH and has a tiny churn, so it can never win the LINES sort;
 *   - `zulu/`       has by far the largest churn, so it always wins the LINES sort and can never
 *                   win the PATH one — switching the select therefore has to change the first
 *                   child row, which is the only thing that proves the control is wired;
 *   - `deepchain/`  is a single-child folder chain, the exact shape the "Collapse single-child"
 *                   checkbox merges into one label;
 *   - `filterbucket/wombat-*.ts` are the only paths containing "wombat", so the filter's effect
 *                   is an exact count, not a "fewer than before".
 *
 * Row identity is read off the rendered label spans in DOM order (`rowLabels()`). The tree
 * renders every visible row unconditionally — there is deliberately no inner scroll container
 * (a nested scroller produced a "scroll in a scroll"; scrolling the tree is scrolling the page),
 * so "the rows in the DOM" IS the tree as the toolbar state currently shapes it.
 */
import {
  test,
  expect,
  request as pwRequest,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import * as crypto from 'crypto';
import { BASE_URL, storageStatePath } from './helpers/credentials';
import { seedRepoWithSessions, type SeededRepo } from './helpers/seed';

test.use({ storageState: storageStatePath('primary') });

const MODEL = 'claude-sonnet-4-6';
const LIST_LABEL = 'e2e: change surface tab session';

/** The repo root the hook would have uploaded as `git.root`; every path below is under it. */
const REPO_ROOT = `/e2e/change-surface-${crypto.randomUUID().slice(0, 8)}`;

/** Modules × sub-folders × files — the bulk of the tree, and what makes it scroll. */
const MODULE_COUNT = 16;
const SUBFOLDER_COUNT = 4;
const FILES_PER_SUBFOLDER = 6;
const BULK_FILES = MODULE_COUNT * SUBFOLDER_COUNT * FILES_PER_SUBFOLDER;

/** The single-child chain the collapse checkbox merges. */
const CHAIN_SEGMENTS = ['deepchain', 'only', 'inner', 'leafdir'];
const CHAIN_LABEL = CHAIN_SEGMENTS.join('/');
const CHAIN_FILE = `${CHAIN_LABEL}/deep-file.ts`;

/** The only paths containing "wombat". */
const FILTER_TOKEN = 'wombat';
const FILTER_FILES = [
  'filterbucket/wombat-one.ts',
  'filterbucket/wombat-two.ts',
  'filterbucket/wombat-three.ts',
];

interface FixtureFile {
  relPath: string;
  added: number;
}

/** Every changed path this session reports, in the order the transcript touches them. */
function fixtureFiles(): FixtureFile[] {
  const files: FixtureFile[] = [];
  for (let m = 0; m < MODULE_COUNT; m++) {
    const module = `mod${String(m).padStart(2, '0')}`;
    for (let s = 0; s < SUBFOLDER_COUNT; s++) {
      for (let i = 0; i < FILES_PER_SUBFOLDER; i++) {
        files.push({ relPath: `${module}/sub${s}/file-${i}.ts`, added: 3 });
      }
    }
  }
  // Alphabetically first top-level folder, deliberately tiny.
  files.push({ relPath: 'alpha/a-one.ts', added: 1 });
  files.push({ relPath: 'alpha/a-two.ts', added: 1 });
  // Alphabetically last top-level folder, deliberately enormous.
  files.push({ relPath: 'zulu/z-one.ts', added: 400 });
  files.push({ relPath: 'zulu/z-two.ts', added: 400 });
  files.push({ relPath: CHAIN_FILE, added: 2 });
  for (const relPath of FILTER_FILES) files.push({ relPath, added: 2 });
  return files;
}

const FILES = fixtureFiles();
const TOTAL_FILES = FILES.length;

/** `structuredPatch` hunk lines, as the CLI writes them — the diff-covered `+` source. */
function patchLines(added: number): string[] {
  return ['   context', ...Array.from({ length: added }, (_u, i) => `+line-${i}`)];
}

/**
 * A `claude` transcript that edits every fixture path exactly once.
 *
 * Tool calls are spread over several assistant messages rather than crammed into one, so the
 * transcript looks like a real session and each message carries its own unique `message.id`
 * (usage is deduped on that id — one giant message would be a fixture that no real run
 * produces).
 */
function buildTranscript(sessionId: string): Record<string, unknown>[] {
  const ts = '2026-04-06T09:05:00.000Z';
  const userUuid = `${sessionId}-u1`;
  const events: Record<string, unknown>[] = [
    {
      type: 'user',
      uuid: userUuid,
      promptId: `${sessionId}-p1`,
      sessionId,
      isMeta: false,
      isSidechain: false,
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: LIST_LABEL }] },
    },
  ];

  const BATCH = 40;
  for (let start = 0; start < FILES.length; start += BATCH) {
    const batch = FILES.slice(start, start + BATCH);
    const batchIndex = start / BATCH;
    const asstUuid = `${sessionId}-a${batchIndex}`;
    events.push({
      type: 'assistant',
      uuid: asstUuid,
      parentUuid: userUuid,
      sessionId,
      isSidechain: false,
      timestamp: ts,
      message: {
        id: `${sessionId}-m${batchIndex}`,
        role: 'assistant',
        model: MODEL,
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: batch.map((file, i) => ({
          type: 'tool_use',
          id: `${sessionId}-t${start + i}`,
          name: 'Edit',
          input: {
            file_path: `${REPO_ROOT}/${file.relPath}`,
            old_string: 'old',
            new_string: 'new',
          },
        })),
      },
    });

    batch.forEach((file, i) => {
      events.push({
        type: 'user',
        uuid: `${sessionId}-r${start + i}`,
        promptId: `${sessionId}-p1`,
        sessionId,
        isMeta: false,
        isSidechain: false,
        timestamp: ts,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: `${sessionId}-t${start + i}`,
              content: 'ok',
            },
          ],
        },
        toolUseResult: {
          structuredPatch: [{ lines: patchLines(file.added) }],
        },
      });
    });
  }

  return events;
}

let seeded: SeededRepo;
let ownerCtx: APIRequestContext;
let repoId: number;
let sessionId: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  ownerCtx = await pwRequest.newContext({ baseURL: BASE_URL });
  const idSuffix = crypto.randomUUID().slice(0, 8);
  sessionId = `change-surface-tab-${idSuffix}`;

  seeded = await seedRepoWithSessions(ownerCtx, {
    role: 'primary',
    specSlug: `change-surface-tab-${idSuffix}`,
    sessions: [
      {
        sessionId,
        firstPrompt: LIST_LABEL,
        branch: 'e2e',
        daysAgo: 0,
        // The hook's `git.root` — without it no path can be normalised into the repo and
        // every surface renders "no change-surface data" instead of a tree.
        artisynEvents: [
          {
            git: { root: REPO_ROOT },
            event: 'test',
            timestamp: new Date().toISOString(),
          },
        ],
        claudeEvents: buildTranscript(sessionId),
      },
    ],
  });
  repoId = seeded.repoId;
});

test.afterAll(async () => {
  try {
    await seeded?.cleanup();
  } finally {
    await ownerCtx?.dispose();
  }
});

const tree = (page: Page) =>
  page.locator('[data-testid="change-surface-file-tree"]');
const summary = (page: Page) => tree(page).locator('span.font-mono').first();
/** Row label spans: `truncate font-mono` is unique to row labels (the toolbar summary is not `truncate`). */
const rowLabelSpans = (page: Page) =>
  tree(page).locator('span.truncate.font-mono');

/** The labels of every rendered row, in render order — the tree renders all rows, no windowing. */
async function rowLabels(page: Page): Promise<string[]> {
  return rowLabelSpans(page).evaluateAll((els) =>
    els.map((el) => (el.textContent ?? '').trim()),
  );
}

async function openTab(page: Page) {
  await page.goto(`/#/repos/${repoId}?session=${sessionId}&tab=change-surface`);
  await expect(page.locator('[data-testid="change-surface-tab"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(tree(page)).toBeVisible({ timeout: 20_000 });
  // The tree is populated (the root row exists) before any interaction is attempted.
  await expect(tree(page).getByText('. (repo root)')).toBeVisible({
    timeout: 20_000,
  });
}

test.describe('Change surface tab — the file tree toolbar', () => {
  test('@core expand/collapse all, the single-child checkbox, the path filter and the sort switch each change the rendered tree', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openTab(page);

    // The whole session is present: the header summary is the tree's own count, and it is the
    // several-hundred-file fixture, not a truncated slice of it.
    await expect(summary(page)).toHaveText(
      new RegExp(`^${TOTAL_FILES} files · \\d+ folders · \\d+ modules$`),
    );

    // ── Collapse all ────────────────────────────────────────────────────────
    // The root is itself a collapsible folder, so collapsing everything leaves exactly one row.
    await tree(page).getByRole('button', { name: 'Collapse all' }).click();
    await expect
      .poll(async () => (await rowLabels(page)).length)
      .toBe(1);
    expect(await rowLabels(page)).toEqual(['. (repo root)']);
    // Its chevron now offers to expand, which is the state the click actually set.
    // `exact` matters: without it this would also match the "Expand all" toolbar button.
    await expect(
      tree(page).getByRole('button', { name: 'Expand', exact: true }),
    ).toHaveCount(1);

    // ── Expand all ──────────────────────────────────────────────────────────
    await tree(page).getByRole('button', { name: 'Expand all' }).click();
    await expect
      .poll(async () => (await rowLabels(page)).length)
      .toBeGreaterThan(10);

    // ── Path filter ─────────────────────────────────────────────────────────
    const filter = tree(page).getByLabel('Filter paths');
    await filter.fill(FILTER_TOKEN);
    // An exact count, not "fewer than before": only these three paths carry the token.
    await expect(summary(page)).toHaveText(
      `${FILTER_FILES.length} files · 1 folders · 1 modules`,
    );
    const filtered = await rowLabels(page);
    expect(filtered).toContain('filterbucket');
    expect(filtered.filter((l) => l.startsWith('wombat-'))).toHaveLength(
      FILTER_FILES.length,
    );

    // A filter that matches nothing gets its own message, never an empty tree that reads as
    // "this session changed nothing".
    await filter.fill('no-such-path-zzz');
    await expect(tree(page).getByText('No paths match this filter')).toBeVisible();
    await expect(rowLabelSpans(page)).toHaveCount(0);

    await filter.fill('');
    await expect(summary(page)).toHaveText(
      new RegExp(`^${TOTAL_FILES} files · `),
    );

    // ── Collapse single-child ───────────────────────────────────────────────
    // Scoped to the chain via the filter so the assertion is about the chain, not about
    // whichever rows the window happens to hold.
    await filter.fill('deepchain');
    const checkbox = tree(page).locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked(); // on by default
    await expect.poll(async () => await rowLabels(page)).toContain(CHAIN_LABEL);

    await checkbox.uncheck();
    await expect
      .poll(async () => await rowLabels(page))
      .toEqual(['. (repo root)', ...CHAIN_SEGMENTS, 'deep-file.ts']);

    await checkbox.check();
    await expect
      .poll(async () => await rowLabels(page))
      .toEqual(['. (repo root)', CHAIN_LABEL, 'deep-file.ts']);

    await filter.fill('');

    // ── Sort switch ─────────────────────────────────────────────────────────
    // `lines` (the default) ranks by churn: `zulu` is the largest by an order of magnitude.
    await expect
      .poll(async () => (await rowLabels(page))[1])
      .toBe('zulu');

    // `path` ranks alphabetically: `alpha` is first and `zulu` cannot be.
    await tree(page).getByLabel('Sort tree').selectOption('path');
    await expect
      .poll(async () => (await rowLabels(page))[1])
      .toBe('alpha');

    await tree(page).getByLabel('Sort tree').selectOption('lines');
    await expect
      .poll(async () => (await rowLabels(page))[1])
      .toBe('zulu');
  });
});

test.describe('Change surface tab — full render, no inner scroller', () => {
  test('a several-hundred-file tree renders every expanded row with no nested scroll container', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openTab(page);

    // The design decision: no scroll container inside the tree — a fixed-height virtualised
    // viewport nested in the page's own scroll produced a "scroll in a scroll", so scrolling
    // the tree is just scrolling the page.
    await expect(tree(page).locator('div.overflow-y-auto')).toHaveCount(0);

    const labels = await rowLabels(page);
    expect(labels[0]).toBe('. (repo root)');
    // Render everything, not a window: the DOM holds every expanded row of the ~470-row tree,
    // strictly more rows than the bulk fixture's leaf files alone.
    expect(labels.length).toBeGreaterThan(BULK_FILES);

    // And the rows are the real tree: every bulk leaf label is present exactly as flattened.
    expect(labels.filter((l) => l.startsWith('file-'))).toHaveLength(BULK_FILES);
  });
});
