/**
 * screen-registry.ts — every screen, tab and guard state of the web client as DATA
 * (impl-plan DD G4; `docs/qaa-overview/scenarios/06-ui-tab-walk.md` §1 and §2.1).
 *
 * The tours (`tour-01` … `tour-09`) walk these rows story by story; `tour-10-registry` (DD G6)
 * fails when the app gains a route, a tab, an analytics view, a report or a help article that no
 * row covers — or when a row covers something the app no longer has. The doc audit (block J) takes
 * every row with a `docRef`, opens it and compares the screen against that section of the docs.
 *
 * Loaded by Playwright and, per DD C13, directly by Node's type stripping (the doc-audit script),
 * so this module imports nothing and uses erasable syntax only.
 *
 * Tabs kept in component state (team detail, API keys) have no URL: their rows are reached by a
 * click, so their `route` is the page that holds them.
 *
 * Templates: `route` is an app route pattern from `client/src/app-routes.ts` (`:repoId`,
 * `:teamId` are filled from the tour's params); `query`, `expectText`, `forbidText` and
 * `expectUrl` may carry `{name}` placeholders, filled from the same params. A row may only use
 * the params its story provides (see `STORY_PARAMS`).
 *
 * Differences from the 06 design, by code:
 *   - Token Flow (the 8th Charts sub-tab and its Dashboard preview behind `VITE_ENABLE_TOKEN_FLOW`)
 *     no longer exists in the client, so the registry has no flagged rows: 96 screens, not 98.
 *   - The changelog article's slug is `changelog` (06 calls it `whats-new`).
 *   - The settings sub-tab id is `session-attribution` (06: «Session Attributes»).
 */

/** Stand mode, as in `tests/scenarios/modes.ts` (repeated here to keep the module import-free). */
export type RegistryMode = 'a' | 'b' | 'c';

/** Who looks at the screen (06 §2.5). */
export type TourRole =
  /** No session cookie. */
  | 'anon'
  /** `role = admin`. */
  | 'admin'
  /** A plain user who owns the repository (never admin, so owner and admin stay distinguishable). */
  | 'owner'
  /** A plain user who owns a team. */
  | 'team-owner'
  /** A plain member of a restricted team. */
  | 'member'
  /** A plain user with no relation to the repository or team. */
  | 'non-member'
  /** Any plain user (help, notifications, admin guard). */
  | 'regular'
  /** A user added to a team without an Accept step (force-invite): the disclosure gate. */
  | 'forced'
  /** A user who has not accepted the data-collection notice: the consent gate. */
  | 'fresh';

export type TourId =
  'tour-01' | 'tour-02' | 'tour-03' | 'tour-04' | 'tour-05' | 'tour-06' | 'tour-07' | 'tour-08' | 'tour-09';

/** `data-testid` groups of tab triggers (`tab-<group>-<id>`, DD G1). */
export type TabGroup = 'repo' | 'session' | 'chart' | 'admin' | 'settings' | 'team' | 'apikeys';

/** A section of the documentation that describes the screen (block J). */
export interface DocRef {
  /** Repo-relative path of a Markdown file. */
  file: string;
  /** Exact heading text (without the `#`s); absent = the whole file. */
  heading?: string;
}

export interface ExpectedResponse {
  /** RegExp source matched against the response URL. */
  url: string;
  status: number;
}

export interface ScreenRow {
  /** Stable dotted id, e.g. `session.charts.agent-tree`. Also the `test.step` title. */
  id: string;
  story: TourId;
  /** App route pattern from `client/src/app-routes.ts` (`ROUTE`). */
  route: string;
  /** A concrete path instead of the route pattern (the `*` catch-all row). */
  path?: string;
  /** Query part of the hash (`?mtab=settings&stab=display`), with `{param}` placeholders. */
  query?: string;
  /** The tab this row opens. */
  tab?: { group: TabGroup; id: string };
  /**
   * Extra coverage keys besides `route:` and `tab:` (`analytics:<view>`, `report:<id>`,
   * `help:<slug>`) — what the meta-test (DD G6) compares with the client's constants.
   */
  covers?: string[];
  role: TourRole;
  /** Stand modes the row applies to. */
  modes: RegistryMode[];
  /** Human-readable name of the screen (doc audit). */
  title: string;
  docRef?: DocRef;
  /** Anchor: text that must be visible on the screen — a concrete value, not «any text». */
  expectText?: string;
  /** Anchor: an element by `data-testid` that must be visible. */
  expectTestId?: string;
  /** Anchor: a CSS selector of which at least one element must be visible. */
  expectSelector?: string;
  /** RegExp source the page URL must match once the screen settled (redirect rows). */
  expectUrl?: string;
  /** Texts that must NOT be on the screen (no-leak checks of negative rows). */
  forbidText?: string[];
  /** A guard / fallback / redirect row: checks that something is absent or bounced (06 §3.1). */
  negative?: boolean;
  /** `/api/*` answers ≥ 400 this screen legitimately causes. */
  expectedNetwork?: ExpectedResponse[];
  /**
   * The seed may legitimately leave this screen empty; `emptyText` is the meaningful empty state
   * that is then accepted instead of the anchor (06 §1.5, §1.7, §1.8).
   */
  dataOptional?: boolean;
  emptyText?: string;
  /** Key screen for the doc audit's screenshots (06 §2.2 p.6). */
  screenshot?: boolean;
}

const HELP = 'user-docs';
const ALL_MODES: RegistryMode[] = ['a', 'b', 'c'];
const PASSWORD_MODES: RegistryMode[] = ['b', 'c'];
const A: RegistryMode[] = ['a'];

