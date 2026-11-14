// Shared fixtures of the Work Hub scenarios (plan D14). The stand is started by
// scripts/scenarios.mjs, which passes its coordinates in WH_STAND_* env vars; nothing here
// starts or stops a server.
//
//   stand         the stand's URL, control URL, mode, Docker instance and DB schema
//   api           an API client with its own cookie jar (one per test)
//   signIn()      a fresh user for the stand's mode: identify (a), signup (c),
//                 signup + Mailpit confirm + login (b)
//   docker*()     the Docker CLI (synchronous) for checks the UI cannot make
//   restartServer()  POST <control>/restart-server; returns when /health answers again
//   workspaceWithFakeLogin()  a workspace whose container holds the fake agent's credentials
//   fakeLoginInUi()           the same login through AgentLoginDialog and the login terminal
import { test as base, expect, request as pwRequest } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';

// ---------------------------------------------------------------------------------------------
// Stand

export type StandMode = 'a' | 'b' | 'c';

export interface Stand {
  url: string;
  controlUrl: string;
  mode: StandMode;
  instance: string;
  schema: string;
  databaseUrl: string;
  /** The server's WORK_HUB_DATA_DIR (the file area, FR-5g). */
  dataDir: string;
  mailpitUrl: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set: run the scenarios through "npm run test:scenarios -- --mode <a|b|c>"`);
  }
  return v;
}

/** The stand coordinates from scripts/scenarios.mjs. */
export function standFromEnv(): Stand {
  const mode = required('WH_STAND_MODE');
  if (mode !== 'a' && mode !== 'b' && mode !== 'c') throw new Error(`unknown WH_STAND_MODE "${mode}"`);
  return {
    url: required('WH_STAND_URL').replace(/\/+$/, ''),
    controlUrl: required('WH_STAND_CONTROL_URL').replace(/\/+$/, ''),
    mode,
    instance: required('WH_STAND_INSTANCE'),
    schema: required('WH_STAND_SCHEMA'),
    databaseUrl: required('WH_STAND_DATABASE_URL'),
    dataDir: required('WH_STAND_DATA_DIR'),
    mailpitUrl: (process.env.MAILPIT_URL || 'http://localhost:8025').replace(/\/+$/, ''),
  };
}

/** Stops and starts the stand's server (same port, env, schema and Docker instance). */
export async function restartServer(stand: Stand): Promise<void> {
  const res = await fetch(`${stand.controlUrl}/restart-server`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(`restart-server failed: ${body.error ?? res.status}`);
}

/** Runs `fn` with a DB client whose search_path is the stand's schema. */
export async function withDb<T>(stand: Stand, fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: stand.databaseUrl });
  await db.connect();
  try {
    await db.query(`SET search_path TO "${stand.schema}"`);
    return await fn(db);
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------------------------
// API client

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

/** Minimal shapes of the routes the helpers use (the full ones are in web/src/api). */
export interface UserProfile {
  id: number;
  email: string;
  role: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  workingBranch: string;
  openWorkstreams: number;
  agent: string;
  agentName: string;
  loginState: 'ok' | 'missing';
  loginAt: string | null;
  createdAt: string;
}

export interface WorkspaceDetail extends Workspace {
  branches: string[];
  configureActive: boolean;
  workstreams: { id: string; name: string; state: string }[];
}

/** An API client with its own cookie jar (Playwright's APIRequestContext keeps the cookies). */
export class WhApi {
  constructor(
    readonly ctx: APIRequestContext,
    readonly baseUrl: string,
  ) {}

  static async create(baseUrl: string): Promise<WhApi> {
    return new WhApi(await pwRequest.newContext({ baseURL: baseUrl, timeout: 300_000 }), baseUrl);
  }

  async call<T = unknown>(method: string, url: string, json?: unknown): Promise<ApiResult<T>> {
    const res = await this.ctx.fetch(url, {
      method,
      data: json === undefined ? undefined : json,
      headers: json === undefined ? undefined : { 'content-type': 'application/json' },
      failOnStatusCode: false,
    });
    const text = await res.text();
    let body: unknown = text;
    if ((res.headers()['content-type'] ?? '').includes('application/json') && text !== '') {
      body = JSON.parse(text);
    }
    return { status: res.status(), body: body as T, headers: res.headers() };
  }

  get<T = unknown>(url: string) {
    return this.call<T>('GET', url);
  }

  post<T = unknown>(url: string, json?: unknown) {
    return this.call<T>('POST', url, json ?? {});
  }

  patch<T = unknown>(url: string, json: unknown) {
    return this.call<T>('PATCH', url, json);
  }

  delete<T = unknown>(url: string) {
    return this.call<T>('DELETE', url);
  }

  /** The call must answer `status`; returns its body. */
  async expectStatus<T = unknown>(method: string, url: string, status: number, json?: unknown): Promise<T> {
    const r = await this.call<T>(method, url, json);
    if (r.status !== status) {
      throw new Error(`${method} ${url}: expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
    }
    return r.body;
  }

  /** The session cookies, for a browser context: `browser.newContext({ storageState })`. */
  storageState() {
    return this.ctx.storageState();
  }

  dispose() {
    return this.ctx.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Users per mode

export const EMAIL_DOMAIN = 'arrakis.test';
/** Passes the default `long` password policy. */
export const TEST_PASSWORD = 'Scenario-Pass-2026x';

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}@${EMAIL_DOMAIN}`;
}

interface MailpitSearch {
  messages: { ID: string }[];
}

/** The text of the newest Mailpit message to `email` (polls: SMTP delivery is asynchronous). */
export async function latestEmailText(stand: Stand, email: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const query = encodeURIComponent(`to:"${email}"`);
  while (Date.now() < deadline) {
    const search = await fetch(`${stand.mailpitUrl}/api/v1/search?query=${query}`);
    if (search.ok) {
      const found = (await search.json()) as MailpitSearch;
      if (found.messages.length > 0) {
        const msg = await fetch(`${stand.mailpitUrl}/api/v1/message/${found.messages[0].ID}`);
        if (msg.ok) return ((await msg.json()) as { Text: string }).Text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no Mailpit message to ${email} within ${timeoutMs} ms at ${stand.mailpitUrl}`);
}

