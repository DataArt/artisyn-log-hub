// "world-v1": the contract suite's one deterministic data set
// (docs/qaa-overview/scenarios/05 §2.3, lines 340-347).
//
// Inserted with raw SQL — never through the API under test — with explicit ids and fixed dates,
// after which every serial sequence is moved to 1000, so a row the API creates during a case
// (id > 1000) is always told apart from a world row (id < 1000).
//
// Numbers are chosen to be readable: model `world-model-a` costs 1 / 2 / 0.5 / 1.25 / 2 USD per
// 1M input / output / cache-read / cache-write-5m / cache-write-1h tokens, so session w1-s01
// (1,000,000 in, 250,000 out, 200,000 cache-read, 100,000 cache-write-5m) costs exactly
// 1 + 0.5 + 0.1 + 0.125 = 1.725 USD. The per-session token totals in `session_stats` are summed
// from the very turns that make up the session's `claude` log body below.
//
// No imports from src/**: the world must not depend on the code it is checking.
import type { Queryable } from '../oracle';
import { ident } from '../oracle';

/** Plain password of every world user (the policy is irrelevant: it is only ever verified). */
export const WORLD_V1_PASSWORD = 'contract-world-v1-password';

/** argon2id of `WORLD_V1_PASSWORD` (m=19, t=2, p=1 — the parameters the server hashes with). */
const PASSWORD_HASH =
  '$argon2id$v=19$m=19,t=2,p=1$6HMAknF3szeFkcUZ1A+GlA$QqYiZdC73441a+hOXcRGc9fzmkw+sqHa79szU959AZM';

/** Ids and natural keys of everything the world inserts; registry rows reference these. */
export const WORLD_V1 = {
  users: {
    admin: { id: 1, email: 'admin@arrakis.test', role: 'admin' },
    owner: { id: 2, email: 'owner@arrakis.test', role: 'user' },
    member: { id: 3, email: 'member@arrakis.test', role: 'user' },
    outsider: { id: 4, email: 'outsider@arrakis.test', role: 'user' },
    author: { id: 5, email: 'author@arrakis.test', role: 'user' },
    pending: { id: 6, email: 'pending@arrakis.test', role: 'user' },
    manager: { id: 7, email: 'manager@arrakis.test', role: 'user' },
  },
  apiKeys: {
    ownerKey: {
      id: 1,
      userId: 2,
      name: 'owner-key',
      slug: 'ownr01',
      key: 'ownr01-world01',
    },
    ownerCiKey: {
      id: 2,
      userId: 2,
      name: 'owner-ci-key',
      slug: 'ownr02',
      key: 'ownr02-world02',
    },
    memberKey: {
      id: 3,
      userId: 3,
      name: 'member-key',
      slug: 'mmbr01',
      key: 'mmbr01-world01',
    },
    authorKey: {
      id: 4,
      userId: 5,
      name: 'author-key',
      slug: 'athr01',
      key: 'athr01-world01',
    },
  },
  teams: {
    T1: { id: 1, name: 'T1 Fremen', ownerId: 2, accessMode: 'transparent' },
    T2: { id: 2, name: 'T2 Atreides', ownerId: 2, accessMode: 'restricted' },
  },
  repos: {
    /** The main repository: owner's row, linked to T1 and T2. */
    R1: { id: 1, userId: 2, url: 'https://github.com/arrakis/spice-harvester' },
    /** Owner's repository without a single log. */
    R2: { id: 2, userId: 2, url: 'https://github.com/arrakis/empty-sietch' },
    /** The outsider's repository. */
    R3: { id: 3, userId: 4, url: 'https://github.com/harkonnen/foreign' },
    /** The author's own row for the R1 url (repository rows are per user). */
    R1author: {
      id: 4,
      userId: 5,
      url: 'https://github.com/arrakis/spice-harvester',
    },
    /** The member's own row for the R1 url. */
    R1member: {
      id: 5,
      userId: 3,
      url: 'https://github.com/arrakis/spice-harvester',
    },
    /**
     * Owner's repo used only to prove DD-11's orphan-session sweep (05 §F12 chunk 13): linked
     * to exactly one team (T1, link id 4), with one log whose session (s09) has nothing else
     * keeping it alive, so removing the team link deletes the repo, the log, the now-orphaned
     * session and (via `deleteOrphanHarnessSnapshots`) the harness_snapshots row s09 is bound to.
     */
    Rorphan: {
      id: 6,
      userId: 2,
      url: 'https://github.com/arrakis/orphan-outpost',
    },
  },
  sessions: {
    s01: { id: 1, sessionId: 'w1-s01-plain' },
    s02: { id: 2, sessionId: 'w1-s02-parent' },
    s03: { id: 3, sessionId: 'w1-s03-child' },
    s04: { id: 4, sessionId: 'w1-s04-favorite' },
    s05: { id: 5, sessionId: 'w1-s05-deleted' },
    s06: { id: 6, sessionId: 'w1-s06-member' },
    s07: { id: 7, sessionId: 'w1-s07-author' },
    s08: { id: 8, sessionId: 'w1-s08-outsider' },
    /** Rorphan's only session (05 §F12 chunk 13); see Rorphan's comment above. */
    s09: { id: 9, sessionId: 'w1-s09-orphan' },
    s10: { id: 10, sessionId: 'w1-s10-member-claude-only' },
  },
  models: {
    a: 'world-model-a',
    b: 'world-model-b',
    unpriced: 'world-model-unpriced',
    /** Priced by the Anthropic fetch (source 'anthropic'); used by no session. */
    fetched: 'world-model-fetched',
    /** An active admin override over a fetched base; used by no session. */
    overridden: 'world-model-overridden',
  },
  pendingConfirmationToken: 'world-v1-confirm-token-pending',
  /** An unused password-reset token of the author (05 §F02 reset-password). */
  authorResetToken: 'world-v1-reset-token-author',
  /** DD-2 id of the harness_snapshots row s04's owner is bound to (05 §F15/F17/F18 chunk 13). */
  harnessSnapshotId: 'b'.repeat(64),
  /** DD-2 id of the harness_snapshots row bound only to the orphan session s09 (05 §F12 chunk 13). */
  harnessSnapshotIdOrphan: 'c'.repeat(64),
  /**
   * OKF snapshot id s02 (the root of the s02 -> s03 tree) is bound to (2026-10-27 OKF usage
   * tab, F15/F16/F19/F21): one bundle `docs/kb` of three files, one of them gitignored.
   */
  okfSnapshotId: 'e'.repeat(64),
  /**
   * `session_tool_usage` rows (T-26 Tools/MCP tab, F24): s01 holds one MCP and one CLI row, s03
   * (s02's sub-agent) one MCP row, the member's s06 one CLI row, the outsider's s08 one MCP row.
   * `callIds` are the `calls[].callId` values the registry addresses.
   */
  toolUsage: {
    tuS01Mcp: { id: 1, callA: 'w1-q1', callB: 'w1-q2' },
    tuS01Cli: { id: 2, callA: 'w1-c1' },
    tuS03Mcp: { id: 3, callA: 'w1-q3' },
    tuS06Cli: { id: 4, callA: 'w1-c2' },
    tuS08Mcp: { id: 5, callA: 'w1-g1' },
  },
  /** Export/import jobs of R1 (05 §F23); none has a file on disk. */
  jobs: {
    exportDone: { id: 'w1-job-export-done' },
    exportRunning: { id: 'w1-job-export-running' },
    importDone: { id: 'w1-job-import-done' },
    /**
     * A staged upload whose import was refused (status `error`): both confirm routes answer 404
     * with its `error_message` instead of the generic "never staged" text.
     */
    stagedError: {
      id: 'w1-staged-error.zip',
      errorMessage:
        "Import blocked: 1 session(s) in this archive conflict with another user's data: w1-x. Nothing was imported.",
    },
  },
} as const;

/**
 * Flat `name.field` -> value map for `@ref` placeholders in registry rows: `@owner.id`,
 * `@owner.email`, `@ownerKey.key`, `@R1.id`, `@T1.id`, `@s01.sessionId`, `@models.a`, ...
 */