/** Params each story fills (route `:x` and `{x}` placeholders). The meta-test checks rows against it. */
export const STORY_PARAMS: Readonly<Record<TourId, readonly string[]>> = {
  'tour-01': ['repoId', 'resetToken'],
  'tour-02': ['repoUrl', 'teamName', 'regularEmail'],
  'tour-03': ['repoId', 'repoUrl', 'firstPrompt', 'apiKeyName'],
  'tour-04': ['repoId', 'from', 'to', 'startDate', 'endDate'],
  'tour-05': ['repoId', 'teamId', 'sessionId', 'plainSessionId', 'foreignSessionId', 'advisorSummary'],
  'tour-06': ['teamId', 'repoId', 'teamName', 'memberEmail', 'pendingEmail', 'repoUrl', 'firstPrompt'],
  'tour-07': ['teamId', 'repoId', 'teamName', 'ownerSessionId', 'ownPrompt', 'ownerPrompt'],
  'tour-08': ['teamId', 'repoId', 'sessionId', 'repoUrl', 'firstPrompt', 'teamName'],
  'tour-09': ['teamName'],
};

// ---------------------------------------------------------------------------------------------
// Story 1 — anonymous: auth pages and guards (06 §2.3 #1). `@mode-a @mode-b @mode-c`; the
// password pages only exist in B and C (in A the server answers them 404, DD C6).
// ---------------------------------------------------------------------------------------------
const ANON_ROWS: ScreenRow[] = [
  {
    id: 'auth.login.identify',
    story: 'tour-01',
    route: '/login',
    role: 'anon',
    modes: A,
    title: 'Login (auth mode none: e-mail only)',
    expectText: 'Enter your email to continue',
    // authentication-modes.md has no H2: the whole page is the mode table.
    docRef: {
      file: `${HELP}/authentication-modes.md`,
      heading: 'Authentication modes',
    },
    screenshot: true,
  },
  {
    id: 'auth.login.password',
    story: 'tour-01',
    route: '/login',
    role: 'anon',
    modes: PASSWORD_MODES,
    title: 'Login (password modes)',
    expectSelector: 'input[placeholder="Password"]',
    docRef: {
      file: `${HELP}/security-hardening.md`,
      heading: '3.3 Passwords (Modes 2 and 3)',
    },
    screenshot: true,
  },
  {
    id: 'auth.signup',
    story: 'tour-01',
    route: '/signup',
    role: 'anon',
    modes: PASSWORD_MODES,
    title: 'Sign up',
    expectText: 'Create account',
    docRef: {
      file: `${HELP}/security-hardening.md`,
      heading: '3.3 Passwords (Modes 2 and 3)',
    },
  },
  {
    id: 'auth.forgot-password',
    story: 'tour-01',
    route: '/forgot-password',
    role: 'anon',
    modes: PASSWORD_MODES,
    title: 'Forgot password',
    expectText: 'Forgot password?',
  },
  {
    id: 'auth.reset-password',
    story: 'tour-01',
    route: '/reset-password',
    query: '?token={resetToken}',
    role: 'anon',
    modes: PASSWORD_MODES,
    title: 'Reset password (valid link)',
    expectSelector: 'input[placeholder="Confirm new password"]',
  },
  {
    id: 'auth.reset-password.bad-token',
    story: 'tour-01',
    route: '/reset-password',
    query: '?token=scn-not-a-real-token',
    role: 'anon',
    modes: PASSWORD_MODES,
    title: 'Reset password (garbage link): a readable error, no crash',
    negative: true,
    expectText: 'Invalid or unknown token',
    expectedNetwork: [{ url: '/api/v1/auth/reset-password$', status: 400 }],
  },
  {
    id: 'auth.confirm-email.bad-token',
    story: 'tour-01',
    route: '/confirm-email',
    query: '?token=scn-not-a-real-token',
    role: 'anon',
    modes: ['b'],
    title: 'Confirm e-mail (garbage link): a status page, no crash',
    negative: true,
    expectText: 'This confirmation link is invalid.',
    expectedNetwork: [{ url: '/api/v1/auth/confirm-email$', status: 400 }],
  },
  {
    id: 'guard.anon.repo',
    story: 'tour-01',
    route: '/repos/:repoId',
    role: 'anon',
    modes: ALL_MODES,
    title: 'Anonymous deep link to a repository bounces to login',
    negative: true,
    expectUrl: '#/login$',
  },
  {
    id: 'guard.anon.admin',
    story: 'tour-01',
    route: '/admin',
    role: 'anon',
    modes: ALL_MODES,
    title: 'Anonymous deep link to the admin panel bounces to login',
    negative: true,
    expectUrl: '#/login$',
  },
];

