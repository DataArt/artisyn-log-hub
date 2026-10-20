/**
 * tour-kit.ts — walks the rows of `screen-registry.ts` for one story (impl-plan DD G5,
 * `docs/qaa-overview/scenarios/06-ui-tab-walk.md` §2.2).
 *
 * `new TourWalker({ story, mode, params })` then `walker.screen(page, rowId, how?)` per row and
 * `walker.finish()` at the end. Every screen gets, inside its own `test.step(row.id)`:
 *
 *   1. navigation: `page.goto` of the row's hash, or the story's own click path (`how.go`);
 *   2. the anchor: `expectUrl`, `expectTestId`, `expectSelector`, `expectText` (all that are set),
 *      the active tab trigger of `row.tab`, and none of `forbidText`; a `dataOptional` row may show
 *      its `emptyText` instead of the anchor; then the story's own extra checks (`how.check`);
 *   3. the 06 §2.2 checks: no React error screen in `body`, no `pageerror`, no `console.error`
 *      outside the allowlist, no `/api/*` answer ≥ 400 outside the row's `expectedNetwork`.
 *
 * A failing screen does not stop the story (06 §2.2, «режим ошибок»): failures are collected and
 * `finish()` fails once with the list, so one broken screen does not hide the other ninety.
 * `finish()` also fails when a row of the story (for this mode) was never walked — so a row added
 * to the registry needs a walk, and a walk cannot silently skip a row.
 */
import { expect, test, type ConsoleMessage, type Locator, type Page, type Request, type Response } from '@playwright/test';
import { rowById, rowsFor, type ExpectedResponse, type RegistryMode, type ScreenRow, type TourId } from './screen-registry';

export type TourParams = Record<string, string | number>;

export interface ScreenHow {
  /** Custom navigation (a click path) instead of `page.goto(hashFor(row))`. Receives the hash. */
  go?: (hash: string) => Promise<void>;
  /** Extra checks after the anchor, still inside the screen's step. */
  check?: () => Promise<void>;
}

/** Texts of a React error screen / crash (06 §2.2 p.1). */
const CRASH_TEXT = /Unexpected Application Error|Something went wrong|Cannot read properties/;

/**
 * console.error lines every screen may print (06 §2.2 p.3), each with its reason:
 *   - «Failed to load resource: … status of N» — Chromium's own log line for a fetch that got an
 *     HTTP error. The response itself is judged by the network check (p.4) against the row's
 *     `expectedNetwork`, so the duplicate console line carries no extra signal.
 */
const CONSOLE_ALLOWLIST: RegExp[] = [/^Failed to load resource: the server responded with a status of \d+/];

/**
 * `/api/*` answers ≥ 400 every screen of a role may cause (06 §2.2 p.4), each with its reason:
 *   - anonymous: the app's bootstrap asks `GET /auth/me` and gets 401 before it routes to login.
 */
const ROLE_NETWORK: Partial<Record<ScreenRow['role'], ExpectedResponse[]>> = {
  anon: [{ url: '/api/v1/auth/me$', status: 401 }],
};

/** Fills `{name}` placeholders; a missing param is a bug of the story, not of the app. */
export function fill(template: string, params: TourParams): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_whole, name: string) => {
    if (!(name in params)) throw new Error(`tour param "${name}" is not set (template "${template}")`);
    return String(params[name]);
  });
}

/** `/#/<path><query>` of a row: route params from `params`, `{name}` placeholders filled. */
export function hashFor(row: ScreenRow, params: TourParams): string {
  const pattern = row.path ?? row.route;
  const path = pattern.replace(/:([A-Za-z]+)/g, (_whole, name: string) => {
    if (!(name in params)) throw new Error(`tour param "${name}" is not set (route ${row.route} of ${row.id})`);
    return encodeURIComponent(String(params[name]));
  });
  return `/#${path}${row.query ? fill(row.query, params) : ''}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface PageBuffers {
  pageErrors: string[];
  consoleErrors: string[];
  apiFailures: Array<{ url: string; status: number }>;
  /** `/api/*` requests sent and not finished yet. */
  inflight: number;
}

const isApi = (url: string) => /\/api\//.test(url);

/**
 * Waits until no `/api/*` request has been in flight for `quietMs` (at most `maxMs`), so a screen's
 * late answers are judged on that screen. `waitForLoadState('networkidle')` cannot do this: after
 * a same-document (hash) navigation the page is still «networkidle» from its first load.
 */