export const WORLD_V1_REFS: Readonly<Record<string, string | number>> = (() => {
  const refs: Record<string, string | number> = {};
  const groups = [
    WORLD_V1.users,
    WORLD_V1.apiKeys,
    WORLD_V1.teams,
    WORLD_V1.repos,
    WORLD_V1.sessions,
    WORLD_V1.jobs,
    WORLD_V1.toolUsage,
  ] as const;
  for (const group of groups) {
    for (const [name, entry] of Object.entries(group)) {
      for (const [field, value] of Object.entries(
        entry as Record<string, string | number>,
      )) {
        refs[`${name}.${field}`] = value;
      }
    }
  }
  for (const [name, value] of Object.entries(WORLD_V1.models)) {
    refs[`models.${name}`] = value;
  }
  refs['pendingConfirmationToken'] = WORLD_V1.pendingConfirmationToken;
  refs['authorResetToken'] = WORLD_V1.authorResetToken;
  refs['harnessSnapshotId'] = WORLD_V1.harnessSnapshotId;
  refs['harnessSnapshotIdOrphan'] = WORLD_V1.harnessSnapshotIdOrphan;
  refs['okfSnapshotId'] = WORLD_V1.okfSnapshotId;
  // Every world user's password hash, so a row can prove a password-changing call replaced it.
  refs['worldPasswordHash'] = PASSWORD_HASH;
  return refs;
})();

/** Value every serial sequence is set to after loading (the next generated id is 1001). */
export const WORLD_V1_SEQUENCE_FLOOR = 1000;

// -------------------------------------------------------------------------------------------
// Log bodies

interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

interface Turn {
  prompt: string;
  at: string;
  answeredAt: string;
  model: string;
  usage: Usage;
}

interface SessionSpec {
  key: keyof typeof WORLD_V1.sessions;
  userId: number;
  repoId: number;
  repoUrl: string;
  branch: string;
  start: string;
  end: string;
  /** No artisyn log (child session / transcript-only upload). */
  noArtisyn?: boolean;
  turns: Turn[];
}

const ROOT = '/work/spice-harvester';

function artisynBody(s: SessionSpec): unknown[] {
  const sessionId = WORLD_V1.sessions[s.key].sessionId;
  const git = {
    repo: s.repoUrl,
    root: ROOT,
    worktreeRoot: ROOT,
    branch: s.branch,
    user: 'World Tester',
  };
  return [
    {
      type: 'artisyn',
      hook_event_name: 'SessionStart',
      timestamp: s.start,
      session_id: sessionId,
      git,
    },
    ...s.turns.map((t) => ({
      event: 'prompt_start',
      timestamp: t.at,
      session_id: sessionId,
      prompt: t.prompt,
      git,
    })),
    {
      type: 'artisyn',
      hook_event_name: 'SessionEnd',
      timestamp: s.end,
      session_id: sessionId,
    },
  ];
}