// ---------------------------------------------------------------------------------------------
// Story 2 — admin panel (06 §2.3 #2, §1.5).
// ---------------------------------------------------------------------------------------------
const ADMIN_ROWS: ScreenRow[] = (
  [
    {
      id: 'admin.system-info',
      tab: { group: 'admin', id: 'system-info' },
      title: 'Admin: System Info',
      expectText: 'Process uptime',
      screenshot: true,
    },
    {
      id: 'admin.all-repos',
      tab: { group: 'admin', id: 'all-repos' },
      title: 'Admin: Repos',
      expectText: '{repoUrl}',
    },
    {
      id: 'admin.all-teams',
      tab: { group: 'admin', id: 'all-teams' },
      title: 'Admin: Teams',
      expectText: '{teamName}',
    },
    {
      id: 'admin.all-users',
      tab: { group: 'admin', id: 'all-users' },
      title: 'Admin: Users',
      expectText: '{regularEmail}',
      screenshot: true,
    },
    {
      id: 'admin.error-logs',
      tab: { group: 'admin', id: 'error-logs' },
      title: 'Admin: Error Logs',
      // A fresh stand may have no error log at all: the table (its «Timestamp» column) or the
      // meaningful empty state.
      expectText: 'Timestamp',
      dataOptional: true,
      emptyText: 'No errors found',
    },
    {
      id: 'admin.upload-queue',
      tab: { group: 'admin', id: 'upload-queue' },
      title: 'Admin: Upload Queue',
      // The worker statistics block (06 §1.5); processed uploads leave the queue, so its entry
      // table is usually empty on a stand.
      expectText: 'Utilisation',
    },
    {
      id: 'admin.data-retention',
      tab: { group: 'admin', id: 'data-retention' },
      title: 'Admin: Data Retention',
      expectText: 'Sessions older than this are purged',
      docRef: {
        file: `${HELP}/security-hardening.md`,
        heading: '6.2 Retention',
      },
    },
    {
      id: 'admin.auth',
      tab: { group: 'admin', id: 'auth' },
      title: 'Admin: Auth',
      expectText: 'Other modes',
      docRef: {
        file: `${HELP}/authentication-modes.md`,
        heading: 'Authentication modes',
      },
    },
    {
      id: 'admin.model-pricing',
      tab: { group: 'admin', id: 'model-pricing' },
      title: 'Admin: Model Pricing',
      expectText: 'claude-sonnet-4-6',
      docRef: {
        file: `${HELP}/cost-and-context.md`,
        heading: 'How cost is calculated',
      },
    },
  ] satisfies Array<Omit<ScreenRow, 'story' | 'route' | 'role' | 'modes'>>
).map((r): ScreenRow => ({
  ...r,
  story: 'tour-02',
  route: '/admin',
  role: 'admin',
  modes: A,
}));

ADMIN_ROWS.push(
  {
    id: 'admin.deep-link.unknown-tab',
    story: 'tour-02',
    route: '/admin',
    query: '?tab=bogus',
    role: 'admin',
    modes: A,
    title: 'Admin: an unknown ?tab= falls back to System Info',
    negative: true,
    expectText: 'Process uptime',
    expectUrl: '#/admin\\?tab=bogus$',
  },
  {
    id: 'admin.hidden-for-regular',
    story: 'tour-02',
    route: '/admin',
    role: 'regular',
    modes: A,
    title: 'Admin panel: a plain user has no «Admin Panel» link and #/admin bounces to #/main',
    negative: true,
    expectText: 'Select an item from the left panel',
    expectUrl: '#/main$',
  },
);

// ---------------------------------------------------------------------------------------------
// Story 3 — repository owner: the personal repository without session detail (06 §2.3 #3).
// ---------------------------------------------------------------------------------------------
const SETTINGS_ANCHORS: Array<[string, string, string, string]> = [
  // [stab id, title, anchor text, help heading]
  ['display', 'Display', 'Hide hook-service sessions', 'Display'],
  ['file-categories', 'File Categories', 'Pattern', 'File Categories'],
  ['analysis', 'Analysis', 'Turn-End Cost Advisor', 'Analysis'],
  ['monitored-tools', 'Monitored Tools', 'Pause all wrapping', 'Monitored Tools'],
  // A personal repository has no team to configure session attributes for: that notice is the screen.
  ['session-attribution', 'Session Attribution', 'Session attributes are a team-level setting', 'Session Attribution'],
  ['maintenance', 'Maintenance', 'Recompute all sessions', 'Maintenance and Import/Export'],
  ['import-export', 'Import/Export', 'Export session', 'Maintenance and Import/Export'],
];

const OWNER_REPO_ROWS: ScreenRow[] = (
  [
    {
      id: 'main',
      route: '/main',
      title: 'Main page',
      expectText: 'Select an item from the left panel',
    },
    {
      id: 'redirect.unknown-path',
      route: '*',
      path: '/no-such-screen',
      title: 'An unknown path redirects to #/main',
      negative: true,
      expectUrl: '#/main$',
    },
    {
      id: 'repo.sessions',
      route: '/repos/:repoId',
      tab: { group: 'repo', id: 'sessions' },
      title: 'Repository: Sessions (session list, four view modes)',
      expectText: '{firstPrompt}',
      docRef: { file: `${HELP}/session-list.md`, heading: 'View modes' },
      screenshot: true,
    },
    {
      id: 'repo.analytics',
      route: '/repos/:repoId',
      query: '?mtab=analytics',
      tab: { group: 'repo', id: 'analytics' },
      title: 'Repository: Analytics (default view)',
      expectText: 'Work Time',
      docRef: {
        file: `${HELP}/analytics-reports.md`,
        heading: 'Analytics tab',
      },
    },
    {
      id: 'repo.reports',
      route: '/repos/:repoId',
      query: '?mtab=reports',
      tab: { group: 'repo', id: 'reports' },
      title: 'Repository: Reports (report tree)',
      expectText: 'Executive Summary',
      docRef: { file: `${HELP}/analytics-reports.md`, heading: 'Reports tab' },
    },
    {
      id: 'repo.settings',
      route: '/repos/:repoId',
      query: '?mtab=settings',
      tab: { group: 'repo', id: 'settings' },
      title: 'Repository: Settings',
      expectTestId: 'tab-settings-display',
      docRef: {
        file: `${HELP}/tuning-your-setup.md`,
        heading: 'Repository settings',
      },
    },
    ...SETTINGS_ANCHORS.map(([stab, title, anchor, heading]): Omit<ScreenRow, 'story' | 'role' | 'modes'> => ({
      id: `repo.settings.${stab}`,
      route: '/repos/:repoId',
      query: `?mtab=settings&stab=${stab}`,
      tab: { group: 'settings', id: stab },
      title: `Repository settings: ${title}`,
      expectText: anchor,
      docRef: { file: `${HELP}/tuning-your-setup.md`, heading },
    })),
    {
      id: 'hook-state',
      route: '/repos/:repoId/hook-state',
      title: 'Hook State of a repository',
      expectText: '{repoUrl}',
      docRef: {
        file: `${HELP}/connect-repository.md`,
        heading: 'The Hook State page',
      },
      screenshot: true,
    },
    {
      id: 'api-keys.install',
      route: '/api-keys',
      tab: { group: 'apikeys', id: 'install' },
      title: 'API keys: Install',
      expectText: 'Full Auto Install',
      docRef: {
        file: 'hook/INSTALL_HOOK.md',
        heading: '1. Install',
      },
      screenshot: true,
    },
    {
      id: 'api-keys.keys',
      route: '/api-keys',
      tab: { group: 'apikeys', id: 'keys' },
      title: 'API keys: My keys',
      expectText: '{apiKeyName}',
      docRef: {
        file: `${HELP}/security-hardening.md`,
        heading: '3.6 API keys (hook authentication)',
      },
    },
  ] satisfies Array<Omit<ScreenRow, 'story' | 'role' | 'modes'>>
).map((r): ScreenRow => ({ ...r, story: 'tour-03', role: 'owner', modes: A }));

