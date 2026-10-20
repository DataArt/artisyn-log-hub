import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import type { UploadQueueMeasurementOutcome } from '../../logs/upload-queue-stats.constants';

export const userRoleEnum = pgEnum('user_role', ['admin', 'user']);

export const teamAccessModeEnum = pgEnum('team_access_mode', [
  'transparent',
  'restricted',
]);

export const uploadQueueStatusEnum = pgEnum('upload_queue_status', [
  'pending',
  'processing',
  'partially_uploaded',
  'failed',
  // Migration 0068: terminal status for an upload the worker refused because the session
  // belongs to another user. Delivered to the hook once via `warningDelivered`.
  'rejected_foreign_session',
]);

export const exportImportJobKindEnum = pgEnum('export_import_job_kind', [
  'export',
  'import',
  'staged_upload',
]);

export const exportImportJobStatusEnum = pgEnum('export_import_job_status', [
  'staged',
  'running',
  'done',
  'error',
]);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email').notNull().unique(),
  passwordHash: varchar('password_hash'),
  role: userRoleEnum('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  emailConfirmedAt: timestamp('email_confirmed_at', { withTimezone: true }),
});

export const userSettings = pgTable(
  'user_settings',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    settingName: varchar('setting_name', { length: 100 }).notNull(),
    settingValue: text('setting_value'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.settingName] })],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [index('idx_password_reset_tokens_user_id').on(table.userId)],
);

export const emailConfirmationTokens = pgTable(
  'email_confirmation_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_email_confirmation_tokens_token').on(table.token),
    index('idx_email_confirmation_tokens_user_id').on(table.userId),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 1000 }).notNull(),
    slug: varchar('slug', { length: 6 }).notNull(),
    keyHash: varchar('key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    unique().on(table.userId, table.name),
    index('idx_api_keys_user_id').on(table.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    sessionId: varchar('session_id', { length: 255 }).notNull().unique(),
    parentSessionId: varchar('parent_session_id', { length: 255 }),
    workflowRunId: varchar('workflow_run_id', { length: 255 }),
    deleted: boolean('deleted').notNull().default(false),
    // Migration 0073: the DD-2 id of the harness_snapshots row this session is bound to.
    // No FK — the row is looked up by (owning user_id, this id) in application code, and an
    // orphan sweep (deleteOrphanHarnessSnapshots) can delete that row out from under this
    // column by design (DD-11, DD-21). NULL until the first artisyn upload that carries a
    // snapshot or snapshot ref binds it (COALESCE-bound: never overwritten afterwards).
    harnessSnapshotId: varchar('harness_snapshot_id', { length: 64 }),
  },
  (table) => [
    index('sessions_parent_session_id_idx').on(table.parentSessionId),
    // No WHERE/JOIN consumer yet — mirrors parent_session_id's shape ahead of
    // anticipated ad-hoc/debug lookups by workflow run.
    index('sessions_workflow_run_id_idx').on(table.workflowRunId),
    // Read path (getSessionLogs) looks up a session's snapshot by this column on every
    // session-logs request.
    index('sessions_harness_snapshot_id_idx').on(table.harnessSnapshotId),
  ],
);

// One row per (owner user_id, snapshot_id): the whole DD-1 harness snapshot body the hook
// built and uploaded, stored verbatim in `body`. `snapshotId` is computed by the hook (DD-2)
// and only format-validated here, never recomputed. UNIQUE (user_id, snapshot_id) makes the
// ingest-time insert an upsert (`ON CONFLICT DO NOTHING`); the plain index on snapshot_id
// alone backs the cross-owner "is this id known anywhere" lookups used by orphan cleanup
// (migration 0073).
export const harnessSnapshots = pgTable(
  'harness_snapshots',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    snapshotId: varchar('snapshot_id', { length: 64 }).notNull(),
    body: jsonb('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('harness_snapshots_user_id_snapshot_id_key').on(
      table.userId,
      table.snapshotId,
    ),
    index('idx_harness_snapshots_snapshot_id').on(table.snapshotId),
  ],
);

export interface HookNonUploadableLog {
  file: string;
  reason: string;
}

export interface HookRecommendation {
  rule: string;
  message: string;
  detectedAt: string;
}

export const repositories = pgTable(
  'repositories',
  {
    id: serial('id').primaryKey(),
    repoUrl: varchar('repo_url', { length: 4000 }).notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    maxUploadBytes: bigint('max_upload_bytes', { mode: 'number' }),
    hookVersion: varchar('hook_version', { length: 50 }),
    hookLastActivity: timestamp('hook_last_activity', { withTimezone: true }),
    hookLogTail: jsonb('hook_log_tail').$type<string[]>(),
    hookNonUploadableLogs: jsonb('hook_non_uploadable_logs').$type<
      HookNonUploadableLog[]
    >(),
    hookRecommendations: jsonb('hook_recommendations').$type<
      HookRecommendation[]
    >(),
    // Most recent artisyn upload's harness inventory self-report timestamp
    // ("last self-report wins", same semantics as hookVersion above). NULL = never
    // reported by any artisyn upload; drives HarnessUsageReportData.inventoryReported.
    harnessInventoryReportedAt: timestamp('harness_inventory_reported_at', {
      withTimezone: true,
    }),
    // Whether the most recent artisyn upload's mcp-config event carried the
    // per-tool `tools/list` probe capability. NULL = never reported
    // by a capable hook; true/false = last capable hook's report.
    harnessMcpPerToolSupported: boolean('harness_mcp_per_tool_supported'),
  },
  (table) => [
    unique('repositories_user_id_repo_url_unique').on(
      table.userId,
      table.repoUrl,
    ),
  ],
);

export const contexts = pgTable(
  'contexts',
  {
    id: serial('id').primaryKey(),
    contextKey: varchar('context_key', { length: 255 }).notNull(),
    contextValue: varchar('context_value', { length: 4000 }).notNull(),
  },
  (table) => [unique().on(table.contextKey, table.contextValue)],
);