async function settle(buf: PageBuffers, quietMs = 300, maxMs = 5_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let quietSince = buf.inflight === 0 ? Date.now() : 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (buf.inflight > 0) quietSince = 0;
    else if (quietSince === 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return;
  }
}

export interface TourWalkerOptions {
  story: TourId;
  mode: RegistryMode;
  params: TourParams;
}

export class TourWalker {
  readonly story: TourId;
  readonly mode: RegistryMode;
  params: TourParams;
  private readonly buffers = new Map<Page, PageBuffers>();
  private readonly visited = new Set<string>();
  private readonly failures: string[] = [];

  constructor({ story, mode, params }: TourWalkerOptions) {
    this.story = story;
    this.mode = mode;
    this.params = params;
  }

  /** The rows of this story in this mode. */
  rows(): ScreenRow[] {
    return rowsFor(this.story, this.mode);
  }

  /** The registry row, checked to belong to this story and mode. */
  row(id: string): ScreenRow {
    const row = rowById(id);
    if (row.story !== this.story) throw new Error(`row ${id} belongs to ${row.story}, not ${this.story}`);
    if (!row.modes.includes(this.mode)) throw new Error(`row ${id} does not run in mode ${this.mode}`);
    return row;
  }

  hash(id: string): string {
    return hashFor(this.row(id), this.params);
  }