/** The `token` of the first link containing `marker` (e.g. `#/confirm-email?token=`). */
export function tokenFromEmail(text: string, marker: string): string {
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    if (!m[0].includes(marker)) continue;
    const token = /token=([^\s&"'<>]+)/.exec(m[0]);
    if (token) return decodeURIComponent(token[1]);
  }
  throw new Error(`no link with "${marker}" in the email:\n${text}`);
}

/**
 * Signs `api` in as a new user of the stand's mode and returns its profile:
 * a → identify; c → signup (which signs in); b → signup, confirm through the Mailpit link, login.
 */
export async function signIn(stand: Stand, api: WhApi, email = uniqueEmail()): Promise<UserProfile> {
  if (stand.mode === 'a') {
    return api.expectStatus<UserProfile>('POST', '/api/v1/auth/identify', 200, { email });
  }
  const created = await api.expectStatus<UserProfile>('POST', '/api/v1/auth/signup', 201, {
    email,
    password: TEST_PASSWORD,
    passwordConfirm: TEST_PASSWORD,
  });
  // Mode c: signup already signs the user in.
  if (stand.mode === 'c') return created;
  const token = tokenFromEmail(await latestEmailText(stand, email), '#/confirm-email?token=');
  await api.expectStatus('POST', '/api/v1/auth/confirm-email', 200, { token });
  return api.expectStatus<UserProfile>('POST', '/api/v1/auth/login', 200, { email, password: TEST_PASSWORD });
}

// ---------------------------------------------------------------------------------------------
// Docker CLI

export interface DockerResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** `docker <args>`, never throwing. */
export function dockerTry(args: string[], input?: string): DockerResult {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 120_000 });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `docker <args>` → trimmed stdout; throws on a non-zero exit. */
export function docker(args: string[], input?: string): string {
  const r = dockerTry(args, input);
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} → exit ${r.status}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** `docker exec [-u user] [-w dir] <container> <argv…>` → the result (never throws on exit). */
export function dockerExec(
  container: string,
  argv: string[],
  opts: { user?: string; workdir?: string; input?: string } = {},
): DockerResult {
  const args = ['exec'];
  if (opts.input !== undefined) args.push('-i');
  if (opts.user) args.push('-u', opts.user);
  if (opts.workdir) args.push('-w', opts.workdir);
  return dockerTry([...args, container, ...argv], opts.input);
}

