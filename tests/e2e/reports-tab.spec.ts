import { test, expect, request as pwRequest, type Page, type APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import { BASE_URL, storageStatePath } from './helpers/credentials';
import { extractPdfText } from './helpers/pdf-text';
import { seedRepoWithSessions, type SeededRepo } from './helpers/seed';

// All tests run as the repo owner (`primary`) via saved storageState.
test.use({ storageState: storageStatePath('primary') });

let seeded: SeededRepo;
let ownerCtx: APIRequestContext;
let repoId: number;

async function navigateToReports(page: Page) {
  await page.goto(`/#/repos/${repoId}?mtab=reports`);
  await expect(page.getByRole('tab', { name: 'Reports' })).toBeVisible({
    timeout: 8_000,
  });
  await expect(
    page.getByRole('navigation', { name: 'Reports' }),
  ).toBeVisible({ timeout: 8_000 });
}

// The Change Surface report needs at least one session whose change surface was
// actually computed, which takes two things sessions A/B deliberately do not have: a repo root
// (`git.root`, uploaded by the hook) and Edit calls carrying a real diff. Without them the
// report renders its "No change-surface data for this period" empty state, which would make the
// title/body/PDF row below assert nothing about the report itself.
const CS_REPO_ROOT = `/e2e/reports-tab-cs-${crypto.randomUUID().slice(0, 8)}`;
const CS_SESSION_ID = `reports-tab-cs-${crypto.randomUUID().slice(0, 8)}`;
const CS_FILES = [
  'src/app/main.ts',
  'src/app/router.ts',
  'src/lib/format.ts',
  'docs/readme.md',
];

/** `structuredPatch` hunk lines, as the CLI writes them. */
function csPatchLines(added: number, removed: number): string[] {
  return [
    '   context',
    ...Array.from({ length: added }, (_u, i) => `+added-${i}`),
    ...Array.from({ length: removed }, (_u, i) => `-removed-${i}`),
  ];
}

function buildChangeSurfaceEvents(sid: string): Record<string, unknown>[] {
  const ts = new Date().toISOString();
  const userUuid = `${sid}-u1`;
  const events: Record<string, unknown>[] = [
    {
      type: 'user',
      uuid: userUuid,
      promptId: `${sid}-p1`,
      sessionId: sid,
      isMeta: false,
      isSidechain: false,
      timestamp: ts,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Reports tab e2e change-surface session' }],
      },
    },
    {
      type: 'assistant',
      uuid: `${sid}-a1`,
      parentUuid: userUuid,
      sessionId: sid,
      isSidechain: false,
      timestamp: ts,
      message: {
        id: `${sid}-m1`,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: CS_FILES.map((relPath, i) => ({
          type: 'tool_use',
          id: `${sid}-t${i}`,
          name: 'Edit',
          input: {
            file_path: `${CS_REPO_ROOT}/${relPath}`,
            old_string: 'old',
            new_string: 'new',
          },
        })),
      },
    },
  ];
  CS_FILES.forEach((_relPath, i) => {
    events.push({
      type: 'user',
      uuid: `${sid}-r${i}`,
      promptId: `${sid}-p1`,
      sessionId: sid,
      isMeta: false,
      isSidechain: false,
      timestamp: ts,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: `${sid}-t${i}`, content: 'ok' },
        ],
      },
      toolUseResult: { structuredPatch: [{ lines: csPatchLines(4, 2) }] },
    });
  });
  return events;
}