  private watch(page: Page): PageBuffers {
    const existing = this.buffers.get(page);
    if (existing) return existing;
    const buf: PageBuffers = { pageErrors: [], consoleErrors: [], apiFailures: [], inflight: 0 };
    page.on('pageerror', (err: Error) => buf.pageErrors.push(err.message));
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') buf.consoleErrors.push(msg.text());
    });
    page.on('request', (req: Request) => {
      if (isApi(req.url())) buf.inflight += 1;
    });
    const done = (req: Request) => {
      if (isApi(req.url())) buf.inflight = Math.max(0, buf.inflight - 1);
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    page.on('response', (res: Response) => {
      const url = res.url();
      if (res.status() >= 400 && isApi(url)) buf.apiFailures.push({ url, status: res.status() });
    });
    this.buffers.set(page, buf);
    return buf;
  }

  /** Starts listening on `page` before its first navigation (call it right after creating a page). */
  attach(page: Page): void {
    this.watch(page);
  }

  /** Walks one screen; a failure is recorded, not thrown (see the module comment). */
  async screen(page: Page, id: string, how: ScreenHow = {}): Promise<void> {
    const row = this.row(id);
    if (this.visited.has(id)) throw new Error(`row ${id} walked twice`);
    this.visited.add(id);
    const buf = this.watch(page);
    try {
      await test.step(`${row.id} — ${row.title}`, async () => {
        buf.pageErrors.length = 0;
        buf.consoleErrors.length = 0;
        buf.apiFailures.length = 0;
        const hash = hashFor(row, this.params);
        if (how.go) await how.go(hash);
        else await page.goto(hash);
        await this.expectAnchor(page, row);
        if (how.check) await how.check();
        await settle(buf);
        this.expectHealthy(page, row, buf, await page.locator('body').innerText());
      });
    } catch (err) {
      // eslint-disable-next-line no-control-regex
      const message = (err instanceof Error ? err.message : String(err)).replace(/\u001b\[[0-9;]*m/g, '');
      const lines = message.split('\n').filter((l) => l.trim() !== '');
      // What the screen showed instead: the URL and the start of the visible text.
      const seen = page.isClosed()
        ? '(page closed)'
        : `${page.url()} | ${(await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')).replace(/\s+/g, ' ').slice(0, 1200)}`;
      this.failures.push(`${row.id}: ${lines.slice(0, 14).join('\n    ')}\n    seen: ${seen}`);
    }
  }

  /** Marks rows this mode has but the walk cannot reach, with the reason (an annotation, not a pass). */
  skip(id: string, reason: string): void {
    this.row(id);
    this.visited.add(id);
    test.info().annotations.push({ type: 'skip-screen', description: `${id}: ${reason}` });
  }

  /** Fails with every broken screen, and when a row of the story was never walked. */
  finish(): void {
    const missing = this.rows()
      .map((r) => r.id)
      .filter((id) => !this.visited.has(id));
    const problems = [...this.failures];
    if (missing.length > 0) problems.push(`rows of ${this.story} never walked in mode ${this.mode}: ${missing.join(', ')}`);
    expect(problems, `${this.story}: ${problems.length} broken screen(s)`).toEqual([]);
  }

  private async expectAnchor(page: Page, row: ScreenRow): Promise<void> {
    const p = this.params;
    if (row.expectUrl) await expect(page).toHaveURL(new RegExp(fill(row.expectUrl, p)), { timeout: 15_000 });

    const anchors: Array<[string, Locator]> = [];
    if (row.expectTestId) anchors.push([`testid ${row.expectTestId}`, page.getByTestId(row.expectTestId)]);
    if (row.expectSelector) anchors.push([`selector ${row.expectSelector}`, page.locator(row.expectSelector)]);
    if (row.expectText) {
      const text = fill(row.expectText, p);
      anchors.push([`text «${text}»`, page.getByText(text)]);
    }
    const empty = row.dataOptional && row.emptyText ? page.getByText(row.emptyText) : null;
    for (const [what, locator] of anchors) {
      const visible = locator.filter({ visible: true }).first();
      if (empty) {
        await expect(visible.or(empty.filter({ visible: true })).first(), `${what} or «${row.emptyText}»`).toBeVisible({
          timeout: 20_000,
        });
      } else {
        await expect(visible, what).toBeVisible({ timeout: 20_000 });
      }
    }

    if (row.tab && row.tab.group !== 'session' && !row.negative) {
      const trigger = page.getByTestId(`tab-${row.tab.group}-${row.tab.id}`);
      await expect(trigger, `tab trigger ${row.tab.group}/${row.tab.id} is active`).toHaveAttribute('data-state', 'active');
    }
    if (row.tab?.group === 'session' && !row.negative && row.tab.id !== 'summary') {
      await expect(page, `session tab ${row.tab.id} in the URL`).toHaveURL(new RegExp(`[?&]tab=${escapeRe(row.tab.id)}(&|$)`));
    }
    for (const t of row.forbidText ?? []) {
      await expect(page.locator('body'), `must not show «${fill(t, p)}»`).not.toContainText(fill(t, p));
    }
  }

  private expectHealthy(page: Page, row: ScreenRow, buf: PageBuffers, bodyText: string): void {
    const crash = CRASH_TEXT.exec(bodyText);
    expect(crash?.[0], `error screen in body on ${page.url()}`).toBeUndefined();
    expect(buf.pageErrors, 'uncaught page errors').toEqual([]);
    const console = buf.consoleErrors.filter((m) => !CONSOLE_ALLOWLIST.some((re) => re.test(m)));
    expect(console, 'console.error outside the allowlist').toEqual([]);
    const allowed = [...(ROLE_NETWORK[row.role] ?? []), ...(row.expectedNetwork ?? [])];
    const unexpected = buf.apiFailures.filter(
      (f) => !allowed.some((a) => a.status === f.status && new RegExp(a.url).test(f.url.split('?')[0])),
    );
    expect(unexpected, 'API answers ≥ 400 outside expectedNetwork').toEqual([]);
  }
}

/**
 * Runtime layer of the meta-test (06 §2.4, layer B): the tab triggers of `group` rendered on
 * `page` must be exactly the ids `expected` (the story's registry rows for that group, minus
 * the ones hidden for this role / data). Compares `data-testid="tab-<group>-<id>"`.
 */
export async function expectTabsOnScreen(page: Page, group: string, expected: readonly string[]): Promise<void> {
  const prefix = `tab-${group}-`;
  const triggers = page.locator(`[data-testid^="${prefix}"]`);
  await expect(triggers.first()).toBeVisible({ timeout: 15_000 });
  const ids = (await triggers.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))).map((t) =>
    t.slice(prefix.length),
  );
  expect([...ids].sort(), `tab triggers of group ${group} vs the registry`).toEqual([...expected].sort());
}

/** Ids of the story's rows that open a tab of `group` (registry order). */
export function registryTabIds(walker: TourWalker, group: string): string[] {
  return walker
    .rows()
    .filter((r) => r.tab?.group === group && !r.negative)
    .map((r) => r.tab!.id);
}