export const workspaceContainer = (workspaceId: string) => `wh-ws-${workspaceId}`;
export const workstreamContainer = (workstreamId: string) => `wh-st-${workstreamId}`;

/** Names (containers, volumes) or references (images) of the stand's Docker objects. */
export function instanceObjects(stand: Stand, match?: string): { containers: string[]; volumes: string[]; images: string[] } {
  const filters = ['--filter', `label=artisyn.workhub.instance=${stand.instance}`];
  const list = (args: string[]) =>
    docker(args)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s !== '' && (match === undefined || s.includes(match)));
  return {
    containers: list(['ps', '-a', '--format', '{{.Names}}', ...filters]),
    volumes: list(['volume', 'ls', '--format', '{{.Name}}', ...filters]),
    images: list(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', ...filters]),
  };
}

/** `git <args>` in a container's checkout, as the container's default (workspace) user. */
export function gitIn(container: string, workdir: string, args: string[]): DockerResult {
  return dockerExec(container, ['git', '-c', 'core.quotepath=off', ...args], { workdir });
}

// ---------------------------------------------------------------------------------------------
// Workspaces and the fake agent's login

export async function createWorkspace(api: WhApi, name: string): Promise<Workspace> {
  return api.expectStatus<Workspace>('POST', '/api/v1/workspaces', 201, { name });
}

export async function getWorkspace(api: WhApi, id: string): Promise<WorkspaceDetail> {
  return api.expectStatus<WorkspaceDetail>('GET', `/api/v1/workspaces/${encodeURIComponent(id)}`, 200);
}

/** The fake agent's credentials file, as `claude auth login` with `good-code` writes it. */
const FAKE_CREDENTIALS_SCRIPT =
  'mkdir -p "$HOME/.claude" && printf \'{"fake":"ok"}\\n\' > "$HOME/.claude/.credentials.json" ' +
  '&& chmod 600 "$HOME/.claude/.credentials.json"';

/**
 * Logs the workspace's agent in without the UI: writes the fake credentials into the workspace
 * container (as its default user), then waits until `GET workspace` (the live login check)
 * reports `loginState: "ok"`. The UI path is covered by {@link fakeLoginInUi}.
 */