test.beforeAll(async () => {
  ownerCtx = await pwRequest.newContext({ baseURL: BASE_URL });
  seeded = await seedRepoWithSessions(ownerCtx, {
    role: 'primary',
    specSlug: 'reports-tab',
    sessions: [
      {
        firstPrompt: 'Reports tab e2e session A',
        branch: 'main',
        daysAgo: 0,
        autonomousWorkTimeMs: 3_600_000,
        // A claude log is required: sessions/branches (and every branches-
        // derived report) only counts sessions that have a matching claude log.
        toolCalls: [{ name: 'Read', filePath: 'src/index.ts' }],
      },
      {
        firstPrompt: 'Reports tab e2e session B',
        branch: 'feature/x',
        daysAgo: 1,
        autonomousWorkTimeMs: 1_800_000,
        toolCalls: [{ name: 'Read', filePath: 'src/index.ts' }],
      },
      {
        // The only session here with a computed change surface.
        sessionId: CS_SESSION_ID,
        firstPrompt: 'Reports tab e2e change-surface session',
        branch: 'main',
        daysAgo: 0,
        artisynEvents: [
          {
            git: { root: CS_REPO_ROOT },
            event: 'test',
            timestamp: new Date().toISOString(),
          },
        ],
        claudeEvents: buildChangeSurfaceEvents(CS_SESSION_ID),
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

test.describe('Reports tab — navigation and default report', () => {
  test('@core clicking Generate renders the Session Timeline document (KPI table + chart + PDF button)', async ({
    page,
  }) => {
    await navigateToReports(page);
    await page.getByText('Session Timeline').click();
    await page.getByRole('button', { name: 'Generate' }).click();

    await expect(page.getByRole('cell', { name: 'Total Sessions' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('svg').first()).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Download as PDF' }),
    ).toBeEnabled();
  });

  test('selecting a different report updates the URL and parameter strip', async ({
    page,
  }) => {
    await navigateToReports(page);
    await page.getByText('Branch Summary').click();

    await page.waitForFunction(
      () => window.location.hash.includes('report=branch-summary'),
      { timeout: 5_000 },
    );
  });
});

test.describe('Reports tab — each report renders as a document', () => {
  test('Branch Summary renders a KPI table and a sortable branch table after Generate', async ({
    page,
  }) => {
    await navigateToReports(page);
    await page.getByText('Branch Summary').click();
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.getByRole('cell', { name: 'Total Sessions' })).toBeVisible({
      timeout: 10_000,
    });
    const tables = page.locator('table');
    await expect(tables.last().locator('td', { hasText: 'main' })).toBeVisible();
  });

  test('Productivity renders a KPI table and chart after Generate', async ({
    page,
  }) => {
    await navigateToReports(page);
    // The "Productivity" category has a single report also named
    // "Productivity", so the category header and the report item both match
    // this text — `.last()` targets the leaf report button.
    await page.getByText('Productivity', { exact: true }).last().click();
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.getByText('Total Lines Changed')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('Avg Cost / Line')).toBeVisible();
  });
});

test.describe('Reports tab — left panel', () => {
  test('dragging the resize handle persists the new width in localStorage', async ({
    page,
  }) => {
    await navigateToReports(page);
    const before = await page.evaluate(() =>
      localStorage.getItem('artisyn:reportsTreeWidth'),
    );

    const handle = page.locator('div.cursor-col-resize');
    const box = await handle.boundingBox();
    if (!box) throw new Error('resize handle not found');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2);
    await page.mouse.up();

    const after = await page.evaluate(() =>
      localStorage.getItem('artisyn:reportsTreeWidth'),
    );
    expect(after).not.toBe(before);
  });
});

// ────────────────────────────────────────────────────────────
// The four usage reports, plus Change Surface
// ────────────────────────────────────────────────────────────

test.describe('Reports tab — usage reports + Change Surface', () => {
  const DOCUMENT_REPORTS: {
    title: string;
    expectText: string;
    pdfPrefix: string;
    /**
     * Asserted against the exported PDF's own text (helpers/pdf-text.ts) when present — the
     * on-page DOM proves the document rendered, this proves the same section survived the
     * `@react-pdf/renderer` export. Keep these patterns ASCII: the extractor decodes WinAnsi,
     * so an em dash or a `·` in the source does not come back as the same character.
     */
    pdfText?: RegExp[];
  }[] = [
    {
      title: 'Tool Analytics',
      expectText: 'Tools by call count',
      pdfPrefix: 'tool-analytics',
    },
    {
      title: 'Token Usage',
      expectText: 'By service tier',
      pdfPrefix: 'token-usage',
    },
    {
      title: 'Productivity Counters',
      // The KPI label — proves the diff-based figures are what this page reports.
      expectText: 'Lines added (diff-based)',
      pdfPrefix: 'productivity-counters',
    },
    {
      title: 'Active Sessions',
      expectText: 'Sessions by last activity',
      pdfPrefix: 'active-sessions',
    },
    {
      // Reports → Code → "Change Surface". The weekly-series heading is the one
      // section that exists on the page AND in the PDF, and it only renders at all when the
      // period has a computed change surface, so it doubles as proof the seeded session
      // (see CS_SESSION_ID above) was ingested and folded.
      title: 'Change Surface',
      expectText: 'Concentration per week',
      pdfPrefix: 'change-surface',
      pdfText: [/Change Surface/, /Concentration per week/],
    },
  ];

  for (const { title, expectText, pdfPrefix, pdfText } of DOCUMENT_REPORTS) {
    test(`@core ${title} renders its document and exports a PDF`, async ({
      page,
    }) => {
      await navigateToReports(page);
      await page
        .getByRole('navigation', { name: 'Reports' })
        .getByText(title, { exact: true })
        .click();
      await page.getByRole('button', { name: 'Generate' }).click();

      // The document header and at least one section render. `.first()` because a KPI label
      // and its table column header can carry the same text.
      await expect(page.getByText(expectText).first()).toBeVisible({
        timeout: 15_000,
      });

      const downloadButton = page.getByRole('button', {
        name: 'Download as PDF',
      });
      await expect(downloadButton).toBeEnabled({ timeout: 15_000 });

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        downloadButton.click(),
      ]);
      expect(download.suggestedFilename()).toContain(pdfPrefix);
      expect(download.suggestedFilename()).toMatch(/\.pdf$/);

      if (pdfText) {
        const pdfPath = await download.path();
        if (!pdfPath) throw new Error('PDF download produced no file on disk');
        const text = extractPdfText(pdfPath);
        for (const pattern of pdfText) expect(text).toMatch(pattern);
      }
    });
  }

  test('Productivity Counters never shows the written-lines figure alongside the diff-based ones', async ({
    page,
  }) => {
    await navigateToReports(page);
    await page
      .getByRole('navigation', { name: 'Reports' })
      .getByText('Productivity Counters', { exact: true })
      .click();
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.getByText('Lines added (diff-based)').first()).toBeVisible(
      { timeout: 15_000 },
    );

    // The no-same-page rule: the two line measures differ ~3x and must not be
    // presentable side by side.
    await expect(page.getByText('Lines changed (written)')).toHaveCount(0);
    await expect(page.getByText('Total Lines Changed')).toHaveCount(0);
  });
});