// ---------------------------------------------------------------------------------------------
// Story 4 — analytics (13 views), reports (17) and the repo OKF tab on REPO-GOLD (06 §2.3 #4, §1.7, §1.8).
// ---------------------------------------------------------------------------------------------
const ANALYTICS_QUERY = '?mtab=analytics&ar=custom&af={from}&at={to}&av=';
/** A bar of the vertical charts (each bar group is clickable). */
const CHART_BAR = 'svg g[style*="cursor: pointer"]';

const ANALYTICS_VIEWS: Array<[string, string, Partial<ScreenRow>]> = [
  ['work-time', 'Work Time', { expectSelector: CHART_BAR }],
  ['cost', 'Cost', { expectSelector: CHART_BAR }],
  ['files', 'Files & Tools', { expectSelector: CHART_BAR }],
  // No golden session examines an image: the meaningful empty state is accepted.
  [
    'vision',
    'Vision',
    {
      expectSelector: CHART_BAR,
      dataOptional: true,
      emptyText: 'No vision activity in this range',
    },
  ],
  ['mcp', 'MCP Invocations', { expectSelector: CHART_BAR }],
  ['productivity', 'Productivity', { expectSelector: CHART_BAR }],
  ['log-lines', 'Log Lines', { expectSelector: CHART_BAR }],
  ['cache-read-ratio', 'Cache Read Ratio', { expectTestId: 'cache-ratio-scope-summary' }],
  ['change-surface', 'Change Surface', { expectTestId: 'change-surface-bar' }],
  ['tools', 'Tool Analytics', { expectTestId: 'tool-analytics-view' }],
  ['tokens', 'Token Breakdown', { expectTestId: 'token-breakdown-view' }],
  ['productivity-counters', 'Productivity Counters', { expectTestId: 'productivity-counters-view' }],
  ['active-sessions', 'Active Sessions', { expectTestId: 'active-sessions-view' }],
];

const ANALYTICS_ROWS: ScreenRow[] = ANALYTICS_VIEWS.map(([view, label, anchor]): ScreenRow => ({
  id: `repo.analytics.${view}`,
  story: 'tour-04',
  route: '/repos/:repoId',
  query: `${ANALYTICS_QUERY}${view}`,
  covers: [`analytics:${view}`],
  role: 'owner',
  modes: A,
  title: `Analytics: ${label}`,
  docRef: { file: `${HELP}/analytics-reports.md`, heading: 'Analytics tab' },
  ...anchor,
}));

const REPORTS: Array<[string, string, Partial<ScreenRow>?]> = [
  ['executive-summary', 'Executive Summary', { screenshot: true }],
  ['session-timeline', 'Session Timeline'],
  ['work-time', 'Work Time Distribution'],
  ['tool-analytics', 'Tool Analytics'],
  ['active-sessions', 'Active Sessions'],
  ['branch-summary', 'Branch Summary'],
  ['change-surface', 'Change Surface'],
  [
    'cost-by-branch',
    'Cost by Branch',
    {
      docRef: {
        file: `${HELP}/cost-and-context.md`,
        heading: 'Where you see cost',
      },
    },
  ],
  ['cost-by-user', 'Cost by User'],
  [
    'cache-read-ratio',
    'Cache Read Ratio',
    {
      docRef: {
        file: `${HELP}/cost-and-context.md`,
        heading: 'Cache read ratio',
      },
    },
  ],
  ['token-usage', 'Token Usage'],
  ['productivity', 'Productivity'],
  ['productivity-counters', 'Productivity Counters'],
  ['harness-usage', 'Harness Usage'],
  // «Outdated» needs the Claude Code release list, which the stand never fetches
  // (AI_TOOL_VERSION_CHECK_ENABLED=false, DD C4): the report's meaningful empty table is accepted.
  ['claude-version-usage', 'Claude Code Version Usage', { dataOptional: true, emptyText: 'No sessions in this period' }],
  // No session attributes are configured on the golden repository: the empty report is accepted.
  ['attribution-breakdown', 'Attribute Breakdown', { dataOptional: true }],
  ['attribution-usage', 'Attribute Extraction Usage', { dataOptional: true }],
];