function claudeBody(s: SessionSpec): unknown[] {
  const sessionId = WORLD_V1.sessions[s.key].sessionId;
  const common = {
    sessionId,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: ROOT,
    gitBranch: s.branch,
    version: '2.1.99',
  };
  const lines: unknown[] = [];
  s.turns.forEach((t, i) => {
    const n = i + 1;
    lines.push({
      type: 'user',
      uuid: `${s.key}-u${n}`,
      parentUuid: i === 0 ? null : `${s.key}-a${i}`,
      timestamp: t.at,
      ...common,
      promptId: `${s.key}-p${n}`,
      message: { role: 'user', content: t.prompt },
    });
    lines.push({
      type: 'assistant',
      uuid: `${s.key}-a${n}`,
      parentUuid: `${s.key}-u${n}`,
      timestamp: t.answeredAt,
      ...common,
      requestId: `req_${s.key}_${n}`,
      message: {
        id: `msg_${s.key}_${n}`,
        type: 'message',
        role: 'assistant',
        model: t.model,
        content: [{ type: 'text', text: `Done: ${t.prompt}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: t.usage.input,
          output_tokens: t.usage.output,
          cache_read_input_tokens: t.usage.cacheRead ?? 0,
          cache_creation_input_tokens:
            (t.usage.cacheWrite5m ?? 0) + (t.usage.cacheWrite1h ?? 0),
          cache_creation: {
            ephemeral_5m_input_tokens: t.usage.cacheWrite5m ?? 0,
            ephemeral_1h_input_tokens: t.usage.cacheWrite1h ?? 0,
          },
          service_tier: 'standard',
        },
      },
    });
  });
  return lines;
}

function totals(s: SessionSpec) {
  const sum = (f: (u: Usage) => number) =>
    s.turns.reduce((acc, t) => acc + f(t.usage), 0);
  const cacheWrite5m = sum((u) => u.cacheWrite5m ?? 0);
  const cacheWrite1h = sum((u) => u.cacheWrite1h ?? 0);
  return {
    input: sum((u) => u.input),
    output: sum((u) => u.output),
    cacheRead: sum((u) => u.cacheRead ?? 0),
    cacheWrite: cacheWrite5m + cacheWrite1h,
    cacheWrite5m,
    cacheWrite1h,
  };
}

const R = WORLD_V1.repos;
const U = WORLD_V1.users;
const M = WORLD_V1.models;

/**
 * Minimal DD-1 `harness-snapshot` body bound to s04's owner (05 §F15/F17/F18 chunk 13): one
 * skill of each `source`, no agents/MCP/systemContext — enough to prove the read path (F17)
 * returns the stored body verbatim and the retention path (F18) deletes it with its session.
 */
const HARNESS_SNAPSHOT_BODY = {
  snapshotId: WORLD_V1.harnessSnapshotId,
  schemaVersion: 1,
  perToolDetailSupported: true,
  skills: [
    {
      name: 'deploy',
      kind: 'skill',
      source: 'project',
      description: 'Deploy the app',
      body: '# Deploy\n\nDeploy steps.',
      path: '.claude/skills/deploy/SKILL.md',
      bytes: 24,
      contentHash: '1'.repeat(64),
    },
    {
      name: 'notes',
      kind: 'skill',
      source: 'user',
      description: 'Personal scratch notes',
      body: '# Notes',
      path: '~/.claude/skills/notes/SKILL.md',
      bytes: 7,
      contentHash: '2'.repeat(64),
    },
    {
      name: 'adlc-lh:tracker',
      kind: 'skill',
      source: 'plugin',
      description: 'Task tracker',
      body: '# Tracker',
      path: 'adlc-lh@1.3.1/skills/tracker/SKILL.md',
      bytes: 9,
      contentHash: '3'.repeat(64),
      plugin: {
        id: 'adlc-lh@artisyn',
        name: 'adlc-lh',
        marketplace: 'artisyn',
        version: '1.3.1',
      },
    },
  ],
  agents: [] as unknown[],
  mcpServers: [] as unknown[],
  systemContext: null,
};

/** Minimal DD-1 body bound only to the orphan session s09 (05 §F12 chunk 13). */
/**
 * The OKF snapshot (impl-plan DD-13) s02 is bound to: one bundle `docs/kb` with its index, a
 * scheduler article and a gitignored private article. A team view drops the ignored file
 * (DD-30); the personal view keeps it.
 */
const OKF_SNAPSHOT_BODY = {
  type: 'okf-snapshot',
  okfSnapshotId: WORLD_V1.okfSnapshotId,
  schemaVersion: 1,
  bundles: [
    {
      root: 'docs/kb',
      index: 'docs/kb/index.md',
      ignored: false,
      files: [
        {
          path: 'docs/kb/index.md',
          ignored: false,
          size: 400,
          hash: '1'.repeat(64),
        },
        {
          path: 'docs/kb/private.md',
          ignored: true,
          size: 800,
          hash: '2'.repeat(64),
        },
        {
          path: 'docs/kb/scheduler.md',
          ignored: false,
          size: 2000,
          hash: '3'.repeat(64),
        },
      ],
    },
  ],
};

const HARNESS_SNAPSHOT_BODY_ORPHAN = {
  snapshotId: WORLD_V1.harnessSnapshotIdOrphan,
  schemaVersion: 1,
  perToolDetailSupported: false,
  skills: [] as unknown[],
  agents: [] as unknown[],
  mcpServers: [] as unknown[],
  systemContext: null,
};

/** Every session that has logs (w1-s05 is deleted: no logs, only its audit row). */
const SESSIONS: SessionSpec[] = [
  {
    key: 's01',
    userId: U.owner.id,
    repoId: R.R1.id,
    repoUrl: R.R1.url,
    branch: 'main',
    start: '2026-01-10T10:00:00.000Z',
    end: '2026-01-10T10:30:00.000Z',
    turns: [
      {
        prompt: 'Add a spice-yield endpoint',
        at: '2026-01-10T10:00:00.000Z',
        answeredAt: '2026-01-10T10:05:00.000Z',
        model: M.a,
        usage: { input: 400_000, output: 100_000, cacheWrite5m: 100_000 },
      },
      {
        prompt: 'Document the endpoint',
        at: '2026-01-10T10:20:00.000Z',
        answeredAt: '2026-01-10T10:30:00.000Z',
        model: M.a,
        usage: { input: 600_000, output: 150_000, cacheRead: 200_000 },
      },
    ],
  },
  {
    key: 's02',
    userId: U.owner.id,
    repoId: R.R1.id,
    repoUrl: R.R1.url,
    branch: 'main',
    start: '2026-01-11T09:00:00.000Z',
    end: '2026-01-11T09:45:00.000Z',
    turns: [
      {
        prompt: 'Refactor the harvester scheduler',
        at: '2026-01-11T09:00:00.000Z',
        answeredAt: '2026-01-11T09:45:00.000Z',
        model: M.b,
        usage: { input: 500_000, output: 50_000, cacheWrite1h: 50_000 },
      },
    ],
  },
  {
    key: 's03',
    userId: U.owner.id,
    repoId: R.R1.id,
    repoUrl: R.R1.url,
    branch: 'main',
    noArtisyn: true,
    start: '2026-01-11T09:10:00.000Z',
    end: '2026-01-11T09:20:00.000Z',
    turns: [
      {
        prompt: 'Write the scheduler health check',
        at: '2026-01-11T09:10:00.000Z',
        answeredAt: '2026-01-11T09:20:00.000Z',
        model: M.a,
        usage: { input: 200_000, output: 100_000 },
      },
    ],
  },
  {
    key: 's04',
    userId: U.owner.id,
    repoId: R.R1.id,
    repoUrl: R.R1.url,
    branch: 'feature/sandworm',
    start: '2026-01-12T14:00:00.000Z',
    end: '2026-01-12T14:20:00.000Z',
    turns: [
      {
        prompt: 'Sketch the sandworm detector',
        at: '2026-01-12T14:00:00.000Z',
        answeredAt: '2026-01-12T14:20:00.000Z',
        model: M.a,
        usage: { input: 100_000, output: 50_000, cacheRead: 400_000 },
      },
    ],
  },
  {
    key: 's06',
    userId: U.member.id,
    repoId: R.R1member.id,
    repoUrl: R.R1member.url,
    branch: 'main',
    start: '2026-01-13T08:00:00.000Z',
    end: '2026-01-13T08:15:00.000Z',
    turns: [
      {
        prompt: 'Translate the stillsuit manual',
        at: '2026-01-13T08:00:00.000Z',
        answeredAt: '2026-01-13T08:15:00.000Z',
        model: M.unpriced,
        usage: { input: 300_000, output: 30_000 },
      },
    ],
  },
  {
    key: 's10',
    userId: U.member.id,
    repoId: R.R1member.id,
    repoUrl: R.R1member.url,
    branch: 'main',
    noArtisyn: true,
    start: '2026-01-13T09:00:00.000Z',
    end: '2026-01-13T09:05:00.000Z',
    turns: [
      {
        prompt: 'Quick question about water rings',
        at: '2026-01-13T09:00:00.000Z',
        answeredAt: '2026-01-13T09:05:00.000Z',
        model: M.a,
        usage: { input: 50_000, output: 5_000 },
      },
    ],
  },
  {
    key: 's07',
    userId: U.author.id,
    repoId: R.R1author.id,
    repoUrl: R.R1author.url,
    branch: 'main',
    start: '2026-01-13T11:00:00.000Z',
    end: '2026-01-13T11:10:00.000Z',
    turns: [
      {
        prompt: 'Fix the typo in the README',
        at: '2026-01-13T11:00:00.000Z',
        answeredAt: '2026-01-13T11:10:00.000Z',
        model: M.a,
        usage: { input: 250_000, output: 25_000 },
      },
    ],
  },
  {
    key: 's08',
    userId: U.outsider.id,
    repoId: R.R3.id,
    repoUrl: R.R3.url,
    branch: 'main',
    start: '2026-01-14T16:00:00.000Z',
    end: '2026-01-14T16:05:00.000Z',
    turns: [
      {
        prompt: 'Plan the harvester raid',
        at: '2026-01-14T16:00:00.000Z',
        answeredAt: '2026-01-14T16:05:00.000Z',
        model: M.b,
        usage: { input: 100_000, output: 10_000 },
      },
    ],
  },
];

// -------------------------------------------------------------------------------------------
// Statements

/** A jsonb parameter (node-postgres would turn a JS array into a Postgres array otherwise). */
class Json {
  constructor(readonly value: unknown) {}
}
const json = (value: unknown) => new Json(value);

export interface WorldStatement {
  sql: string;
  params: unknown[];
}

function insert(
  table: string,
  columns: string[],
  rows: unknown[][],
): WorldStatement {
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    if (row.length !== columns.length) {
      throw new Error(
        `world-v1: ${table} row has ${row.length} values for ${columns.length} columns`,
      );
    }
    return `(${row
      .map((v) => {
        params.push(v instanceof Json ? JSON.stringify(v.value) : v);
        return `$${params.length}`;
      })
      .join(', ')})`;
  });
  return {
    sql: `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES ${tuples.join(', ')}`,
    params,
  };
}

function buildStatements(): WorldStatement[] {
  const out: WorldStatement[] = [];

  out.push(
    insert(
      'users',
      [
        'id',
        'email',
        'password_hash',
        'role',
        'created_at',
        'email_confirmed_at',
      ],
      [
        [
          U.admin.id,
          U.admin.email,
          PASSWORD_HASH,
          'admin',
          '2026-01-01T09:00:00.000Z',
          '2026-01-01T09:01:00.000Z',
        ],
        [
          U.owner.id,
          U.owner.email,
          PASSWORD_HASH,
          'user',
          '2026-01-01T09:10:00.000Z',
          '2026-01-01T09:11:00.000Z',
        ],
        [
          U.member.id,
          U.member.email,
          PASSWORD_HASH,
          'user',
          '2026-01-01T09:20:00.000Z',
          '2026-01-01T09:21:00.000Z',
        ],
        [
          U.outsider.id,
          U.outsider.email,
          PASSWORD_HASH,
          'user',
          '2026-01-01T09:30:00.000Z',
          '2026-01-01T09:31:00.000Z',
        ],
        [
          U.author.id,
          U.author.email,
          PASSWORD_HASH,
          'user',
          '2026-01-01T09:40:00.000Z',
          '2026-01-01T09:41:00.000Z',
        ],
        [
          U.pending.id,
          U.pending.email,
          PASSWORD_HASH,
          'user',
          '2026-01-09T12:00:00.000Z',
          null,
        ],
        [
          U.manager.id,
          U.manager.email,
          PASSWORD_HASH,
          'user',
          '2026-01-01T09:50:00.000Z',
          '2026-01-01T09:51:00.000Z',
        ],
      ],
    ),
  );

  out.push(
    insert(
      'email_confirmation_tokens',
      ['id', 'user_id', 'token', 'expires_at', 'consumed_at', 'created_at'],
      [
        [
          1,
          U.pending.id,
          WORLD_V1.pendingConfirmationToken,
          '2099-01-01T00:00:00.000Z',
          null,
          '2026-01-09T12:00:00.000Z',
        ],
      ],
    ),
  );

  out.push(
    insert(
      'password_reset_tokens',
      ['id', 'user_id', 'token', 'created_at', 'expires_at', 'used_at'],
      [
        [
          1,
          U.author.id,
          WORLD_V1.authorResetToken,
          '2026-01-09T13:00:00.000Z',
          '2099-01-01T00:00:00.000Z',
          null,
        ],
      ],
    ),
  );

  out.push(
    insert(
      'user_settings',
      ['user_id', 'setting_name', 'setting_value'],
      [
        [U.owner.id, 'theme', 'dark'],
        [U.owner.id, 'viewer.density', 'compact'],
        [U.member.id, 'theme', 'light'],
      ],
    ),
  );

  const K = WORLD_V1.apiKeys;
  out.push(
    insert(
      'api_keys',
      ['id', 'user_id', 'name', 'slug', 'key_hash', 'created_at', 'expires_at'],
      [
        [
          K.ownerKey.id,
          K.ownerKey.userId,
          K.ownerKey.name,
          K.ownerKey.slug,
          '$argon2id$v=19$m=19,t=2,p=1$PlWWrt8D9S5qiShfNzJOog$VbPZ7hUxMB9K6NJPvQJFBTbx0sQ7qKnKyUFgfOl82jQ',
          '2026-01-02T08:00:00.000Z',
          null,
        ],
        [
          K.ownerCiKey.id,
          K.ownerCiKey.userId,
          K.ownerCiKey.name,
          K.ownerCiKey.slug,
          '$argon2id$v=19$m=19,t=2,p=1$fSiP+zylxxCWt3ozloM8ig$/AeONw4i8oxa188A0uEEdo+s9KD/2O7tF0By597w9wA',
          '2026-01-02T08:30:00.000Z',
          '2099-01-01T00:00:00.000Z',
        ],
        [
          K.memberKey.id,
          K.memberKey.userId,
          K.memberKey.name,
          K.memberKey.slug,
          '$argon2id$v=19$m=19,t=2,p=1$8Y83UbIX+bXxX6Oq1KWw2Q$yHdqlDrh6NzrNSmiEFz3CI6v3ZTRzWcaD422Hc+d7rY',
          '2026-01-02T09:00:00.000Z',
          null,
        ],
        [
          K.authorKey.id,
          K.authorKey.userId,
          K.authorKey.name,
          K.authorKey.slug,
          '$argon2id$v=19$m=19,t=2,p=1$eKB9vN0hIyInN9eVPukU9Q$coVlh/+c4+tIj/RrlInP9pUk5VtW0fcJ5sP5hivv7xo',
          '2026-01-02T09:30:00.000Z',
          null,
        ],
      ],
    ),
  );

  const T = WORLD_V1.teams;
  out.push(
    insert(
      'teams',
      ['id', 'name', 'owner_id', 'created_at', 'access_mode'],
      [
        [
          T.T1.id,
          T.T1.name,
          T.T1.ownerId,
          '2026-01-02T10:00:00.000Z',
          T.T1.accessMode,
        ],
        [
          T.T2.id,
          T.T2.name,
          T.T2.ownerId,
          '2026-01-02T10:30:00.000Z',
          T.T2.accessMode,
        ],
      ],
    ),
  );
  // The member sits in two teams (T1, T2) and owns three logs, so a LEFT JOIN product in an
  // admin aggregate shows up as 2 x 3 instead of the true counts (05 §F08).
  out.push(
    insert(
      'team_members',
      [
        'team_id',
        'user_id',
        'can_invite',
        'is_manager',
        'is_adlc_trainer',
        'disclosure_acknowledged_at',
        'joined_at',
      ],
      [
        [
          T.T1.id,
          U.owner.id,
          true,
          false,
          false,
          '2026-01-02T10:00:00.000Z',
          '2026-01-02T10:00:00.000Z',
        ],
        [
          T.T1.id,
          U.member.id,
          true,
          false,
          true,
          '2026-01-03T10:00:00.000Z',
          '2026-01-03T09:00:00.000Z',
        ],
        [
          T.T2.id,
          U.owner.id,
          true,
          false,
          false,
          '2026-01-02T10:30:00.000Z',
          '2026-01-02T10:30:00.000Z',
        ],
        [
          T.T2.id,
          U.member.id,
          false,
          false,
          false,
          null,
          '2026-01-03T09:30:00.000Z',
        ],
        [
          T.T2.id,
          U.manager.id,
          false,
          true,
          false,
          '2026-01-04T10:00:00.000Z',
          '2026-01-04T09:00:00.000Z',
        ],
      ],
    ),
  );
  out.push(
    insert(
      'invitations',
      ['id', 'team_id', 'inviter_id', 'invitee_id', 'status', 'created_at'],
      [
        [
          1,
          T.T1.id,
          U.owner.id,
          U.outsider.id,
          'pending',
          '2026-01-05T10:00:00.000Z',
        ],
        [
          2,
          T.T2.id,
          U.owner.id,
          U.author.id,
          'declined',
          '2026-01-05T11:00:00.000Z',
        ],
      ],
    ),
  );

  out.push(
    insert(
      'repositories',
      [
        'id',
        'repo_url',
        'user_id',
        'max_upload_bytes',
        'hook_version',
        'hook_last_activity',
        'hook_log_tail',
        'hook_non_uploadable_logs',
        'hook_recommendations',
        'harness_inventory_reported_at',
        'harness_mcp_per_tool_supported',
      ],
      [
        [
          R.R1.id,
          R.R1.url,
          R.R1.userId,
          4096,
          '2.20.0',
          '2026-01-12T14:20:00.000Z',
          json([
            '2026-01-12T14:20:00Z upload ok w1-s04-favorite',
            '2026-01-12T14:20:01Z idle',
          ]),
          json([
            {
              file: 'C:/Users/owner/.claude/projects/huge.jsonl',
              reason: 'too-large',
            },
          ]),
          json([
            {
              rule: 'update-hook',
              message: 'A newer hook is available',
              detectedAt: '2026-01-12T14:20:00.000Z',
            },
          ]),
          '2026-01-12T14:00:00.000Z',
          true,
        ],
        [
          R.R2.id,
          R.R2.url,
          R.R2.userId,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
        [
          R.R3.id,
          R.R3.url,
          R.R3.userId,
          1024,
          '2.19.0',
          '2026-01-14T16:05:00.000Z',
          null,
          null,
          null,
          null,
          null,
        ],
        [
          R.R1author.id,
          R.R1author.url,
          R.R1author.userId,
          2048,
          '2.20.0',
          '2026-01-13T11:10:00.000Z',
          null,
          null,
          null,
          null,
          null,
        ],
        [
          R.R1member.id,
          R.R1member.url,
          R.R1member.userId,
          2048,
          '2.20.0',
          '2026-01-13T09:05:00.000Z',
          null,
          null,
          null,
          null,
          null,
        ],
        [
          R.Rorphan.id,
          R.Rorphan.url,
          R.Rorphan.userId,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      ],
    ),
  );
  out.push(
    insert(
      'team_repositories',
      ['id', 'team_id', 'repo_url', 'added_at'],
      [
        [1, T.T1.id, R.R1.url, '2026-01-02T11:00:00.000Z'],
        [2, T.T2.id, R.R1.url, '2026-01-02T11:30:00.000Z'],
        [3, T.T1.id, R.R2.url, '2026-01-02T12:00:00.000Z'],
        // T1's only link to Rorphan (05 §F12 chunk 13): removing it has no other team
        // reference left, so the repo, its one log and the now-orphaned session s09 go too.
        [4, T.T1.id, R.Rorphan.url, '2026-01-02T12:15:00.000Z'],
      ],
    ),
  );

  // Sessions: s05 is soft-deleted (its data is gone, only the audit row remains, exactly as
  // SessionsService.deleteSession leaves it); s03 is s02's child. harness_snapshot_id: only s04
  // (HARNESS_SNAPSHOT_BODY) and s09 (HARNESS_SNAPSHOT_BODY_ORPHAN) are bound (05 §F17/F18/F12
  // chunk 13); every other session predates the snapshot feature and stays NULL.
  const S = WORLD_V1.sessions;
  out.push(
    insert(
      'sessions',
      [
        'id',
        'session_id',
        'parent_session_id',
        'workflow_run_id',
        'deleted',
        'harness_snapshot_id',
        'okf_snapshot_id',
      ],
      [
        [S.s01.id, S.s01.sessionId, null, null, false, null, null],
        [
          S.s02.id,
          S.s02.sessionId,
          null,
          null,
          false,
          null,
          WORLD_V1.okfSnapshotId,
        ],
        [S.s03.id, S.s03.sessionId, S.s02.sessionId, null, false, null, null],
        [
          S.s04.id,
          S.s04.sessionId,
          null,
          null,
          false,
          WORLD_V1.harnessSnapshotId,
          null,
        ],
        [S.s05.id, S.s05.sessionId, null, null, true, null, null],
        [S.s06.id, S.s06.sessionId, null, null, false, null, null],
        [S.s07.id, S.s07.sessionId, null, null, false, null, null],
        [S.s08.id, S.s08.sessionId, null, null, false, null, null],
        [
          S.s09.id,
          S.s09.sessionId,
          null,
          null,
          false,
          WORLD_V1.harnessSnapshotIdOrphan,
          null,
        ],
        [S.s10.id, S.s10.sessionId, null, null, false, null, null],
      ],
    ),
  );
  out.push(
    insert(
      'deleted_session_log',
      [
        'id',
        'session_id',
        'session_pk',
        'owner_user_id',
        'deleted_by_user_id',
        'deleted_at',
        'start_time',
        'end_time',
        'work_time_ms',
        'total_cost',
      ],
      [
        [
          1,
          S.s05.sessionId,
          S.s05.id,
          U.owner.id,
          U.owner.id,
          '2026-01-09T08:00:00.000Z',
          '2026-01-08T10:00:00.000Z',
          '2026-01-08T10:10:00.000Z',
          600_000,
          '0.50000000',
        ],
      ],
    ),
  );

  // Logs: artisyn + claude per session (ids 1..), each linked to its session's repository.
  const logRows: unknown[][] = [];
  const logRepoRows: unknown[][] = [];
  const logIdBySession: Record<string, { artisyn?: number; claude: number }> =
    {};
  let logId = 0;
  for (const s of SESSIONS) {
    const pk = S[s.key].id;
    const ids: { artisyn?: number; claude: number } = { claude: 0 };
    if (!s.noArtisyn) {
      logId += 1;
      ids.artisyn = logId;
      logRows.push([
        logId,
        s.end,
        s.end,
        pk,
        'artisyn',
        json(artisynBody(s)),
        s.userId,
        s.turns[0].prompt,
        s.start,
        s.end,
        s.branch,
        ROOT,
        ROOT,
      ]);
      logRepoRows.push([logId, s.repoId]);
    }
    logId += 1;
    ids.claude = logId;
    logRows.push([
      logId,
      s.end,
      s.end,
      pk,
      'claude',
      json(claudeBody(s)),
      s.userId,
      null,
      s.start,
      s.end,
      s.branch,
      null,
      null,
    ]);
    logRepoRows.push([logId, s.repoId]);
    logIdBySession[s.key] = ids;
  }
  // Orphan-session fixture (05 §F12 chunk 13): s09's one log, linked only to Rorphan. It is
  // not in SESSIONS (no session_stats/turns needed) — just enough for F08's admin aggregate and
  // the orphan-sweep delete path to see a real log/session to remove.
  logId += 1;
  const orphanLogId = logId;
  logRows.push([
    orphanLogId,
    '2026-01-15T10:00:00.000Z',
    '2026-01-15T10:00:00.000Z',
    S.s09.id,
    'artisyn',
    json([
      {
        type: 'artisyn',
        hook_event_name: 'SessionStart',
        timestamp: '2026-01-15T10:00:00.000Z',
        session_id: S.s09.sessionId,
      },
    ]),
    U.owner.id,
    'Orphan-session fixture',
    '2026-01-15T10:00:00.000Z',
    '2026-01-15T10:00:00.000Z',
    'main',
    ROOT,
    ROOT,
  ]);
  logRepoRows.push([orphanLogId, R.Rorphan.id]);
  out.push(
    insert(
      'logs',
      [
        'id',
        'created_at',
        'updated_at',
        'session_id',
        'log_type',
        'body',
        'user_id',
        'first_prompt',
        'start_time',
        'end_time',
        'git_branch',
        'git_repo_root',
        'git_worktree_root',
      ],
      logRows,
    ),
  );
  out.push(insert('log_repositories', ['log_id', 'repo_id'], logRepoRows));

  out.push(
    insert(
      'contexts',
      ['id', 'context_key', 'context_value'],
      [
        [1, 'jira', 'ARR-1'],
        [2, 'jira', 'ARR-2'],
      ],
    ),
  );
  out.push(
    insert(
      'log_contexts',
      ['log_id', 'context_id'],
      [
        [logIdBySession.s01.artisyn, 1],
        [logIdBySession.s04.artisyn, 2],
      ],
    ),
  );

  // session_stats: token totals summed from the claude bodies above.
  const csBySession: Record<string, [number, number, number]> = {
    s01: [2, 2, 0],
    s03: [1, 1, 0],
  };
  const statsRows = SESSIONS.map((s) => {
    const t = totals(s);
    const durationMs = Date.parse(s.end) - Date.parse(s.start);
    const cs = csBySession[s.key];
    return [
      S[s.key].id,
      s.turns[0].model,
      t.input,
      t.output,
      t.cacheRead,
      t.cacheWrite,
      t.cacheWrite5m,
      t.cacheWrite1h,
      durationMs,
      s.key === 's01' ? 2 : 0,
      s.key === 's01' ? 15 : 0,
      s.key === 's01' ? 15 : 0,
      s.key === 's01' ? 2 : 0,
      s.key === 's01' ? 1 : 0,
      0,
      s.turns.length,
      json({
        standard: {
          input: t.input,
          output: t.output,
          cacheRead: t.cacheRead,
          cacheCreation: t.cacheWrite,
          cacheWrite5m: t.cacheWrite5m,
          cacheWrite1h: t.cacheWrite1h,
        },
      }),
      cs ? cs[0] : null,
      cs ? cs[1] : null,
      cs ? cs[2] : null,
      cs ? s.end : null,
      '2.1.99',
      s.end,
    ];
  });
  out.push(
    insert(
      'session_stats',
      [
        'session_id',
        'model',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'cache_write_5m_tokens',
        'cache_write_1h_tokens',
        'work_time_ms',
        'files_edited_written',
        'lines_changed',
        'lines_added',
        'lines_removed',
        'commit_count',
        'pr_count',
        'turn_count',
        'token_by_service_tier',
        'cs_changed_files',
        'cs_folders_touched',
        'cs_outside_repo_files',
        'cs_computed_at',
        'claude_version',
        'updated_at',
      ],
      statsRows,
    ),
  );
  out.push(
    insert(
      'session_request_ids',
      ['session_id', 'request_id'],
      SESSIONS.flatMap((s) =>
        s.turns.map((_t, i) => [S[s.key].id, `req_${s.key}_${i + 1}`]),
      ),
    ),
  );

  out.push(
    insert(
      'session_tool_stats',
      [
        'session_id',
        'tool_name',
        'calls',
        'failures',
        'unresolved',
        'duration_covered_calls',
        'duration_ms_total',
        'duration_ms_max',
        'duration_ms_histogram',
        'duration_by_source',
        'parallel_batch_calls',
      ],
      [
        [
          S.s01.id,
          'Read',
          2,
          0,
          0,
          2,
          300,
          200,
          json([0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
          json({}),
          0,
        ],
        [
          S.s01.id,
          'Edit',
          1,
          0,
          0,
          1,
          500,
          500,
          json([0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
          json({}),
          0,
        ],
        [
          S.s02.id,
          'Bash',
          1,
          1,
          0,
          1,
          4000,
          4000,
          json([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
          json({}),
          0,
        ],
      ],
    ),
  );

  out.push(
    insert(
      'session_changed_paths',
      [
        'session_id',
        'path_key',
        'raw_path',
        'rel_path',
        'rel_path_key',
        'folder',
        'folder_key',
        'top_module_key',
        'depth',
        'file_kind',
        'extension',
        'outside_repo',
        'change_kind',
        'edit_calls',
        'diff_covered_calls',
        'lines_added',
        'lines_removed',
      ],
      [
        [
          S.s01.id,
          `${ROOT}/src/app.ts`,
          `${ROOT}/src/app.ts`,
          'src/app.ts',
          'src/app.ts',
          'src',
          'src',
          'src',
          2,
          'source',
          'ts',
          false,
          'modified',
          1,
          1,
          10,
          2,
        ],
        [
          S.s01.id,
          `${ROOT}/docs/readme.md`,
          `${ROOT}/docs/readme.md`,
          'docs/readme.md',
          'docs/readme.md',
          'docs',
          'docs',
          'docs',
          2,
          'docs',
          'md',
          false,
          'added',
          1,
          1,
          5,
          0,
        ],
        [
          S.s03.id,
          `${ROOT}/src/health.ts`,
          `${ROOT}/src/health.ts`,
          'src/health.ts',
          'src/health.ts',
          'src',
          'src',
          'src',
          2,
          'source',
          'ts',
          false,
          'added',
          1,
          1,
          20,
          0,
        ],
      ],
    ),
  );
  out.push(
    insert(
      'session_file_stats',
      [
        'session_id',
        'category_name',
        'file_count',
        'byte_count',
        'team_id',
        'user_id',
      ],
      [
        [S.s01.id, 'Source', 1, 300, T.T1.id, null],
        [S.s01.id, 'Docs', 1, 120, null, U.owner.id],
      ],
    ),
  );
  out.push(
    insert(
      'repo_code_inventory',
      [
        'id',
        'repo_id',
        'captured_at',
        'branch',
        'commit_sha',
        'tracked_files',
        'tracked_lines',
        'tracked_binary_files',
        'created_at',
      ],
      [
        [
          1,
          R.R1.id,
          '2026-01-09T00:00:00.000Z',
          'main',
          'a'.repeat(40),
          100,
          10_000,
          2,
          '2026-01-09T00:00:00.000Z',
        ],
      ],
    ),
  );

  // harness_snapshots: one row per owner/snapshot (05 §F15/F17/F18/F12 chunk 13). s04 is bound
  // to the first (F17-session-logs-snapshot reads it back, F18-delete-by-admin deletes it with
  // s04); s09 is bound to the second, which only the F12 orphan-sweep row ever deletes.
  out.push(
    insert(
      'harness_snapshots',
      ['id', 'user_id', 'snapshot_id', 'body', 'created_at'],
      [
        [
          1,
          U.owner.id,
          WORLD_V1.harnessSnapshotId,
          json(HARNESS_SNAPSHOT_BODY),
          '2026-01-12T14:00:00.000Z',
        ],
        [
          2,
          U.owner.id,
          WORLD_V1.harnessSnapshotIdOrphan,
          json(HARNESS_SNAPSHOT_BODY_ORPHAN),
          '2026-01-15T10:00:00.000Z',
        ],
      ],
    ),
  );

  // OKF usage (2026-10-27): s02 is bound to OKF_SNAPSHOT_BODY; the s02 -> s03 tree read the
  // bundle. s02 (main agent) read index.md first, then the gitignored private.md; its sub-agent
  // s03 read scheduler.md twice. No other session has OKF rows.
  out.push(
    insert(
      'okf_snapshots',
      ['id', 'user_id', 'snapshot_id', 'body', 'created_at'],
      [
        [
          1,
          U.owner.id,
          WORLD_V1.okfSnapshotId,
          json(OKF_SNAPSHOT_BODY),
          '2026-01-11T09:00:00.000Z',
        ],
      ],
    ),
  );
  out.push(
    insert(
      'session_okf_access',
      [
        'id',
        'session_id',
        'path_key',
        'op',
        'after_own_edit',
        'bytes',
        'calls',
        'seq',
      ],
      [
        [1, S.s02.id, 'docs/kb/index.md', 'read', false, 400, 1, 1],
        [2, S.s02.id, 'docs/kb/private.md', 'read', false, 800, 1, 2],
        [3, S.s03.id, 'docs/kb/scheduler.md', 'read', false, 1500, 2, 1],
      ],
    ),
  );

  // Tools/MCP tab (T-26, F24). The owner's personal list of R1 monitors `ce` and `kubectl`
  // (plus a disabled `old`); T1's list of R1's URL (link 1) monitors `find`; T2 has none. R1's
  // repository row carries the hook's last wrapper status (wrapper data for `ce` only). Every
  // session keeps `tool_usage_version` NULL (rebuild pending) and the contract run parks the
  // rebuild drain, so these hand-written rows are what the read routes serve.
  out.push(
    insert(
      'repo_tool_monitor_config',
      ['repo_id', 'config', 'updated_at'],
      [
        [
          R.R1.id,
          json({
            paused: false,
            tools: [
              { name: 'ce', enabled: true, capture: 'full' },
              { name: 'kubectl', enabled: true, capture: 'meta' },
              { name: 'old', enabled: false, capture: 'full' },
            ],
          }),
          '2026-01-03T12:00:00.000Z',
        ],
      ],
    ),
  );
  out.push(
    insert(
      'team_repo_tool_monitor_config',
      ['team_repository_id', 'config', 'updated_at'],
      [
        [
          1,
          json({
            paused: false,
            tools: [{ name: 'find', enabled: true, capture: 'full' }],
          }),
          '2026-01-03T12:30:00.000Z',
        ],
      ],
    ),
  );
  out.push({
    sql: `UPDATE repositories SET tool_wrap_status = $1 WHERE id = $2`,
    params: [
      JSON.stringify({
        hookVersion: '2.21.0',
        os: 'win32',
        preflight: {
          ok: true,
          reason: null,
          shells: { bash: true, powershell: true },
        },
        breaker: { global: false, tools: [] },
        reportedAt: '2026-01-10T10:31:00.000Z',
        tools: { ce: { lastWrapperAt: '2026-01-10T10:03:00.000Z' } },
      }),
      R.R1.id,
    ],
  });

  const TU = WORLD_V1.toolUsage;
  /** A DD-10 call record: an MCP call of the main agent unless `over` says otherwise. */
  const toolCall = (over: Record<string, unknown>) => ({
    callId: '',
    channel: 'mcp',
    tool: '',
    operation: '',
    ts: '',
    durationMs: null,
    status: 'ok',
    hints: [],
    source: 'transcript',
    shell: null,
    exitCode: null,
    inBytes: 0,
    outBytes: 0,
    agentSawBytes: null,
    toolUseId: null,
    agentId: null,
    agentKind: 'root',
    inputPreview: '',
    real: null,
    cwd: null,
    args: null,
    signals: [],
    ...over,
  });
  /** A DD-11 per-operation aggregate. */
  const opAgg = (over: Record<string, unknown>) => ({
    calls: 1,
    errors: 0,
    killed: 0,
    noResult: 0,
    empty: 0,
    retried: 0,
    fellBack: 0,
    openedFile: 0,
    durationMsSum: 0,
    durationCount: 0,
    inBytesSum: 0,
    outBytesSum: 0,
    lastTs: null,
    ...over,
  });
  out.push(
    insert(
      'session_tool_usage',
      [
        'id',
        'session_id',
        'channel',
        'tool',
        'call_count',
        'first_call_at',
        'last_call_at',
        'has_wrapper_data',
        'aggregates',
        'calls',
        'outputs',
      ],
      [
        [
          TU.tuS01Mcp.id,
          S.s01.id,
          'mcp',
          'postgres',
          2,
          '2026-01-10T10:01:00.000Z',
          '2026-01-10T10:02:00.000Z',
          false,
          json({
            operations: {
              query: opAgg({
                calls: 2,
                errors: 1,
                retried: 1,
                durationMsSum: 300,
                durationCount: 2,
                inBytesSum: 80,
                outBytesSum: 560,
                lastTs: '2026-01-10T10:02:00.000Z',
              }),
            },
          }),
          json([
            toolCall({
              callId: TU.tuS01Mcp.callA,
              tool: 'postgres',
              operation: 'query',
              ts: '2026-01-10T10:01:00.000Z',
              durationMs: 100,
              inBytes: 40,
              outBytes: 500,
              agentSawBytes: 500,
              toolUseId: 'toolu_w1_q1',
              inputPreview: '{"sql":"select count(*) from harvests"}',
            }),
            toolCall({
              callId: TU.tuS01Mcp.callB,
              tool: 'postgres',
              operation: 'query',
              ts: '2026-01-10T10:02:00.000Z',
              durationMs: 200,
              status: 'error',
              inBytes: 40,
              outBytes: 60,
              agentSawBytes: 60,
              toolUseId: 'toolu_w1_q2',
              inputPreview: '{"sql":"select * from spice"}',
              signals: ['retried'],
            }),
          ]),
          json({
            [TU.tuS01Mcp.callA]: {
              input: '{"sql":"select count(*) from harvests"}',
              agentSaw: '42',
              encoding: 'utf8',
            },
            [TU.tuS01Mcp.callB]: {
              input: '{"sql":"select * from spice"}',
              agentSaw: 'relation "spice" does not exist',
              encoding: 'utf8',
            },
          }),
        ],
        [
          TU.tuS01Cli.id,
          S.s01.id,
          'cli',
          'ce',
          1,
          '2026-01-10T10:03:00.000Z',
          '2026-01-10T10:03:00.000Z',
          true,
          json({
            operations: {
              build: opAgg({
                durationMsSum: 1500,
                durationCount: 1,
                outBytesSum: 2048,
                lastTs: '2026-01-10T10:03:00.000Z',
              }),
            },
          }),
          json([
            toolCall({
              callId: TU.tuS01Cli.callA,
              channel: 'cli',
              tool: 'ce',
              operation: 'build',
              ts: '2026-01-10T10:03:00.000Z',
              durationMs: 1500,
              hints: ['cut'],
              source: 'both',
              shell: 'bash',
              exitCode: 0,
              outBytes: 2048,
              agentSawBytes: 1024,
              toolUseId: 'toolu_w1_c1',
              inputPreview: 'ce build --all | head -20',
              real: '/usr/local/bin/ce',
              cwd: ROOT,
              args: ['build', '--all'],
            }),
          ]),
          json({
            [TU.tuS01Cli.callA]: {
              input: 'ce build --all | head -20',
              stdout: 'built 12 targets',
              stderr: '',
              agentSaw: 'built 12',
              encoding: 'utf8',
            },
          }),
        ],
        [
          TU.tuS03Mcp.id,
          S.s03.id,
          'mcp',
          'postgres',
          1,
          '2026-01-11T09:12:00.000Z',
          '2026-01-11T09:12:00.000Z',
          false,
          json({
            operations: {
              schema: opAgg({
                empty: 1,
                durationMsSum: 50,
                durationCount: 1,
                inBytesSum: 20,
                outBytesSum: 300,
                lastTs: '2026-01-11T09:12:00.000Z',
              }),
            },
          }),
          json([
            toolCall({
              callId: TU.tuS03Mcp.callA,
              tool: 'postgres',
              operation: 'schema',
              ts: '2026-01-11T09:12:00.000Z',
              durationMs: 50,
              inBytes: 20,
              outBytes: 300,
              agentSawBytes: 300,
              toolUseId: 'toolu_w1_q3',
              agentId: 'agent-w1-scheduler',
              agentKind: 'subagent',
              inputPreview: '{"table":"schedules"}',
              signals: ['empty'],
            }),
          ]),
          json({
            [TU.tuS03Mcp.callA]: {
              input: '{"table":"schedules"}',
              agentSaw: '',
              encoding: 'utf8',
            },
          }),
        ],
        [
          TU.tuS06Cli.id,
          S.s06.id,
          'cli',
          'ce',
          1,
          '2026-01-13T08:05:00.000Z',
          '2026-01-13T08:05:00.000Z',
          true,
          json({
            operations: {
              test: opAgg({
                errors: 1,
                durationMsSum: 3000,
                durationCount: 1,
                outBytesSum: 400,
                lastTs: '2026-01-13T08:05:00.000Z',
              }),
            },
          }),
          json([
            toolCall({
              callId: TU.tuS06Cli.callA,
              channel: 'cli',
              tool: 'ce',
              operation: 'test',
              ts: '2026-01-13T08:05:00.000Z',
              durationMs: 3000,
              status: 'error',
              source: 'both',
              shell: 'powershell',
              exitCode: 2,
              outBytes: 400,
              agentSawBytes: 400,
              toolUseId: 'toolu_w1_c2',
              inputPreview: 'ce test',
              real: 'C:/tools/ce.exe',
              cwd: ROOT,
              args: ['test'],
            }),
          ]),
          json({
            [TU.tuS06Cli.callA]: {
              input: 'ce test',
              stdout: '',
              stderr: '2 tests failed',
              agentSaw: '2 tests failed',
              encoding: 'utf8',
            },
          }),
        ],
        [
          TU.tuS08Mcp.id,
          S.s08.id,
          'mcp',
          'github',
          1,
          '2026-01-14T16:01:00.000Z',
          '2026-01-14T16:01:00.000Z',
          false,
          json({
            operations: {
              search_issues: opAgg({
                durationMsSum: 700,
                durationCount: 1,
                outBytesSum: 900,
                lastTs: '2026-01-14T16:01:00.000Z',
              }),
            },
          }),
          json([
            toolCall({
              callId: TU.tuS08Mcp.callA,
              tool: 'github',
              operation: 'search_issues',
              ts: '2026-01-14T16:01:00.000Z',
              durationMs: 700,
              outBytes: 900,
              agentSawBytes: 900,
              toolUseId: 'toolu_w1_g1',
              inputPreview: '{"q":"harvester"}',
            }),
          ]),
          json({
            [TU.tuS08Mcp.callA]: {
              input: '{"q":"harvester"}',
              agentSaw: '[]',
              encoding: 'utf8',
            },
          }),
        ],
      ],
    ),
  );

  out.push(
    insert(
      'harness_elements',
      [
        'id',
        'repo_id',
        'kind',
        'name',
        'mcp_server',
        'mcp_connected',
        'schema_size_tokens',
        'source',
        'first_seen',
        'last_seen',
        'created_at',
      ],
      [
        [
          1,
          R.R1.id,
          'skill',
          'deploy',
          null,
          null,
          null,
          'project',
          '2026-01-10T10:00:00.000Z',
          '2026-01-12T14:00:00.000Z',
          '2026-01-10T10:00:00.000Z',
        ],
        [
          2,
          R.R1.id,
          'mcp',
          'postgres',
          null,
          true,
          1200,
          null,
          '2026-01-10T10:00:00.000Z',
          '2026-01-12T14:00:00.000Z',
          '2026-01-10T10:00:00.000Z',
        ],
      ],
    ),
  );
  out.push(
    insert(
      'session_harness_usage',
      [
        'session_id',
        'kind',
        'name',
        'mcp_server',
        'uses',
        'input_tokens',
        'output_tokens',
        'is_initial',
      ],
      [
        [S.s01.id, 'skill', 'deploy', null, 1, 0, 0, null],
        [S.s01.id, 'tool', 'Read', null, 2, 1000, 200, true],
      ],
    ),
  );

  const attributes = [
    {
      key: 'ticket',
      label: 'Ticket',
      type: 'string',
      prompt: 'Which ticket is this session about?',
    },
  ];
  // T1's single team config of R1's URL lives with its link (team_repositories id 1); the
  // owner's personal override stays in repo_config.
  out.push(
    insert(
      'team_repo_config',
      ['team_repository_id', 'config', 'updated_at'],
      [
        [
          1,
          json({
            fileCategories: [{ name: 'Source', patterns: ['^src/'] }],
            highCacheCreationThreshold: 50_000,
            turnEndCostAdvisor: { enabled: true, minSessionCostUsd: 1 },
            sessionAttribution: { enabled: true, attributes },
          }),
          '2026-01-02T12:00:00.000Z',
        ],
      ],
    ),
  );
  out.push(
    insert(
      'repo_config',
      ['repo_id', 'user_id', 'config', 'updated_at'],
      [
        [
          R.R1.id,
          U.owner.id,
          json({ fileCategories: [{ name: 'Docs', patterns: ['^docs/'] }] }),
          '2026-01-02T12:30:00.000Z',
        ],
      ],
    ),
  );
  out.push(
    insert(
      'user_favorite_sessions',
      ['user_id', 'session_id'],
      [[U.owner.id, S.s04.id]],
    ),
  );

  out.push(
    insert(
      'session_attribution',
      ['session_id', 'prompt_watermark', 'values', 'updated_at'],
      [
        [S.s01.id, 2, json({ ticket: 'ARR-1' }), '2026-01-10T10:31:00.000Z'],
        [S.s04.id, 1, json({ ticket: 'ARR-2' }), '2026-01-12T14:21:00.000Z'],
      ],
    ),
  );
  out.push(
    insert(
      'session_attribution_runs',
      [
        'id',
        'session_id',
        'prompt_watermark',
        'eval_session_id',
        'invoking_session_id',
        'started_at',
        'finished_at',
        'outcome',
        'failure_reason',
        'model',
        'cost_usd',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
      ],
      [
        [
          1,
          S.s01.id,
          2,
          'w1-eval-attr-1',
          S.s01.sessionId,
          '2026-01-10T10:30:30.000Z',
          '2026-01-10T10:31:00.000Z',
          'applied',
          null,
          M.a,
          '0.010000',
          10_000,
          1_000,
          0,
          0,
        ],
        [
          2,
          S.s01.id,
          1,
          'w1-eval-attr-0',
          S.s01.sessionId,
          '2026-01-10T10:06:00.000Z',
          '2026-01-10T10:07:00.000Z',
          'failed',
          'timeout',
          M.a,
          '0.002000',
          2_000,
          0,
          0,
          0,
        ],
      ],
    ),
  );
  out.push(
    insert(
      'session_prompt_watermark',
      ['session_id', 'prompt_watermark', 'updated_at'],
      [
        [S.s01.id, 2, '2026-01-10T10:30:00.000Z'],
        [S.s04.id, 1, '2026-01-12T14:20:00.000Z'],
      ],
    ),
  );
  out.push(
    insert(
      'turn_end_advisor_runs',
      [
        'id',
        'session_id',
        'user_id',
        'eval_session_id',
        'started_at',
        'finished_at',
        'outcome',
        'summary_general',
        'cost_factors',
        'harness_advice',
        'failure_reason',
        'model',
        'cost_usd',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'created_at',
      ],
      [
        [
          1,
          S.s01.sessionId,
          U.owner.id,
          'w1-eval-adv-1',
          '2026-01-10T10:30:10.000Z',
          '2026-01-10T10:30:40.000Z',
          'submitted',
          'Most of the cost came from one large cache write.',
          json(['cache writes']),
          json(['trim CLAUDE.md']),
          null,
          M.a,
          '0.020000',
          20_000,
          2_000,
          0,
          0,
          '2026-01-10T10:30:40.000Z',
        ],
      ],
    ),
  );

  out.push(
    insert(
      'model_pricing',
      [
        'model_id',
        'price_in',
        'price_out',
        'price_cache_r',
        'price_cache_w',
        'price_cache_w_5m',
        'price_cache_w_1h',
        'price_web_search',
        'currency',
        'effective_from',
        'chars_per_token',
        'context_length',
        'source',
      ],
      [
        // world-model-a: an older version, the current one and a future one (must never apply).
        [
          M.a,
          '10',
          '20',
          '5',
          '12.5',
          '12.5',
          '20',
          '0',
          'USD',
          '2025-01-01',
          '4.000',
          200_000,
          'manual',
        ],
        [
          M.a,
          '1',
          '2',
          '0.5',
          '1.25',
          '1.25',
          '2',
          '0.01',
          'USD',
          '2026-01-01',
          '4.000',
          200_000,
          'manual',
        ],
        [
          M.a,
          '100',
          '200',
          '50',
          '125',
          '125',
          '200',
          '0',
          'USD',
          '2099-01-01',
          '4.000',
          200_000,
          'manual',
        ],
        // world-model-b: no chars_per_token / context_length. world-model-unpriced has no row at all.
        [
          M.b,
          '2',
          '4',
          '1',
          '2.5',
          '2.5',
          '4',
          '0',
          'USD',
          '2026-01-01',
          null,
          null,
          'manual',
        ],
        // world-model-fetched: a fetched (anthropic) price — the only kind an admin may override.
        [
          M.fetched,
          '3',
          '15',
          '0.3',
          '3.75',
          '3.75',
          '6',
          '0',
          'USD',
          '2026-01-01',
          null,
          null,
          'anthropic',
        ],
        // world-model-overridden: an admin override on top of a fetched base (meta row below).
        [
          M.overridden,
          '9',
          '9',
          '0.9',
          '11.25',
          '11.25',
          '18',
          '0',
          'USD',
          '2026-01-01',
          null,
          null,
          'override',
        ],
      ],
    ),
  );
  out.push(
    insert(
      'model_pricing_meta',
      [
        'model_id',
        'override_base_source',
        'override_base_price_in',
        'override_base_price_out',
        'override_base_price_cache_r',
        'override_base_price_cache_w_5m',
        'override_base_price_cache_w_1h',
        'override_base_price_web_search',
        'updated_at',
      ],
      [
        [
          M.overridden,
          'anthropic',
          '3',
          '15',
          '0.3',
          '3.75',
          '6',
          '0',
          '2026-01-05T00:00:00.000Z',
        ],
      ],
    ),
  );

  // Upload queue: only `failed` rows — the 50 ms worker never picks them up, and the
  // partial-upload sweep has nothing to expire (05 §F09, open question 6).
  out.push(
    insert(
      'upload_queue',
      [
        'id',
        'file_name',
        'size_bytes',
        'received_at',
        'session_id',
        'log_type',
        'user_id',
        'status',
        'error_message',
        'updated_at',
      ],
      [
        [
          1,
          'w1-q-failed-1.ndjson',
          1234,
          '2026-01-12T10:00:00.000Z',
          'w1-q-failed-1',
          'claude',
          U.owner.id,
          'failed',
          'invalid NDJSON at line 3',
          '2026-01-12T10:00:01.000Z',
        ],
        [
          2,
          'w1-q-failed-2.ndjson',
          567,
          '2026-01-12T11:00:00.000Z',
          'w1-q-failed-2',
          'artisyn',
          U.member.id,
          'failed',
          'invalid NDJSON at line 1',
          '2026-01-12T11:00:01.000Z',
        ],
      ],
    ),
  );
  // The stats endpoint only looks at the last 15 minutes, so these two are relative to now().
  out.push({
    sql: `INSERT INTO upload_queue_measurements
            (id, session_id, log_type, started_at, finished_at, duration_ms, queue_latency_ms, size_bytes, outcome)
          VALUES (1, 'w1-q-done-1', 'claude', now() - interval '6 minutes', now() - interval '5 minutes 55 seconds', 5000, 6000, 2048, 'success'),
                 (2, 'w1-q-done-2', 'artisyn', now() - interval '4 minutes', now() - interval '3 minutes 58 seconds', 2000, 3000, 1024, 'failure')`,
    params: [],
  });

  const J = WORLD_V1.jobs;
  out.push(
    insert(
      'export_import_jobs',
      [
        'id',
        'kind',
        'status',
        'processed',
        'total',
        'error_message',
        'repo_id',
        'user_id',
        'result_file_path',
        'created_at',
        'updated_at',
      ],
      [
        [
          J.exportDone.id,
          'export',
          'done',
          3,
          3,
          null,
          R.R1.id,
          U.owner.id,
          null,
          '2026-01-12T15:00:00.000Z',
          '2026-01-12T15:01:00.000Z',
        ],
        [
          J.exportRunning.id,
          'export',
          'running',
          1,
          3,
          null,
          R.R1.id,
          U.owner.id,
          null,
          '2026-01-12T16:00:00.000Z',
          '2026-01-12T16:00:30.000Z',
        ],
        [
          J.importDone.id,
          'import',
          'done',
          2,
          2,
          null,
          R.R1.id,
          U.owner.id,
          null,
          '2026-01-12T17:00:00.000Z',
          '2026-01-12T17:02:00.000Z',
        ],
        [
          J.stagedError.id,
          'staged_upload',
          'error',
          0,
          0,
          J.stagedError.errorMessage,
          R.R1.id,
          U.owner.id,
          '/nonexistent/w1-staged-error.zip',
          '2026-01-12T18:00:00.000Z',
          '2026-01-12T18:00:05.000Z',
        ],
      ],
    ),
  );

  out.push(
    insert(
      'ai_tool_version',
      ['tool_name', 'version_map', 'fetched_at', 'last_attempt_at'],
      [
        [
          'claude-code',
          json({ stable: '2.1.90', latest: '2.1.99' }),
          '2026-01-10T12:00:00.000Z',
          '2026-01-10T12:00:00.000Z',
        ],
      ],
    ),
  );
  out.push(
    insert(
      'ai_tool_version_history',
      ['id', 'tool_name', 'version_map', 'effective_from'],
      [
        [
          1,
          'claude-code',
          json({ stable: '2.1.80', latest: '2.1.90' }),
          '2026-01-01T12:00:00.000Z',
        ],
        [
          2,
          'claude-code',
          json({ stable: '2.1.90', latest: '2.1.99' }),
          '2026-01-10T12:00:00.000Z',
        ],
      ],
    ),
  );

  return out;
}

/** The world's INSERT statements, in dependency order. */
export const WORLD_V1_STATEMENTS: readonly WorldStatement[] = buildStatements();

/** Tables kept by `resetWorldV1` (see `VOLATILE_TABLES` in oracle.ts for why). */
const KEEP_ON_RESET = [
  '__drizzle_migrations',
  'auth_sessions',
  'server_secrets',
];

/**
 * The schema's tables in an order that is safe to DELETE from one by one: every table comes
 * before the tables its foreign keys point at (children first). Cached per schema — the
 * migrations, and so the FK graph, never change within a run.
 */
const deleteOrderCache = new Map<string, string[]>();

async function deleteOrder(db: Queryable, schema: string): Promise<string[]> {
  const cached = deleteOrderCache.get(schema);
  if (cached) return cached;
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [schema],
  );
  const tables = rows
    .map((r) => r.table_name)
    .filter((t) => !KEEP_ON_RESET.includes(t))
    .sort();
  const { rows: edges } = await db.query<{ child: string; parent: string }>(
    `SELECT ch.relname AS child, pa.relname AS parent
       FROM pg_constraint k
       JOIN pg_class ch ON ch.oid = k.conrelid
       JOIN pg_class pa ON pa.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = k.connamespace
      WHERE k.contype = 'f' AND n.nspname = $1 AND ch.relname <> pa.relname`,
    [schema],
  );
  // Depth-first: a table is emitted only after every table that references it.
  const referencedBy = new Map<string, string[]>();
  for (const { child, parent } of edges) {
    referencedBy.set(parent, [...(referencedBy.get(parent) ?? []), child]);
  }
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (table: string): void => {
    if (state.get(table) === 'done') return;
    if (state.get(table) === 'visiting') {
      throw new Error(`world-v1: foreign-key cycle through ${table}`);
    }
    state.set(table, 'visiting');
    for (const child of referencedBy.get(table) ?? []) visit(child);
    state.set(table, 'done');
    if (tables.includes(table)) order.push(table);
  };
  for (const table of tables) visit(table);
  deleteOrderCache.set(schema, order);
  return order;
}

/**
 * Empties every table of the schema (except the migration journal, the session store and the
 * server secret), inserts the world and moves every serial sequence to
 * `WORLD_V1_SEQUENCE_FLOOR`. Run it inside one transaction (`inOracleTransaction`) so readers
 * never see a half-loaded world. Write-family cases call it before each row (05 §2.3).
 *
 * Plain DELETEs in foreign-key order, not one `TRUNCATE ... CASCADE`: on these tiny tables a
 * DELETE takes milliseconds, while TRUNCATE recreates every table's files (~2.4 s for the whole
 * schema), and a run reloads the world a few hundred times. Sequences need no RESTART: the
 * world inserts explicit ids and every sequence is set to the floor afterwards anyway.
 */
export async function resetWorldV1(
  db: Queryable,
  schema: string,
): Promise<void> {
  const order = await deleteOrder(db, schema);
  if (order.length > 0) {
    await db.query(order.map((t) => `DELETE FROM ${ident(t)};`).join('\n'));
  }
  for (const st of WORLD_V1_STATEMENTS) {
    await db.query(st.sql, st.params);
  }
  await db.query(
    `SELECT setval(pg_get_serial_sequence(quote_ident(c.table_name), c.column_name)::regclass, $2)
       FROM information_schema.columns c
      WHERE c.table_schema = $1 AND c.column_default LIKE 'nextval(%'
        AND pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) IS NOT NULL`,
    [schema, WORLD_V1_SEQUENCE_FLOOR],
  );
}