export const logs = pgTable(
  'logs',
  {
    id: serial('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id),
    logType: varchar('log_type', { length: 50 }).notNull(),
    body: jsonb('body').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    firstPrompt: text('first_prompt'),
    startTime: timestamp('start_time', { withTimezone: true }),
    endTime: timestamp('end_time', { withTimezone: true }),
    gitBranch: text('git_branch'),
    // The two git roots of the machine the session ran on, extracted from the
    // `artisyn` upload exactly as `gitBranch` is. `gitRepoRoot` is the hook's
    // `--git-common-dir` root (the *primary* checkout even for a linked worktree);
    // `gitWorktreeRoot` is `rev-parse --show-toplevel`, so a session run inside a linked
    // worktree still has its paths resolved instead of being classified out-of-repo.
    // Both nullable: only `artisyn` logs carry them, and only from an updated hook.
    gitRepoRoot: text('git_repo_root'),
    gitWorktreeRoot: text('git_worktree_root'),
  },
  (table) => [
    unique().on(table.sessionId, table.logType),
    index('idx_logs_log_type').on(table.logType),
  ],
);

// Raw OTEL chunks: one inbound OTLP HTTP request = one receiver file = one row here. The
// normalized per-session result derived from these lives in `logs` with logType 'claude-otel'.
// `costUsdMicros` is integer micros so sums stay exact; nullable because a chunk may carry no
// api_request records at all. (sessionId, chunkKey) is unique so a re-uploaded chunk upserts
// rather than double-counting cost.
export const logsOtel = pgTable(
  'logs_otel',
  {
    id: serial('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Cascades on session delete (migration 0045): a chunk is meaningless without its session,
    // and every existing delete path (retention purge, repo/session delete, e2e cleanup) would
    // otherwise fail on an orphan-blocking FK.
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chunkKey: varchar('chunk_key', { length: 255 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    body: jsonb('body').notNull(),
    costUsdMicros: bigint('cost_usd_micros', { mode: 'bigint' }),
    recordCount: integer('record_count'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    unique('logs_otel_session_chunk_unique').on(
      table.sessionId,
      table.chunkKey,
    ),
    index('idx_logs_otel_session_id').on(table.sessionId),
    index('idx_logs_otel_user_id').on(table.userId),
    index('idx_logs_otel_session_received_at').on(
      table.sessionId,
      table.receivedAt,
    ),
  ],
);

// One row per OTEL `claude_code.api_request` log record (migration 0071). Extracted at
// OTEL ingest (and backfilled from `logs_otel.body`), so utility calls — API calls the
// transcript never records — can be priced per call. `callKey` is the record's `request_id`,
// or `<chunkKey>:<1-based line index>` when it has none; (sessionId, callKey) is unique so a
// re-uploaded chunk upserts instead of double-counting. Token columns are named to match
// `session_stats` so `sessionCostSql` prices them unchanged: telemetry has no cache TTL split,
// so `cache_creation_tokens` lands in `cacheWrite5mTokens`; `*Fast` mirror the plain token
// counts when `speed='fast'`, else 0.
export const otelApiCalls = pgTable(
  'otel_api_calls',
  {
    id: serial('id').primaryKey(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    callKey: varchar('call_key', { length: 255 }).notNull(),
    requestId: varchar('request_id', { length: 255 }),
    querySource: varchar('query_source', { length: 255 }),
    model: varchar('model', { length: 255 }),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWrite5mTokens: bigint('cache_write_5m_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWrite1hTokens: bigint('cache_write_1h_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    webSearchRequests: bigint('web_search_requests', { mode: 'number' })
      .notNull()
      .default(0),
    inputTokensFast: bigint('input_tokens_fast', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokensFast: bigint('output_tokens_fast', { mode: 'number' })
      .notNull()
      .default(0),
    costUsdMicros: bigint('cost_usd_micros', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('otel_api_calls_session_call_unique').on(
      table.sessionId,
      table.callKey,
    ),
    index('idx_otel_api_calls_session_request_id').on(
      table.sessionId,
      table.requestId,
    ),
  ],
);

// Distinct transcript `requestId`s of a session's assistant lines (migration 0071). Rewritten delete-then-insert with every `session_stats` upsert; an
// `otel_api_calls` row whose request id is absent from its whole session tree here is a
// utility call.
export const sessionRequestIds = pgTable(
  'session_request_ids',
  {
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    requestId: varchar('request_id', { length: 255 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'session_request_ids_pk',
      columns: [table.sessionId, table.requestId],
    }),
    index('idx_session_request_ids_request_id').on(table.requestId),
  ],
);

export const logRepositories = pgTable(
  'log_repositories',
  {
    logId: integer('log_id')
      .notNull()
      .references(() => logs.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.logId, table.repoId] })],
);

export const logContexts = pgTable(
  'log_contexts',
  {
    logId: integer('log_id')
      .notNull()
      .references(() => logs.id, { onDelete: 'cascade' }),
    contextId: integer('context_id')
      .notNull()
      .references(() => contexts.id),
  },
  (table) => [primaryKey({ columns: [table.logId, table.contextId] })],
);

export const teams = pgTable(
  'teams',
  {
    id: serial('id').primaryKey(),
    name: varchar('name').notNull().unique(),
    ownerId: integer('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    accessMode: teamAccessModeEnum('access_mode')
      .notNull()
      .default('restricted'),
  },
  (table) => [index('idx_teams_owner_id').on(table.ownerId)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canInvite: boolean('can_invite').notNull().default(false),
    isManager: boolean('is_manager').notNull().default(false),
    isAdlcTrainer: boolean('is_adlc_trainer').notNull().default(false),
    disclosureAcknowledgedAt: timestamp('disclosure_acknowledged_at', {
      withTimezone: true,
    }),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })],
);

export const teamRepositories = pgTable(
  'team_repositories',
  {
    id: serial('id').primaryKey(),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    repoUrl: varchar('repo_url', { length: 4000 }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.teamId, table.repoUrl)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: serial('id').primaryKey(),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    inviterId: integer('inviter_id')
      .notNull()
      .references(() => users.id),
    inviteeId: integer('invitee_id')
      .notNull()
      .references(() => users.id),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_invitations_team_id').on(table.teamId)],
);
// Note: partial unique index (team_id, invitee_id) WHERE status = 'pending'
// is defined in the raw SQL migration only — Drizzle ORM does not support
// WHERE clauses on unique indexes declaratively.

// A model carries one row per price change, keyed by (model_id, effective_from).
// Readers must select the newest row that has already taken effect:
//   WHERE effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1
// Selecting by model_id alone can return a future-dated row and overcharge.
export const modelPricing = pgTable(
  'model_pricing',
  {
    modelId: varchar('model_id').notNull(),
    priceIn: numeric('price_in', { precision: 10, scale: 6 }).notNull(),
    priceOut: numeric('price_out', { precision: 10, scale: 6 }).notNull(),
    priceCacheR: numeric('price_cache_r', {
      precision: 10,
      scale: 6,
    }).notNull(),
    /**
     * @deprecated Superseded by `priceCacheW5m` / `priceCacheW1h`. Kept — not
     * dropped — so the migration stays non-destructive; it carries the 5m rate. No
     * reader depends on it any more; dropping it is a separate, later cleanup.
     */
    priceCacheW: numeric('price_cache_w', {
      precision: 10,
      scale: 6,
    }).notNull(),
    // Cache-write rates split by TTL: a 1h cache write costs 2x price_in
    // (= price_cache_w * 1.6), a 5m one 1.25x price_in (= price_cache_w).
    priceCacheW5m: numeric('price_cache_w_5m', {
      precision: 10,
      scale: 6,
    })
      .notNull()
      .default('0'),
    priceCacheW1h: numeric('price_cache_w_1h', {
      precision: 10,
      scale: 6,
    })
      .notNull()
      .default('0'),
    // USD per web-search request — a per-request price, NOT per million tokens.
    // 0 for third-party models, which offer no server tools.
    priceWebSearch: numeric('price_web_search', {
      precision: 10,
      scale: 6,
    })
      .notNull()
      .default('0'),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    effectiveFrom: date('effective_from').notNull(),
    charsPerToken: numeric('chars_per_token', { precision: 6, scale: 3 }),
    contextLength: integer('context_length'),
    // Origin of this price version: 'anthropic' | 'openrouter' | 'manual' | 'override'.
    // The newest effective row's source is the model's current source.
    source: varchar('source', { length: 16 }).notNull().default('manual'),
  },
  (table) => [primaryKey({ columns: [table.modelId, table.effectiveFrom] })],
);
// Note: CHECK constraint model_pricing_source_check (source IN ('anthropic',
// 'openrouter','manual','override')) is defined in the raw SQL migration 0066 only —
// it is not mirrored in Drizzle.

// Per-model facts that do not belong to a price version: when an unpriced model was
// first seen, and the base price hidden under an active override. An unpriced model
// has a row here and NO model_pricing row.
export const modelPricingMeta = pgTable('model_pricing_meta', {
  modelId: varchar('model_id', { length: 255 }).primaryKey(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
  overrideBaseSource: varchar('override_base_source', { length: 16 }),
  overrideBasePriceIn: numeric('override_base_price_in', {
    precision: 10,
    scale: 6,
  }),
  overrideBasePriceOut: numeric('override_base_price_out', {
    precision: 10,
    scale: 6,
  }),
  overrideBasePriceCacheR: numeric('override_base_price_cache_r', {
    precision: 10,
    scale: 6,
  }),
  overrideBasePriceCacheW5m: numeric('override_base_price_cache_w_5m', {
    precision: 10,
    scale: 6,
  }),
  overrideBasePriceCacheW1h: numeric('override_base_price_cache_w_1h', {
    precision: 10,
    scale: 6,
  }),
  overrideBasePriceWebSearch: numeric('override_base_price_web_search', {
    precision: 10,
    scale: 6,
  }),
  overrideBaseCharsPerToken: numeric('override_base_chars_per_token', {
    precision: 6,
    scale: 3,
  }),
  overrideBaseContextLength: integer('override_base_context_length'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
// Note: CHECK constraint model_pricing_meta_override_base_source_check
// (override_base_source IN ('anthropic','openrouter')) is defined in the raw SQL
// migration 0066 only — it is not mirrored in Drizzle.

// One row per price source ('anthropic', 'openrouter'): last attempt/success and
// outcome. The 'anthropic' row is also the cluster claim for the daily fetch.
export const modelPricingFetchState = pgTable('model_pricing_fetch_state', {
  source: varchar('source', { length: 16 }).primaryKey(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastResult: varchar('last_result', { length: 16 }),
  lastCounts: jsonb('last_counts').$type<Record<string, number>>(),
  lastError: text('last_error'),
});

export const deletedSessionLog = pgTable(
  'deleted_session_log',
  {
    id: serial('id').primaryKey(),
    sessionId: varchar('session_id', { length: 255 }).notNull(),
    sessionPk: integer('session_pk').notNull(),
    ownerUserId: integer('owner_user_id'),
    deletedByUserId: integer('deleted_by_user_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startTime: timestamp('start_time', { withTimezone: true }),
    endTime: timestamp('end_time', { withTimezone: true }),
    workTimeMs: bigint('work_time_ms', { mode: 'number' }),
    totalCost: numeric('total_cost', { precision: 14, scale: 8 }),
  },
  (table) => [
    // One audit row per session, ever — also the idempotency primitive
    // `SessionsService.hardPurgeExpiredSessions()` claims against via
    // `onConflictDoNothing` so overlapping purge runs (multiple prod
    // instances ticking concurrently) can't double-purge the same session.
    unique('deleted_session_log_session_pk_unique').on(table.sessionPk),
  ],
);

export const sessionStats = pgTable('session_stats', {
  sessionId: integer('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  model: varchar('model'),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' })
    .notNull()
    .default(0),
  cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
    .notNull()
    .default(0),
  cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' })
    .notNull()
    .default(0),
  // TTL split of cacheWriteTokens. Invariant (test-enforced, not a DB constraint):
  // cacheWrite5mTokens + cacheWrite1hTokens = cacheWriteTokens.
  cacheWrite5mTokens: bigint('cache_write_5m_tokens', { mode: 'number' })
    .notNull()
    .default(0),
  cacheWrite1hTokens: bigint('cache_write_1h_tokens', { mode: 'number' })
    .notNull()
    .default(0),
  // Per-session sum of usage.server_tool_use.web_search_requests. Priced per request
  // at model_pricing.price_web_search, not per million tokens.
  webSearchRequests: bigint('web_search_requests', { mode: 'number' })
    .notNull()
    .default(0),
  // Fast-mode (usage.speed = 'fast') token counts. These are SUBSETS of inputTokens /
  // outputTokens above, which keep their "grand total" semantics — so
  // fast + standard = the per-category total by construction, and no existing consumer
  // shifts. Fast tokens are billed at FAST_MODE_MULTIPLIER x the standard rate, which
  // the cost formula expresses as a surcharge on the grand total.
  inputTokensFast: bigint('input_tokens_fast', { mode: 'number' })
    .notNull()
    .default(0),
  outputTokensFast: bigint('output_tokens_fast', { mode: 'number' })
    .notNull()
    .default(0),
  workTimeMs: bigint('work_time_ms', { mode: 'number' }).notNull().default(0),
  filesEditedWritten: integer('files_edited_written').notNull().default(0),
  linesChanged: integer('lines_changed').notNull().default(0),
  imageCount: integer('image_count').notNull().default(0),
  imageTotalBytes: bigint('image_total_bytes', { mode: 'number' })
    .notNull()
    .default(0),
  mcpCallsTotal: integer('mcp_calls_total').notNull().default(0),
  mcpCallsByServer: jsonb('mcp_calls_by_server')
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  // Productivity counters. Diff-based and deliberately ADDITIVE to `linesChanged`
  // above, which measures a different thing (lines *written* by Edit/Write, no delta, no
  // removals) and keeps its semantics, values and consumers untouched — `costPerLine`
  // still divides by `linesChanged`, so no historical figure shifts.
  linesAdded: integer('lines_added').notNull().default(0),
  linesRemoved: integer('lines_removed').notNull().default(0),
  commitCount: integer('commit_count').notNull().default(0),
  prCount: integer('pr_count').notNull().default(0),
  turnCount: integer('turn_count').notNull().default(0),
  // Coverage of the diff-based line counts, so every surface can state "over N of M
  // Edit/Write calls". Sub-agent transcripts omit `toolUseResult` on ~88% of their
  // Edit/Write calls, so coverage is published rather than guessed.
  diffLinesCoveredCalls: integer('diff_lines_covered_calls')
    .notNull()
    .default(0),
  diffLinesTotalCalls: integer('diff_lines_total_calls').notNull().default(0),
  // Per-`service_tier` token split; messages lacking the field land in an 'unknown' key.
  tokenByServiceTier: jsonb('token_by_service_tier')
    .$type<Record<string, ServiceTierTokens>>()
    .notNull()
    .default({}),
  // Denormalized OTEL telemetry cost, in micro-USD (same unit as
  // logs_otel.cost_usd_micros). NULL = no telemetry signal (no claude-otel chunk ever
  // ingested, or the recomputed aggregate is exactly 0); any other value is the
  // confirmed total. Owned exclusively by upsertSessionTelemetryCost() —
  // upsertSessionStatsRow() never writes it (see the exclusion note there).
  telemetryCost: bigint('telemetry_cost', { mode: 'bigint' }),
  // Change surface — own-scope, per-node counters only.
  // All four are NULLABLE WITH NO DEFAULT, following the `telemetryCost` precedent:
  // NULL means "not recomputed yet" and is what makes every change-surface surface
  // render "no data" instead of a fabricated `0`. `csComputedAt` is the marker — it is
  // set whenever the extractor ran, INCLUDING when it found zero changed paths (the three
  // counters are then `0`, not NULL), which is what separates a genuine zero-change
  // session from a never-recomputed one. The only successful extraction that leaves it
  // NULL is the unknown-repo-root state, where no path can be normalised and every count
  // would be a lie.
  //
  // Concentration is deliberately NOT stored here: it is not composable (a per-node value
  // cannot be summed or averaged into a tree/repo value), so it is always recomputed from
  // `session_changed_paths` at read time. These four columns are likewise NOT part of
  // `treeMetricsSumColumns()`.
  csChangedFiles: integer('cs_changed_files'),
  csFoldersTouched: integer('cs_folders_touched'),
  csOutsideRepoFiles: integer('cs_outside_repo_files'),
  csComputedAt: timestamp('cs_computed_at', { withTimezone: true }),
  // Claude Code version check (migration 0065). Both NULLABLE WITH NO DEFAULT
  // (NULL = unknown). `claudeVersion` is the highest valid version on the session's own
  // transcript lines (written by upsertSessionStatsRow); `claudeVersionOtel` is the
  // highest OTEL `service.version` seen on its claude-otel chunks, owned exclusively by
  // upsertSessionClaudeVersionOtel() and only ever raised. Readers use
  // COALESCE(claude_version, claude_version_otel), so the transcript value wins.
  claudeVersion: varchar('claude_version', { length: 64 }),
  claudeVersionOtel: varchar('claude_version_otel', { length: 64 }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** One `service_tier` bucket's token totals inside `sessionStats.tokenByServiceTier`. */
export interface ServiceTierTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * Per-session, per-tool call statistics.
 *
 * Unscoped — no `team_id` / `user_id` — because, exactly like `sessionStats` and unlike
 * `sessionFileStats` / `sessionCauseStats`, nothing about these figures depends on a scoped
 * `repo_config` field. A real table rather than a jsonb column on `sessionStats` so that
 * repository-scope aggregation is a plain indexed `GROUP BY tool_name`, which is what the
 * "no `logs.body` parsing at request time" requirement needs.
 *
 * `durationMsTotal` exists only to derive an exact *mean*. It must never be surfaced as a
 * "total tool time" figure: a single assistant message can issue several `tool_use` blocks
 * that run concurrently, so their durations overlap in wall clock. `parallelBatchCalls`
 * records how many of this tool's calls were in such a batch.
 */
export const sessionToolStats = pgTable(
  'session_tool_stats',
  {
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    toolName: varchar('tool_name', { length: 128 }).notNull(),
    calls: integer('calls').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    unresolved: integer('unresolved').notNull().default(0),
    durationCoveredCalls: integer('duration_covered_calls')
      .notNull()
      .default(0),
    durationMsTotal: bigint('duration_ms_total', { mode: 'number' })
      .notNull()
      .default(0),
    durationMsMax: bigint('duration_ms_max', { mode: 'number' })
      .notNull()
      .default(0),
    // Counts in the eleven fixed buckets of `tool-stats.ts`
    // (DURATION_BUCKET_LOWER_BOUNDS_MS). Per-session medians cannot be averaged, so the
    // repository-scope p50 is interpolated from the summed histogram and flagged
    // approximate. The bucket bounds are therefore append-only — changing one invalidates
    // every stored histogram.
    durationMsHistogram: jsonb('duration_ms_histogram')
      .$type<number[]>()
      .notNull()
      .default([]),
    durationBySource: jsonb('duration_by_source')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    parallelBatchCalls: integer('parallel_batch_calls').notNull().default(0),
  },
  (table) => [
    index('idx_session_tool_stats_session_id').on(table.sessionId),
    // Enforced in SQL as a unique *index* rather than a table constraint, because
    // `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT EXISTS` form and every migration in
    // this repo must be re-runnable. The uniqueness guarantee is identical.
    uniqueIndex('session_tool_stats_session_tool_unique').on(
      table.sessionId,
      table.toolName,
    ),
  ],
);

/**
 * Harness elements inventory of record. One row per `(repo_id, kind, name)` —
 * upserted on every artisyn upload from the self-report events,
 * never derived from usage. `first_seen` is set on insert and
 * `last_seen` is bumped on every re-report; neither is ever cleared when an element
 * stops being reported, so removed/renamed elements persist and are flagged `removed`
 * by the report (last_seen older than the repo's current
 * `repositories.harness_inventory_reported_at`).
 *
 * Built-in `tool`-kind rows (mirrored server-side from
 * `client/src/viewer/lib/tools/registry.ts` in `builtin-tools.ts`) are seeded once per
 * repo, read-only, with `first_seen`/`last_seen` both `NULL` — they always exist and were
 * never "added" by a specific repo, so they are never `removed`.
 *
 * `mcp_server` is non-null only for `tool`-kind rows sourced from an MCP server (the
 * `name` already carries the `mcp__<server>__<tool>` prefix, same convention as
 * `sessionToolStats.toolName`). `mcp_connected`/`schema_size_tokens` are meaningful only
 * for `kind='mcp'` / MCP-sourced `tool` rows respectively.
 */
export const harnessElements = pgTable(
  'harness_elements',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(), // 'skill' | 'rule' | 'mcp' | 'tool'
    name: varchar('name', { length: 255 }).notNull(),
    mcpServer: varchar('mcp_server', { length: 128 }),
    mcpConnected: boolean('mcp_connected'),
    schemaSizeTokens: integer('schema_size_tokens'),
    // Meaningful only for kind='skill': 'project' (.claude/skills/) | 'plugin' (~/.claude/plugins/)
    // | NULL (older hook never reported it). Powers the "project skills only" report filter.
    source: varchar('source', { length: 16 }),
    firstSeen: timestamp('first_seen', { withTimezone: true }),
    lastSeen: timestamp('last_seen', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('harness_elements_repo_kind_name_unique').on(
      table.repoId,
      table.kind,
      table.name,
    ),
    index('idx_harness_elements_repo_id').on(table.repoId),
  ],
);

/**
 * Per-session harness element usage facts. One row per
 * `(session_id, kind, name)`, written alongside `sessionToolStats` in
 * `LogsService.upsert()`'s `claude`/`claude-subagent` branch, delete-then-reinsert per
 * session — mirrors `session-tool-stats-writer.ts`.
 *
 * `skill`/`rule` rows are written from the artisyn branch instead:
 * one `uses=1` row per element present in that session's own inventory self-report,
 * upserted (`ON CONFLICT ... DO UPDATE SET uses = 1`), not additive.
 *
 * `is_initial` is meaningful only for `kind='tool'` rows: whether the
 * tool's first `tool_use` in this session preceded its name appearing in a
 * `deferred_tools_delta` attachment. NULL for skill/rule/mcp rows.
 */
export const sessionHarnessUsage = pgTable(
  'session_harness_usage',
  {
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    mcpServer: varchar('mcp_server', { length: 128 }),
    uses: integer('uses').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    isInitial: boolean('is_initial'),
  },
  (table) => [
    uniqueIndex('session_harness_usage_session_kind_name_unique').on(
      table.sessionId,
      table.kind,
      table.name,
    ),
    index('idx_session_harness_usage_session_id').on(table.sessionId),
  ],
);

/**
 * Per-session changed-path facts. One row per `(session_id, path_key)` — one
 * *logical* changed path per session: the writer aggregates every edit
 * call's facts by `path_key` before inserting, so `D:\a\repo\src\X.ts` and
 * `/home/u/repo/src/x.ts` seen in the same session become one row, never two. Keying on the
 * verbatim `raw_path` instead would double-count `lines_added`/`lines_removed`/`edit_calls`
 * for one logical file.
 *
 * Written by `session-changed-paths-writer.ts`, delete-then-reinsert per session — the
 * `session-tool-stats-writer.ts` convention. Like every other per-session facts table in
 * this schema (`session_tool_stats`, `session_harness_usage`, `session_file_stats`) it has
 * no surrogate primary key: the unique index below is the key.
 *
 * `raw_path` holds the first raw spelling seen for that key, so the normalised columns can
 * be recomputed later without re-parsing the transcript — that is what lets
 * `renormaliseSessionChangedPaths()` self-heal a session whose `artisyn` log (and therefore
 * its repo root) arrived after the agent transcript. Both path columns
 * are truncated to 1024 characters at write time so the `(session_id, path_key)` btree
 * unique index can never hit Postgres' 2704-byte index-row limit.
 *
 * The `*_key` columns are the case-folded identity / `GROUP BY` keys; `rel_path` and
 * `folder` keep their original case because they are displayed. Every normalised column is
 * NULL when the path could not be resolved against a repo root — `outside_repo`
 * distinguishes "outside the repo" from "repo root never learned".
 *
 * `change_kind` is `added | modified`. `deleted` is accepted for
 * forward compatibility but never written: deletions happen through `Bash rm`, not through
 * the Edit/Write tools. It must never be read as diff *coverage* — that is
 * `diff_covered_calls` out of `edit_calls`.
 */
export const sessionChangedPaths = pgTable(
  'session_changed_paths',
  {
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    pathKey: varchar('path_key', { length: 1024 }).notNull(),
    rawPath: varchar('raw_path', { length: 1024 }).notNull(),
    relPath: text('rel_path'),
    relPathKey: text('rel_path_key'),
    folder: text('folder'),
    folderKey: text('folder_key'),
    topModuleKey: text('top_module_key'),
    depth: integer('depth'),
    fileKind: varchar('file_kind', { length: 16 }), // 'source' | 'test' | 'config' | 'docs' | 'other'
    extension: varchar('extension', { length: 32 }), // lowercased, no dot; '' when none
    outsideRepo: boolean('outside_repo').notNull().default(false),
    changeKind: varchar('change_kind', { length: 16 }).notNull(), // 'added' | 'modified' ('deleted' reserved)
    editCalls: integer('edit_calls').notNull().default(0),
    diffCoveredCalls: integer('diff_covered_calls').notNull().default(0),
    linesAdded: integer('lines_added').notNull().default(0),
    linesRemoved: integer('lines_removed').notNull().default(0),
  },
  (table) => [
    // Enforced in SQL as a unique *index* rather than a table constraint, because
    // `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT EXISTS` form and every migration in
    // this repo must be re-runnable. The uniqueness guarantee is identical.
    uniqueIndex('session_changed_paths_session_path_key_unique').on(
      table.sessionId,
      table.pathKey,
    ),
    index('idx_session_changed_paths_session_id').on(table.sessionId),
    index('idx_session_changed_paths_session_folder').on(
      table.sessionId,
      table.folderKey,
    ),
  ],
);

/**
 * Repository code-size snapshots — the denominator for "share of the codebase
 * touched". One row per `(repo_id, captured_at, branch)`, uploaded by the hook at most
 * once per 6 hours.
 *
 * A history, not one current row per repo: a report divides by the newest snapshot *at or
 * before its period end*, never by today's. Growth is bounded by the
 * writer, which prunes everything outside the newest `REPO_CODE_INVENTORY_KEEP` rows for
 * that repo after each insert.
 *
 * `branch` is `NOT NULL DEFAULT ''` rather than nullable on purpose: Postgres treats NULLs
 * as distinct in a unique index, so a nullable column would make the index below never
 * collide and a re-uploaded snapshot would insert a duplicate instead of being idempotent.
 */
export const repoCodeInventory = pgTable(
  'repo_code_inventory',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    branch: varchar('branch', { length: 255 }).notNull().default(''),
    commitSha: varchar('commit_sha', { length: 40 }),
    trackedFiles: integer('tracked_files').notNull(),
    trackedLines: bigint('tracked_lines', { mode: 'number' }).notNull(),
    trackedBinaryFiles: integer('tracked_binary_files').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Makes a re-uploaded snapshot idempotent (see the `branch` note above).
    uniqueIndex('repo_code_inventory_repo_captured_branch_unique').on(
      table.repoId,
      table.capturedAt,
      table.branch,
    ),
    // Serves the newest-at-or-before lookup.
    index('idx_repo_code_inventory_repo_captured_at').on(
      table.repoId,
      table.capturedAt,
    ),
  ],
);

// patterns are JavaScript regexp strings matched against repo-root-relative paths (forward slashes)
export interface FileCategory {
  name: string;
  patterns: string[];
}

export interface RepoConfigJson {
  fileCategories: FileCategory[];
  /**
   * Per-turn cache-creation token count at or above which a turn counts as
   * "high cache creation" and is attributed to a cause (compaction / file re-read).
   *
   * Optional and scoped exactly like `fileCategories`: a team-wide value and a personal
   * override can be in force for the same repository at once, resolved
   * user row -> team row -> `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD`
   * (`server/src/logs/cache-ratio.sql.ts`). There is deliberately no DB default — absent
   * means "use the constant", so the product value can change without a migration.
   */
  highCacheCreationThreshold?: number;

  /**
   * Turn-End Cost Advisor feature switch. Dual-scope exactly like
   * `fileCategories`: a team-wide value (`team_repo_config`) and a personal override
   * (`repo_config`) can be in force for the same repository at once, resolved by
   * `resolveEffectiveConfig()` (personal view: user -> team -> default; team view:
   * team -> default). Absent means the feature is off;
   * there is no built-in default `minSessionCostUsd` — absent there means "gate never
   * met" (see `turn-end-cost-advisor.service.ts`).
   */
  turnEndCostAdvisor?: { enabled: boolean; minSessionCostUsd?: number };

  /**
   * AI Session Attribution definitions. Team-only scope (`team_repo_config`)
   * resolved by `resolveTeamOnlyConfig()` — deliberately NOT merged with
   * `fileCategories`'/`turnEndCostAdvisor`'s user-then-team resolution, and never present
   * on a personal `repoConfig` row. Absent means "use `DEFAULT_ATTRIBUTES`"
   * for a repo that belongs to a team; a repo resolving to `teamId: null`
   * short-circuits to `{ enabled: false, attributes: [] }` before this field is even
   * consulted.
   */
  sessionAttribution?: {
    enabled: boolean;
    attributes: SessionAttributionAttributeDef[];
  };
}

/**
 * One AI Session Attribution attribute definition, as stored in
 * `RepoConfigJson.sessionAttribution.attributes` and returned by the combined config GET's
 * `AttributeDef` response shape. `key` is immutable once saved — its
 * bound `type` cannot change for as long as any `key` has ever been used, even across a
 * remove/re-add, because historical `session_attribution.values` are typed by it.
 */
export type SessionAttributionAttributeType =
  | 'string'
  | 'string[]'
  | 'boolean'
  | 'number';

export interface SessionAttributionAttributeDef {
  key: string;
  label: string;
  type: SessionAttributionAttributeType;
  prompt: string;
}

// Personal repo config only — one row per (repo_id, user_id). The team config lives in
// `teamRepoConfig`, keyed by the team-repository link (migration 0072 dropped `team_id`).
// The partial unique index on (repo_id, user_id) is defined in SQL migration only — Drizzle
// ORM does not support WHERE clauses on unique indexes declaratively.
export const repoConfig = pgTable(
  'repo_config',
  {
    repoId: integer('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
      }),
    config: jsonb('config').$type<RepoConfigJson>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_repo_config_repo_id').on(table.repoId)],
);

// The single team config of a (team, repoUrl) pair, owned by its `team_repositories` link: the
// FK cascade removes it on every link-delete path. No row means `teamConfig = null`.
export const teamRepoConfig = pgTable('team_repo_config', {
  teamRepositoryId: integer('team_repository_id')
    .primaryKey()
    .references(() => teamRepositories.id, { onDelete: 'cascade' }),
  config: jsonb('config').$type<RepoConfigJson>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userFavoriteSessions = pgTable(
  'user_favorite_sessions',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);

// Partial unique indexes are defined in SQL migration only — Drizzle ORM does not support
// WHERE clauses on unique indexes declaratively.
export const sessionFileStats = pgTable(
  'session_file_stats',
  {
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    categoryName: varchar('category_name', { length: 64 }).notNull(),
    fileCount: integer('file_count').notNull().default(0),
    byteCount: bigint('byte_count', { mode: 'number' }).notNull().default(0),
    teamId: integer('team_id').references(() => teams.id, {
      onDelete: 'cascade',
    }),
    userId: integer('user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
  },
  (table) => [index('idx_session_file_stats_session_id').on(table.sessionId)],
);

// Cache-creation cause decomposition per session, scoped like `sessionFileStats`
// (nullable team_id / user_id) because the high-cache-creation threshold it is computed
// with is a scoped `repo_config` field: a team-wide value and a personal override must be
// able to coexist for the same session. `threshold` records the value these totals were
// computed with. Invariant (test-enforced): the three *_tokens columns sum to that
// session's `sessionStats.cacheWriteTokens`.
//
// Partial unique indexes — UNIQUE (session_id, team_id) WHERE team_id IS NOT NULL and
// UNIQUE (session_id, user_id) WHERE user_id IS NOT NULL, the two `ON CONFLICT` targets
// of the scoped upsert — are defined in the SQL migration only, as Drizzle ORM does not
// support WHERE clauses on unique indexes declaratively (same as `repoConfig` above).
export const sessionCauseStats = pgTable(
  'session_cause_stats',
  {
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    teamId: integer('team_id').references(() => teams.id, {
      onDelete: 'cascade',
    }),
    userId: integer('user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    threshold: integer('threshold').notNull(),
    compactionTokens: bigint('compaction_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    fileRereadTokens: bigint('file_reread_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    unattributedTokens: bigint('unattributed_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    compactionTurns: integer('compaction_turns').notNull().default(0),
    fileRereadTurns: integer('file_reread_turns').notNull().default(0),
    unattributedTurns: integer('unattributed_turns').notNull().default(0),
  },
  (table) => [index('idx_session_cause_stats_session_id').on(table.sessionId)],
);

export const uploadQueue = pgTable(
  'upload_queue',
  {
    id: serial('id').primaryKey(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sessionId: varchar('session_id', { length: 255 }).notNull(),
    logType: varchar('log_type', { length: 50 }).notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentSessionId: varchar('parent_session_id', { length: 255 }),
    workflowRunId: varchar('workflow_run_id', { length: 255 }),
    status: uploadQueueStatusEnum('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    uploadId: varchar('upload_id', { length: 255 }),
    chunksReceived: integer('chunks_received'),
    totalChunks: integer('total_chunks'),
    // Migration 0068: set true once a `rejected_foreign_session` row's warning has been
    // returned to the hook, so each rejection is reported exactly once.
    warningDelivered: boolean('warning_delivered').notNull().default(false),
    // Migration 0073: set only when the upload's `snapshotFull=1` query param carried a full
    // harness-snapshot body (DD-8), so isHarnessSnapshotKnown can treat a snapshot id as
    // "already in flight" while its upload_queue row is pending/processing/partially_uploaded,
    // even before the ingest transaction has stored the harness_snapshots row. No FK and no
    // index: only matched together with user_id and status in that check, on a bounded-size
    // queue table.
    harnessSnapshotId: varchar('harness_snapshot_id', { length: 64 }),
  },
  (table) => [
    index('idx_upload_queue_status_received_at').on(
      table.status,
      table.receivedAt,
    ),
    index('idx_upload_queue_user_id').on(table.userId),
    index('idx_upload_queue_user_id_status').on(table.userId, table.status),
    index('idx_upload_queue_session_id_received_at').on(
      table.sessionId,
      table.receivedAt,
    ),
    uniqueIndex('idx_upload_queue_upload_id')
      .on(table.uploadId)
      .where(sql`${table.uploadId} IS NOT NULL`),
  ],
);

/**
 * Per-attempt worker measurements for the admin Upload Queue stats block
 * (migration 0059). **Append-only**: one row per completed processing attempt, success or
 * failure, written by `UploadQueueSchedulerService`. The table exists because the
 * `upload_queue` row is deleted on success and each of the 3–15 cluster workers runs its own
 * scheduler, so neither the queue table nor in-process counters can report throughput.
 *
 * `sessionId` is a raw string with **no FK** into `sessions(id)` (same
 * precedent as `turnEndAdvisorRuns` below): the parent session may never have been ingested
 * (a failed attempt) or may already have been purged by retention while the measurement is
 * still inside the stats window.
 *
 * Rows are pruned by the worker once `finished_at` falls outside
 * `UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS` (default 7 days), which bounds the table.
 */
export const uploadQueueMeasurements = pgTable(
  'upload_queue_measurements',
  {
    id: serial('id').primaryKey(),
    sessionId: varchar('session_id', { length: 255 }).notNull(),
    logType: varchar('log_type', { length: 50 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    /** Active parse time, denormalised at write time. */
    durationMs: integer('duration_ms').notNull(),
    /** `finished_at − received_at` — the end-to-end wait the uploader feels. */
    queueLatencyMs: bigint('queue_latency_ms', { mode: 'number' }).notNull(),
    /** The queue row's size, copied verbatim on both outcomes; only `success` rows feed throughput. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    outcome: varchar('outcome', { length: 20 })
      .notNull()
      .$type<UploadQueueMeasurementOutcome>(),
  },
  (table) => [
    // The only index this table needs: it serves the 15-minute window, the 7-day window and
    // the retention prune, all of which key off `finished_at`.
    //
    // There is deliberately NO index on `session_id` (dropped again in migration 0060): no
    // production query filters by it, the one test-cleanup delete that does is a seq scan at
    // realistic sizes anyway, and indexing a random-UUID column costs page splits on every
    // insert on the upload hot path for zero reads.
    index('idx_upload_queue_measurements_finished_at').on(table.finishedAt),
  ],
);

// `id` is app-generated (randomUUID()), not serial: the upload-staging endpoint must mint
// the id before any row exists (it doubles as the staged file's on-disk name).
export const exportImportJobs = pgTable(
  'export_import_jobs',
  {
    // 64, not 36 (a bare UUID's length): `staged_upload` rows key this column
    // by the staged file's own generated name — `randomUUID() + '.zip'`, 40
    // chars — not a bare UUID.
    id: varchar('id', { length: 64 }).primaryKey(),
    kind: exportImportJobKindEnum('kind').notNull(),
    status: exportImportJobStatusEnum('status').notNull(),
    processed: integer('processed').notNull().default(0),
    total: integer('total').notNull().default(0),
    errorMessage: text('error_message'),
    resultFilePath: varchar('result_file_path'),
    resultFileName: varchar('result_file_name'),
    repoId: integer('repo_id').references(() => repositories.id, {
      onDelete: 'cascade',
    }),
    userId: integer('user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_export_import_jobs_status_updated_at').on(
      table.status,
      table.updatedAt,
    ),
    index('idx_export_import_jobs_repo_id').on(table.repoId),
    index('idx_export_import_jobs_user_id').on(table.userId),
  ],
);

/**
 * Turn-End Cost Advisor run log (migration 0055). Append-only, one row per
 * evaluation attempt; rows are written only for `outcome ∈
 * {'submitted','failed'}` — a session below the cost threshold or with the feature off
 * never gets a row at all. `sessionId` is the invoking session directly
 * (unlike the attribution runs table below, there is no `hook_service` marker indirection to
 * resolve), so this same table doubles as display-persistence: the pane reads the latest
 * `outcome='submitted'` row per session, and overlapping runs on
 * rapid consecutive turns are permitted rather than locked.
 */
export const turnEndAdvisorRuns = pgTable(
  'turn_end_advisor_runs',
  {
    id: serial('id').primaryKey(),
    // Raw string session UUID, not an FK into sessions(id) — a run can now be recorded
    // for a session the server has never ingested yet (migration 0058). No `.references()`.
    sessionId: varchar('session_id', { length: 255 }).notNull(),
    // Migration 0067: the user whose API key recorded the run. Every read filters on it
    // equalling the session owner; NULL (unmatched backfill) never matches.
    userId: integer('user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    evalSessionId: varchar('eval_session_id', { length: 255 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    outcome: varchar('outcome', { length: 20 }).notNull(), // 'submitted' | 'failed'
    summaryGeneral: text('summary_general'),
    costFactors: jsonb('cost_factors').$type<string[]>(),
    harnessAdvice: jsonb('harness_advice').$type<string[]>(),
    failureReason: text('failure_reason'),
    model: varchar('model', { length: 64 }),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Migration 0067: owner-filtered "latest run" lookup. Its leading session_id also
    // serves every session_id-only lookup (the run-log scan, the Advisor Spend Executive
    // Summary join), which is why 0070 dropped the single-column
    // idx_turn_end_advisor_runs_session_id.
    index('turn_end_advisor_runs_session_user_idx').on(
      table.sessionId,
      table.userId,
      table.startedAt.desc(),
    ),
    // Migration 0070: backs the user_id FK's ON DELETE CASCADE.
    index('idx_turn_end_advisor_runs_user_id').on(table.userId),
  ],
);

/**
 * AI Session Attribution (migration 0056). One row per session, the current
 * resolved attribute values (keyed by attribute `key`). `values` is written only by the
 * conditional upsert in `session-attribution.service.ts` (higher `promptWatermark` wins)
 * — never partially patched.
 *
 * This table's GIN index (`idx_session_attribution_values_gin`, `jsonb_path_ops`) is
 * declared in the SQL migration only, not here — same convention as `repoConfig` /
 * `sessionCauseStats`'s partial unique indexes above: Drizzle ORM's declarative index
 * builder does not reliably round-trip a `jsonb_path_ops` operator class, and this is the
 * first GIN index in the codebase, so its exact DDL is hand-verified
 * in the migration rather than assumed from a sibling.
 */
export const sessionAttribution = pgTable('session_attribution', {
  sessionId: integer('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  promptWatermark: integer('prompt_watermark').notNull(),
  values: jsonb('values')
    .$type<Record<string, string | string[] | boolean | number | null>>()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * AI Session Attribution run log (migration 0056). Append-only, one row per
 * evaluation, mirroring `turnEndAdvisorRuns`'s own-cost-columns shape (never joined via
 * `session_stats`). Unlike `turnEndAdvisorRuns`, `sessionId` here is NOT necessarily the
 * invoking session's own row — the evaluation runs as a separate spawned session, so
 * `invokingSessionId` carries the string session id it was invoked on behalf of
 * for the Attribution Spend Executive Summary section's join-back.
 */
export const sessionAttributionRuns = pgTable(
  'session_attribution_runs',
  {
    id: serial('id').primaryKey(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    promptWatermark: integer('prompt_watermark').notNull(),
    evalSessionId: varchar('eval_session_id', { length: 255 }),
    invokingSessionId: varchar('invoking_session_id', { length: 255 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    outcome: varchar('outcome', { length: 20 }).notNull(), // 'applied' | 'ignored_stale' | 'failed'
    // Migration 0057 -- mirrors turnEndAdvisorRuns.failureReason; set
    // only on outcome='failed', surfaced via getRepositorySessions()'s lastRun field.
    failureReason: text('failure_reason'),
    model: varchar('model', { length: 64 }),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' })
      .notNull()
      .default(0),
  },
  (table) => [
    index('idx_session_attribution_runs_session_id').on(table.sessionId),
  ],
);

/**
 * Per-session prompt watermark (migration 0056). Written only by the
 * combined config-resolution GET's side effect, monotonically (`GREATEST`) — this is what
 * `evaluationRequired` compares the attribution branch's own
 * `evaluatedWatermark` against.
 */
export const sessionPromptWatermark = pgTable('session_prompt_watermark', {
  sessionId: integer('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  promptWatermark: integer('prompt_watermark').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** The `{ stable, latest }` npm dist-tags stored in `ai_tool_version(_history).version_map`. */
export interface AiToolVersionMap {
  stable: string;
  latest: string;
}

/**
 * Claude Code version check (migration 0065) — one row per AI tool (e.g. `claude-code`).
 * `versionMap` is NULL until the first successful npm dist-tags fetch. `lastAttemptAt` is
 * the cluster claim: a worker claims a fetch by setting it in a conditional UPDATE, so only
 * one instance calls npm per stale window.
 */
export const aiToolVersion = pgTable('ai_tool_version', {
  toolName: varchar('tool_name', { length: 64 }).primaryKey(),
  versionMap: jsonb('version_map').$type<AiToolVersionMap>(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
});

/**
 * Append-only history of distinct `{ stable, latest }` maps per tool (migration 0065). A row
 * is inserted only when a successful fetch observes a map that differs from the tool's
 * newest row; `effectiveFrom` equals that fetch's `fetched_at`.
 */
export const aiToolVersionHistory = pgTable(
  'ai_tool_version_history',
  {
    id: serial('id').primaryKey(),
    toolName: varchar('tool_name', { length: 64 }).notNull(),
    versionMap: jsonb('version_map').$type<AiToolVersionMap>().notNull(),
    effectiveFrom: timestamp('effective_from', {
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index('ai_tool_version_history_tool_effective_idx').on(
      table.toolName,
      table.effectiveFrom,
    ),
  ],
);

/**
 * Server-generated secrets (migration 0069) — one row per named secret. Today only
 * `session_secret`: when the SESSION_SECRET env var is empty, resolveSessionSecret() inserts a
 * random value with ON CONFLICT DO NOTHING and re-reads it, so all cluster workers and every
 * restart share one value.
 */
export const serverSecrets = pgTable('server_secrets', {
  name: varchar('name', { length: 64 }).primaryKey(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