const REPORT_ROWS: ScreenRow[] = REPORTS.map(([report, title, extra]): ScreenRow => ({
  id: `repo.reports.${report}`,
  story: 'tour-04',
  route: '/repos/:repoId',
  query: `?mtab=reports&report=${report}&startDate={startDate}&endDate={endDate}`,
  covers: [`report:${report}`],
  role: 'owner',
  modes: A,
  title: `Report: ${title}`,
  // The report document's <h1> is the anchor (it may carry a prefix: «AI Usage — Executive
  // Summary»); the tour also waits for «Download as PDF».
  expectSelector: `h1:has-text("${title}")`,
  docRef: { file: `${HELP}/analytics-reports.md`, heading: 'Reports tab' },
  ...extra,
}));

/**
 * The repo OKF tab over the golden two weeks. No golden session has an OKF snapshot, so the tab
 * shows its snapshot-less state (or «KB not used in this period»); S-REPO-16 and S-REPT-01 walk
 * the filled tab.
 */
const OKF_REPO_ROW: ScreenRow = {
  id: 'repo.okf',
  story: 'tour-04',
  route: '/repos/:repoId',
  query: '?mtab=okf&okfFrom={startDate}&okfTo={endDate}',
  tab: { group: 'repo', id: 'okf' },
  role: 'owner',
  modes: A,
  title: 'Repository: OKF (knowledge base usage)',
  expectTestId: 'repo-okf-tab',
};

/**
 * The repo Tools/MCP tab (2026-06-19-mcp-invocation-log-tab) over the golden two weeks. The
 * tab's frame (top bar, Monitored tools button) is the anchor; whether the golden transcripts
 * hold MCP calls or not, the body is the tree or «No tool calls in this range». S-REPO-17 walks
 * the filled tab.
 */
const TOOLS_REPO_ROW: ScreenRow = {
  id: 'repo.tools',
  story: 'tour-04',
  route: '/repos/:repoId',
  query: '?mtab=tools&tfrom={startDate}&tto={endDate}',
  tab: { group: 'repo', id: 'tools' },
  role: 'owner',
  modes: A,
  title: 'Repository: Tools/MCP (tool and MCP calls)',
  expectTestId: 'repo-tools-tab',
};

// ---------------------------------------------------------------------------------------------
// Story 5 — session detail: 9 tabs + 7 Charts sub-tabs + redirects (06 §2.3 #5, §1.3, §1.4).
// ---------------------------------------------------------------------------------------------
const SESSION_QUERY = '?session={sessionId}';
const SESSION_DOC = `${HELP}/session-log.md`;