export async function fakeLoginInContainer(api: WhApi, workspaceId: string): Promise<WorkspaceDetail> {
  const r = dockerExec(workspaceContainer(workspaceId), ['sh', '-c', FAKE_CREDENTIALS_SCRIPT]);
  if (r.status !== 0) throw new Error(`writing the fake credentials failed: ${r.stderr.trim()}`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ws = await getWorkspace(api, workspaceId);
    if (ws.loginState === 'ok') return ws;
    if (Date.now() > deadline) throw new Error(`workspace ${workspaceId} still reports loginState=${ws.loginState}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** A new workspace (through the API) whose agent is logged in. */
export async function workspaceWithFakeLogin(api: WhApi, name = `WS ${crypto.randomBytes(3).toString('hex')}`): Promise<WorkspaceDetail> {
  const ws = await createWorkspace(api, name);
  return fakeLoginInContainer(api, ws.id);
}

/** Visible text of the xterm on the page (or inside `scope`). xterm's DOM renderer is used. */
export async function terminalText(page: Page, scope = 'body'): Promise<string> {
  return page.locator(scope).locator('.xterm-rows').first().innerText();
}

/** Waits until the terminal shows `text`. */
export async function waitForTerminalText(page: Page, text: string | RegExp, scope = 'body', timeout = 60_000): Promise<void> {
  await expect
    .poll(async () => {
      const t = await terminalText(page, scope).catch(() => '');
      return typeof text === 'string' ? t.includes(text) : text.test(t);
    }, { timeout })
    .toBe(true);
}

/** Focuses the terminal and types `text` followed by Enter. */
export async function typeInTerminal(page: Page, text: string, scope = 'body'): Promise<void> {
  await page.locator(scope).locator('.xterm').first().click();
  if (text !== '') await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/**
 * The "fake login" of the test plan, on an open AgentLoginDialog: New login → Enter on the
 * method menu → `good-code` + Enter → "Login successful.".
 */
export async function fakeLoginInUi(page: Page): Promise<void> {
  await page.getByTestId('agent-login-new').click();
  await waitForTerminalText(page, 'Select login method');
  await typeInTerminal(page, '');
  await waitForTerminalText(page, 'Paste code here');
  // The code is pasted into the terminal: the prompt echoes nothing, the tab draws one * per
  // pasted character (headless Chromium has no native Ctrl+V, so the paste event is dispatched).
  await page
    .locator('[data-testid="login-tab"] textarea.xterm-helper-textarea')
    .evaluate((el) => {
      (el as HTMLTextAreaElement).focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', 'good-code');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
  await waitForTerminalText(page, 'Paste code here: *********');
  await page.keyboard.press('Enter');
}

// ---------------------------------------------------------------------------------------------
// Browser pages, the chat terminal and other scenario helpers

/** A browser page signed in with `api`'s session, plus the requests that left the stand origin. */
export interface SignedInPage {
  context: BrowserContext;
  page: Page;
  /** Request URLs that are not on the stand origin (AC-30); `data:` and `blob:` are local. */
  offOrigin: string[];
}

/** Records every request of `context` that does not go to the stand origin (AC-30). */
export function watchOrigin(context: BrowserContext, stand: Stand): string[] {
  const origin = new URL(stand.url).origin;
  const off: string[] = [];
  context.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return;
    if (new URL(url).origin !== origin) off.push(url);
  });
  context.on('page', (page) => {
    page.on('websocket', (ws) => {
      if (new URL(ws.url()).host !== new URL(origin).host) off.push(ws.url());
    });
  });
  return off;
}

/** A new browser context and page carrying `api`'s session cookie. */
export async function signedInPage(browser: Browser, stand: Stand, api: WhApi): Promise<SignedInPage> {
  const context = await browser.newContext({
    baseURL: stand.url,
    storageState: await api.storageState(),
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1400, height: 900 },
  });
  const offOrigin = watchOrigin(context, stand);
  const page = await context.newPage();
  return { context, page, offOrigin };
}

/** The live terminal shown on the page (the chat, login or configure tab in front). */
export const TERMINAL = '[data-testid="terminal-view"]:visible';

/** Waits until the visible terminal's socket is live. */
export async function waitForLiveTerminal(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-phase', 'live', { timeout });
}

/**
 * Sends one chat message to the fake agent and waits for `answer` in the terminal **after** the
 * echo of this message (`> <text>`), so an older identical answer (e.g. replayed scrollback) does
 * not count. Keep repeated messages distinct (`commit 1`, `commit 2`: the fake agent reads only
 * the first word of a command).
 */
export async function say(page: Page, text: string, answer?: string | RegExp, timeout = 60_000): Promise<void> {
  await waitForLiveTerminal(page);
  await typeInTerminal(page, text, TERMINAL);
  if (answer === undefined) return;
  const echo = `> ${text}`;
  await expect
    .poll(async () => {
      const t = await terminalText(page, TERMINAL).catch(() => '');
      const idx = t.lastIndexOf(echo);
      if (idx < 0) return false;
      const tail = t.slice(idx + echo.length);
      return typeof answer === 'string' ? tail.includes(answer) : answer.test(tail);
    }, { message: `"${text}" → ${String(answer)}`, timeout })
    .toBe(true);
}

/**
 * The background colour painted at the lower middle of `selector`'s first match: the first
 * non-transparent computed background among the elements at that point (AC-31).
 */
export async function paintedBackground(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.bottom - Math.min(20, r.height / 4);
    for (const e of document.elementsFromPoint(x, y)) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    }
    return 'none';
  });
}

/** Opens the working-branch view (`view` = main) or a workstream of the workspace. */
export async function gotoWorkspace(page: Page, workspaceId: string, streamId?: string): Promise<void> {
  const hash = streamId === undefined ? `#/w/${workspaceId}` : `#/w/${workspaceId}/s/${streamId}`;
  await page.goto(`/${hash}`);
  await expect(page.getByTestId('workstream-switcher')).toBeVisible();
}

/** The tree row of `path` (repo-relative). */
export function treeRow(page: Page, path: string) {
  return page.locator(`[data-testid="tree-row"][data-tree-path="${path}"]`);
}

/** Opens `path` from the tree (its folders must be expanded) and waits for its tab. */
export async function openFromTree(page: Page, path: string): Promise<void> {
  await treeRow(page, path).click();
  await expect(page.locator(`[data-testid="file-tab"][data-path="${path}"]`)).toHaveAttribute('aria-selected', 'true');
}

/** The editor of the file tab in front. */
export const EDITOR = '[data-testid="editor-tab"]:visible';

/** Types `text` at the end of the visible Monaco editor. */
export async function appendInEditor(page: Page, text: string): Promise<void> {
  const lines = page.locator(EDITOR).locator('.monaco-editor .view-lines');
  await expect(lines).toBeVisible();
  await lines.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

/** The text of the visible Monaco editor (its rendered lines, joined by `\n`). */
export async function editorText(page: Page): Promise<string> {
  const rows = page.locator(EDITOR).locator('.monaco-editor .view-line');
  const texts = await rows.allInnerTexts();
  return texts.map((t) => t.replace(/ /g, ' ')).join('\n');
}

/** Workstream summary (as `GET …/workstreams` returns it). */
export interface WorkstreamSummary {
  id: string;
  name: string;
  state: 'open' | 'closed' | 'done' | 'discarded';
  baseBranch: string;
  openedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  discardedAt: string | null;
  available: boolean;
}

export async function listWorkstreams(api: WhApi, workspaceId: string): Promise<WorkstreamSummary[]> {
  return api.expectStatus<WorkstreamSummary[]>('GET', `/api/v1/workspaces/${workspaceId}/workstreams`, 200);
}

/**
 * Opens a workstream through the UI ("+ Open workstream" → name → Open) and returns it once the
 * page shows its chat tab.
 */
export async function openWorkstreamInUi(page: Page, api: WhApi, workspaceId: string, name: string): Promise<WorkstreamSummary> {
  await page.getByTestId('switcher-open-workstream').click();
  await page.getByTestId('open-workstream-name').fill(name);
  await page.getByTestId('open-workstream-submit').click();
  await expect(page.getByTestId('open-workstream-dialog')).toHaveCount(0, { timeout: 180_000 });
  const streams = await listWorkstreams(api, workspaceId);
  const s = streams.find((x) => x.name === name.trim() && x.state === 'open');
  if (!s) throw new Error(`workstream "${name}" is not open: ${JSON.stringify(streams)}`);
  await expect(page).toHaveURL(new RegExp(`/s/${s.id}$`));
  await expect(page.getByTestId('pinned-tab-chat')).toHaveText(`Chat · ${s.name}`);
  return s;
}

/** The workstream's branch (from the DB: the API does not expose git names). */
export async function workstreamBranch(stand: Stand, streamId: string): Promise<string> {
  return withDb(stand, async (db) => {
    const r = await db.query<{ branch: string }>('SELECT branch FROM workstreams WHERE id = $1', [streamId]);
    if (r.rows.length !== 1) throw new Error(`no workstream row ${streamId}`);
    return r.rows[0].branch;
  });
}

/** `git` in the workspace container's working-branch checkout. */
export function gitMain(workspaceId: string, args: string[]): DockerResult {
  return gitIn(workspaceContainer(workspaceId), '/workspace/repo', args);
}

/** `git` in a workstream container's worktree. */
export function gitStream(streamId: string, args: string[]): DockerResult {
  return gitIn(workstreamContainer(streamId), '/workspace/worktree', args);
}

/** Whether a path exists in a container (`test -e`). */
export function existsIn(container: string, path: string): boolean {
  return dockerExec(container, ['test', '-e', path]).status === 0;
}

/** Docker's state of a container: `running`, `exited`, … or `missing`. */
export function containerState(name: string): string {
  const r = dockerTry(['inspect', '-f', '{{.State.Status}}', name]);
  return r.status === 0 ? r.stdout.trim() : 'missing';
}

/** Polls `fn` until it returns true. */
export async function eventually(fn: () => boolean | Promise<boolean>, message: string, timeout = 30_000): Promise<void> {
  await expect.poll(fn, { message, timeout, intervals: [250, 500, 1000] }).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// Playwright fixtures

export const test = base.extend<{ stand: Stand; api: WhApi }>({
  // eslint-disable-next-line no-empty-pattern
  stand: async ({}, use) => {
    await use(standFromEnv());
  },
  api: async ({ stand }, use) => {
    const api = await WhApi.create(stand.url);
    await use(api);
    await api.dispose();
  },
});

export { expect };