const SESSION_TAB_ROWS: Array<Omit<ScreenRow, 'story' | 'role' | 'modes' | 'route'>> = [
  {
    id: 'session.summary',
    query: SESSION_QUERY,
    tab: { group: 'session', id: 'summary' },
    title: 'Session: Summary',
    expectTestId: 'summary-executive-band',
    docRef: { file: SESSION_DOC, heading: 'Tabs' },
    screenshot: true,
  },
  {
    id: 'session.info',
    query: `${SESSION_QUERY}&tab=info`,
    tab: { group: 'session', id: 'info' },
    title: 'Session: Info',
    expectText: 'Calculated total',
    docRef: { file: SESSION_DOC, heading: 'Info' },
  },
  {
    id: 'session.logs',
    query: `${SESSION_QUERY}&tab=logs`,
    tab: { group: 'session', id: 'logs' },
    title: 'Session: Logs',
    expectSelector: '[data-turn-index]',
    docRef: { file: SESSION_DOC, heading: 'Timeline' },
    screenshot: true,
  },
  {
    id: 'session.bash',
    query: `${SESSION_QUERY}&tab=bash`,
    tab: { group: 'session', id: 'bash' },
    title: 'Session: Bash',
    expectTestId: 'session-bash-tab',
    docRef: { file: SESSION_DOC, heading: 'Bash' },
  },
  {
    id: 'session.charts',
    query: `${SESSION_QUERY}&tab=charts`,
    tab: { group: 'session', id: 'charts' },
    title: 'Session: Charts',
    expectTestId: 'tab-chart-dashboard',
    docRef: { file: SESSION_DOC, heading: 'Charts' },
  },
  {
    id: 'session.advisor',
    query: `${SESSION_QUERY}&tab=advisor`,
    tab: { group: 'session', id: 'advisor' },
    title: 'Session: Advisor (a session with a submitted Turn-End Advisor run)',
    expectText: '{advisorSummary}',
    docRef: {
      file: `${HELP}/tuning-your-setup.md`,
      heading: "Acting on the Advisor's advice",
    },
  },
  {
    id: 'session.usage',
    query: `${SESSION_QUERY}&tab=usage`,
    tab: { group: 'session', id: 'usage' },
    title: 'Session: Statistics',
    expectTestId: 'session-usage-tab',
  },
  {
    id: 'session.change-surface',
    query: `${SESSION_QUERY}&tab=change-surface`,
    tab: { group: 'session', id: 'change-surface' },
    title: 'Session: Change surface',
    expectTestId: 'change-surface-headline',
  },
  {
    id: 'session.harness-usage',
    query: `${SESSION_QUERY}&tab=harness-usage`,
    tab: { group: 'session', id: 'harness-usage' },
    title: 'Session: Harness usage',
    expectTestId: 'harness-tree-row',
  },
  {
    // The golden tour session has no OKF bundle and reads no KB article: the tab's empty state
    // is the meaningful screen there; S-SESS-09 walks the filled tab.
    id: 'session.okf',
    query: `${SESSION_QUERY}&tab=okf`,
    tab: { group: 'session', id: 'okf' },
    title: 'Session: OKF (knowledge base usage)',
    expectTestId: 'session-okf-tab',
    dataOptional: true,
    emptyText: 'No OKF knowledge base',
  },
  {
    // The repo Tools/MCP tab narrowed to this session. Its frame is the anchor; whether the
    // golden session holds MCP calls or not, the body is the tree or the empty state.
    // S-REPO-17 walks the filled tab.
    id: 'session.tools',
    query: `${SESSION_QUERY}&tab=tools`,
    tab: { group: 'session', id: 'tools' },
    title: 'Session: Tools/MCP (this session’s tool and MCP calls)',
    expectTestId: 'session-tools-tab',
  },
  {
    id: 'session.raw-logs',
    query: `${SESSION_QUERY}&tab=raw-logs`,
    tab: { group: 'session', id: 'raw-logs' },
    title: 'Session: Raw Logs (owner only)',
    expectSelector: 'th:text-is("Type")',
    docRef: { file: SESSION_DOC, heading: 'Raw Logs' },
  },
  {
    // Built from the loaded /logs payload (startup block + harness snapshot); S-SESS-03 steps
    // 8–9 walk the totals, partitions, drill-downs and edge banners.
    id: 'session.sysctx',
    query: `${SESSION_QUERY}&tab=sysctx`,
    tab: { group: 'session', id: 'sysctx' },
    title: 'Session: System context anatomy',
    expectTestId: 'sysctx-anatomy-tab',
    docRef: { file: SESSION_DOC, heading: 'System context anatomy' },
  },
  {
    id: 'session.call-tree.redirect',
    query: `${SESSION_QUERY}&tab=call-tree`,
    tab: { group: 'session', id: 'call-tree' },
    title: 'Session: the legacy tab=call-tree deep link lands on Charts',
    negative: true,
    expectUrl: 'tab=charts',
    expectTestId: 'tab-chart-dashboard',
  },
  {
    id: 'session.advisor.absent-redirect',
    query: '?session={plainSessionId}&tab=advisor',
    title: 'Session without an advisor result: no Advisor tab, tab=advisor falls back to Summary',
    negative: true,
    expectTestId: 'summary-executive-band',
  },
  {
    // In a team view the server decides who reads a session's logs (`canSeeRawLogs`): the team
    // OWNER of a restricted team may, so the negative case is a MANAGER, who sees the session in
    // the list but not its logs (as in S-SESS-12).
    id: 'session.raw-logs.hidden-for-foreign',
    query: '?session={foreignSessionId}&tab=raw-logs',
    title: "A restricted-team manager on a member's session: no Raw Logs tab, tab=raw-logs falls back",
    negative: true,
    expectTestId: 'tab-session-summary',
    expectedNetwork: [{ url: '/api/v1/repositories/\\d+/sessions/[^/]+/logs$', status: 403 }],
  },
];

const CHART_ROWS: Array<[string, string, Partial<ScreenRow>]> = [
  ['dashboard', 'Dashboard', { expectText: 'Context Growth' }],
  ['context-growth', 'Context Growth', { expectTestId: 'growth-row' }],
  ['context-usage', 'Context Usage', { expectSelector: 'svg' }],
  ['agent-tree', 'Agent Tree', { expectTestId: 'agent-tree-node' }],
  ['timeline', 'Timeline', { expectTestId: 'gantt-chart-area' }],
  ['tool-heatmap', 'Tool Heatmap', { expectText: 'Read' }],
  ['call-tree', 'Call Tree', { expectText: 'Cost share' }],
];

const SESSION_ROWS: ScreenRow[] = [
  ...SESSION_TAB_ROWS.map((r): ScreenRow => ({
    ...r,
    story: 'tour-05',
    route: r.id === 'session.raw-logs.hidden-for-foreign' ? '/teams/:teamId/repos/:repoId' : '/repos/:repoId',
    role: 'owner',
    modes: A,
  })),
  ...CHART_ROWS.map(([chart, label, anchor]): ScreenRow => ({
    id: `session.charts.${chart}`,
    story: 'tour-05',
    route: '/repos/:repoId',
    query: `${SESSION_QUERY}&tab=charts`,
    tab: { group: 'chart', id: chart },
    role: 'owner',
    modes: A,
    title: `Session charts: ${label}`,
    docRef: { file: SESSION_DOC, heading: 'Charts' },
    ...anchor,
  })),
];

// ---------------------------------------------------------------------------------------------
// Story 6 — team owner (a plain user): teams, team detail, team repository (06 §2.3 #6).
// ---------------------------------------------------------------------------------------------
const TEAM_OWNER_ROWS: ScreenRow[] = (
  [
    {
      id: 'teams.list',
      route: '/teams',
      title: 'Teams',
      expectText: '{teamName}',
      docRef: { file: `${HELP}/session-list.md`, heading: 'Team repositories' },
    },
    {
      id: 'team.members',
      route: '/teams/:teamId',
      tab: { group: 'team', id: 'members' },
      title: 'Team: Members',
      expectText: '{memberEmail}',
      screenshot: true,
    },
    {
      id: 'team.repositories',
      route: '/teams/:teamId',
      tab: { group: 'team', id: 'repositories' },
      title: 'Team: Repositories',
      expectText: '{repoUrl}',
    },
    {
      id: 'team.invitations',
      route: '/teams/:teamId',
      tab: { group: 'team', id: 'invitations' },
      title: 'Team: Invitations',
      expectText: '{pendingEmail}',
    },
    {
      id: 'team-repo.sessions',
      route: '/teams/:teamId/repos/:repoId',
      title: 'Team repository: Sessions',
      expectText: '{firstPrompt}',
      docRef: { file: `${HELP}/session-list.md`, heading: 'Team repositories' },
    },
    {
      id: 'team-repo.owner-sees-team-wide-tabs',
      route: '/teams/:teamId/repos/:repoId',
      query: '?mtab=settings',
      title: 'Team repository of a restricted team: the (non-admin) team owner still has Analytics, Reports, Settings',
      expectTestId: 'tab-settings-display',
    },
    {
      id: 'nav.installed-hooks',
      route: '/repos/:repoId/hook-state',
      title: 'Left menu «Installed Hooks» opens the Hook State page',
      expectText: 'Hook State',
      docRef: {
        file: `${HELP}/connect-repository.md`,
        heading: 'The Hook State page',
      },
    },
  ] satisfies Array<Omit<ScreenRow, 'story' | 'role' | 'modes'>>
).map((r): ScreenRow => ({
  ...r,
  story: 'tour-06',
  role: 'team-owner',
  modes: A,
}));

// ---------------------------------------------------------------------------------------------
// Story 7 — member of a restricted team (06 §2.3 #7).
// ---------------------------------------------------------------------------------------------
const MEMBER_ROWS: ScreenRow[] = (
  [
    {
      id: 'member.team-detail',
      route: '/teams/:teamId',
      title: 'Team detail as a plain member: «Leave team», no owner controls',
      expectText: 'Leave team',
      forbidText: ['Delete team'],
    },
    {
      id: 'member.team-repo.restricted-notice',
      route: '/teams/:teamId/repos/:repoId',
      title: 'Restricted team repository: the restricted-sessions notice, own sessions only',
      expectTestId: 'restricted-sessions-notice',
      forbidText: ['{ownerPrompt}'],
      docRef: { file: `${HELP}/session-list.md`, heading: 'Team repositories' },
      screenshot: true,
    },
    {
      id: 'member.team-repo.no-team-wide-tabs',
      route: '/teams/:teamId/repos/:repoId',
      title: 'Restricted team repository: no Analytics / Reports / Settings tabs',
      negative: true,
      expectText: '{ownPrompt}',
    },
    {
      id: 'member.team-repo.settings-fallback',
      route: '/teams/:teamId/repos/:repoId',
      query: '?mtab=settings',
      title: 'Restricted team repository: ?mtab=settings falls back to Sessions',
      negative: true,
      expectText: '{ownPrompt}',
    },
    {
      id: 'member.foreign-session.no-raw-logs',
      route: '/teams/:teamId/repos/:repoId',
      query: '?session={ownerSessionId}&tab=raw-logs',
      title: "Restricted team: a deep link to the owner's session shows neither its prompt nor Raw Logs",
      negative: true,
      expectText: '{ownPrompt}',
      forbidText: ['{ownerPrompt}'],
    },
    {
      id: 'member.admin-redirect',
      route: '/admin',
      title: 'A plain member: #/admin bounces to #/main',
      negative: true,
      expectUrl: '#/main$',
    },
  ] satisfies Array<Omit<ScreenRow, 'story' | 'role' | 'modes'>>
).map((r): ScreenRow => ({ ...r, story: 'tour-07', role: 'member', modes: A }));

// ---------------------------------------------------------------------------------------------
// Story 8 — a user with no relation to the repository or the team (06 §2.3 #8).
// ---------------------------------------------------------------------------------------------
const NO_LEAK = ['{repoUrl}', '{firstPrompt}'];
/** Every repository read of someone else's repository answers 403 (`assertRepoAccess`). */
const FOREIGN_REPO_403: ExpectedResponse[] = [{ url: '/api/v1/repositories/\\d+(/|$)', status: 403 }];
const NON_MEMBER_ROWS: ScreenRow[] = (
  [
    {
      id: 'non-member.repo',
      route: '/repos/:repoId',
      title: "Someone else's repository: «No access», no data, no crash",
      expectText: 'No access',
      forbidText: NO_LEAK,
      expectedNetwork: FOREIGN_REPO_403,
    },
    {
      id: 'non-member.session',
      route: '/repos/:repoId',
      query: '?session={sessionId}',
      title: "Someone else's session deep link: «No access», no data",
      expectText: 'No access',
      forbidText: NO_LEAK,
      expectedNetwork: FOREIGN_REPO_403,
    },
    {
      id: 'non-member.team',
      route: '/teams/:teamId',
      // Current behaviour, pinned: the team is not in the caller's list and its members answer
      // 403, so the page stays on «Loading team…» — no error state, but no data and no crash.
      title: "Someone else's team: no team data, no crash (the page stays on «Loading team…»)",
      expectText: 'Loading team…',
      forbidText: ['{teamName}'],
      expectedNetwork: [{ url: '/api/v1/teams/\\d+/members$', status: 403 }],
    },
    {
      id: 'non-member.team-repo',
      route: '/teams/:teamId/repos/:repoId',
      title: "Someone else's team repository: «No access», no data, no crash",
      expectText: 'No access',
      forbidText: NO_LEAK,
      expectedNetwork: FOREIGN_REPO_403,
    },
    {
      id: 'non-member.hook-state',
      route: '/repos/:repoId/hook-state',
      title: "Someone else's hook state: «No access»",
      expectText: 'No access',
      forbidText: ['{repoUrl}'],
      expectedNetwork: [{ url: '/api/v1/repositories/\\d+/hook-state', status: 403 }],
    },
  ] satisfies Array<Omit<ScreenRow, 'story' | 'role' | 'modes'>>
).map((r): ScreenRow => ({
  ...r,
  story: 'tour-08',
  role: 'non-member',
  modes: A,
  negative: true,
}));

// ---------------------------------------------------------------------------------------------
// Story 9 — help articles, notifications, the disclosure and consent gates (06 §2.3 #9, §1.9).
// `expectText` of a help row is the article's first `#` heading (the meta-test checks it).
// ---------------------------------------------------------------------------------------------
const HELP_ARTICLES: Array<[string, string]> = [
  ['install-server', 'Install the server'],
  ['install-hook', 'Install Telemetry Hook'],
  ['getting-started', 'Your first session'],
  ['authentication-modes', 'Authentication modes'],
  ['server-configuration', 'Server settings'],
  ['trust-model', 'Trust model'],
  ['how-hook-works', 'How the Telemetry Hook Works'],
  ['data-collection-notice', 'Data Collection Notice'],
  ['connect-repository', 'Connecting a Repository'],
  ['session-list', 'Working with the Session List'],
  ['session-log', 'Session Log'],
  ['analytics-reports', 'Analytics & Reports'],
  ['cost-and-context', 'Understanding Cost & Context'],
  ['tuning-your-setup', 'Tuning Your Setup'],
  ['data-collection', 'Data Collection & Upload'],
  ['component-reference', 'Artisyn Log Hub — Component Reference'],
  ['security-hardening', 'Artisyn Log Hub — Security Hardening & Configuration Guide'],
  ['responsibility-matrix', 'Artisyn Log Hub — Responsibility Matrix (RACI)'],
  ['third-party-components', 'Third-Party Components & Licenses'],
  ['changelog', 'Changelog'],
];

/** Pages whose source is not `user-docs/<slug>.md` (nav.json `source`, DD-2). */
const HELP_SOURCE: Record<string, string> = {
  'install-hook': 'hook/INSTALL_HOOK.md',
  'how-hook-works': 'hook/HOW_HOOK_WORKS.md',
};

const HELP_ROWS: ScreenRow[] = HELP_ARTICLES.map(([slug, h1]): ScreenRow => ({
  id: `help.${slug}`,
  story: 'tour-09',
  route: '/main',
  covers: [`help:${slug}`],
  role: 'regular',
  modes: A,
  title: `Help article: ${h1}`,
  expectText: h1,
  forbidText: ['Article not found.', '<!doctype'],
  docRef: { file: HELP_SOURCE[slug] ?? `${HELP}/${slug}.md` },
}));

const GATE_ROWS: ScreenRow[] = [
  {
    id: 'notifications.bell',
    story: 'tour-09',
    route: '/main',
    role: 'regular',
    modes: A,
    title: 'Notification bell: a pending team invitation with Accept / Decline',
    expectText: '{teamName}',
  },
  {
    id: 'team.disclosure-gate',
    story: 'tour-09',
    route: '/main',
    role: 'forced',
    modes: A,
    title: 'Disclosure gate: added to a team without Accept, the disclosure is shown at login',
    expectTestId: 'team-disclosure-modal',
  },
  {
    id: 'consent.gate',
    story: 'tour-09',
    route: '/api-keys',
    role: 'fresh',
    modes: A,
    title: 'Data-collection notice: a deep link shows only the consent screen',
    expectTestId: 'data-collection-consent-screen',
    forbidText: ['Full Auto Install'],
    docRef: { file: `${HELP}/data-collection-notice.md` },
    screenshot: true,
  },
];

export const SCREEN_REGISTRY: readonly ScreenRow[] = [
  ...ANON_ROWS,
  ...ADMIN_ROWS,
  ...OWNER_REPO_ROWS,
  ...ANALYTICS_ROWS,
  ...REPORT_ROWS,
  TOOLS_REPO_ROW,
  OKF_REPO_ROW,
  ...SESSION_ROWS,
  ...TEAM_OWNER_ROWS,
  ...MEMBER_ROWS,
  ...NON_MEMBER_ROWS,
  ...HELP_ROWS,
  ...GATE_ROWS,
];

/** The rows one story walks in one stand mode, in registry order. */
export function rowsFor(story: TourId, mode: RegistryMode): ScreenRow[] {
  return SCREEN_REGISTRY.filter((r) => r.story === story && r.modes.includes(mode));
}

/** A row by id; throws on an unknown id (a tour referring to a removed row). */
export function rowById(id: string): ScreenRow {
  const row = SCREEN_REGISTRY.find((r) => r.id === id);
  if (!row) throw new Error(`screen-registry has no row "${id}"`);
  return row;
}

/** What a row covers for the meta-test: `route:<pattern>`, `tab:<group>:<id>` and its `covers`. */
export function coverageKeys(row: ScreenRow): string[] {
  const keys = [`route:${row.route}`];
  if (row.tab) keys.push(`tab:${row.tab.group}:${row.tab.id}`);
  return [...keys, ...(row.covers ?? [])];
}

/** `{name}` placeholders and `:name` route params a row uses. */
export function rowParams(row: ScreenRow): string[] {
  const names = new Set<string>();
  for (const m of row.route.matchAll(/:([A-Za-z]+)/g)) names.add(m[1]);
  const templated = [row.query, row.expectText, row.expectUrl, ...(row.forbidText ?? [])];
  for (const text of templated) {
    if (!text) continue;
    for (const m of text.matchAll(/\{([A-Za-z]+)\}/g)) names.add(m[1]);
  }
  return [...names];
}
