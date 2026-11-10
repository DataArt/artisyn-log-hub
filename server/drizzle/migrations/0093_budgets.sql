-- Budgets, spend forecasts and threshold notices (2026-11-05 budgets-threshold-alerts).
--
-- Four new tables:
--   budgets                  one spend budget per (scope, period); the scope is stored as
--                            columns (scope_kind + user_id / team_id / repo_url), with no FK to
--                            repositories / team_repositories, so a budget is keyed by repo URL.
--   budget_notices           one row per (budget, period start, threshold) written by the
--                            threshold job; superseded_by NULL = the notice shown to recipients.
--   budget_notice_recipients who got a shown notice and when they read it.
--   budget_events            append-only log of budget CRUD, threshold crossings and emails.
--
-- Notices and events carry snapshot columns (scope, label, period, amount) and keep living with
-- budget_id NULL after the budget is deleted (ON DELETE SET NULL). Team deletion and user deletion
-- cascade through the team_id / user_id FKs. Repository removal and repo URL rewrites are handled
-- in code (BudgetsCleanup) inside the existing transactions, because there is no FK to cascade.
--
-- Additive only: no existing column, table or row is changed. Every CREATE is guarded
-- (IF NOT EXISTS), so the file is re-runnable (migrations here are hand-written, never
-- `drizzle-kit generate` -- see docs/knowledgebase/db-schema-code.md). Older server builds never
-- read or write the new tables.
--
-- Implicit backfill: none. No budget exists until a user creates one.
--
-- Lock/rewrite profile: new empty tables and their indexes only, no table rewrite. Each FK takes
-- a brief SHARE ROW EXCLUSIVE lock on the referenced users / teams table while its CREATE TABLE
-- runs (writes to it wait for an instant, reads continue); no existing rows are scanned.
--
-- Rollback: drop the four tables (budget_notice_recipients, budget_events, budget_notices,
-- budgets, in that order); nothing else depends on them.

CREATE TABLE IF NOT EXISTS budgets (
  id serial PRIMARY KEY,
  scope_kind varchar(16) NOT NULL,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  team_id integer REFERENCES teams(id) ON DELETE CASCADE,
  repo_url varchar(4000),
  period varchar(8) NOT NULL,
  amount_micros bigint NOT NULL,
  thresholds smallint[] NOT NULL DEFAULT '{75,90,100}'::smallint[],
  time_zone varchar(64) NOT NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budgets_scope_kind_check CHECK (scope_kind IN ('repo', 'team-repo', 'team')),
  CONSTRAINT budgets_period_check CHECK (period IN ('day', 'week', 'month')),
  CONSTRAINT budgets_amount_positive CHECK (amount_micros > 0),
  CONSTRAINT budgets_scope_shape CHECK (
    (scope_kind = 'repo' AND user_id IS NOT NULL AND repo_url IS NOT NULL AND team_id IS NULL)
    OR (scope_kind = 'team-repo' AND team_id IS NOT NULL AND repo_url IS NOT NULL AND user_id IS NULL)
    OR (scope_kind = 'team' AND team_id IS NOT NULL AND user_id IS NULL AND repo_url IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS budgets_scope_period_uq
  ON budgets (scope_kind, COALESCE(user_id, 0), COALESCE(team_id, 0), COALESCE(repo_url, ''), period);
CREATE INDEX IF NOT EXISTS idx_budgets_team_id ON budgets (team_id);
CREATE INDEX IF NOT EXISTS idx_budgets_user_id ON budgets (user_id);

CREATE TABLE IF NOT EXISTS budget_notices (
  id bigserial PRIMARY KEY,
  budget_id integer REFERENCES budgets(id) ON DELETE SET NULL,
  scope_kind varchar(16) NOT NULL,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  team_id integer REFERENCES teams(id) ON DELETE CASCADE,
  repo_url varchar(4000),
  budget_label varchar(64) NOT NULL,
  period varchar(8) NOT NULL,
  amount_micros bigint NOT NULL,
  time_zone varchar(64) NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  threshold smallint NOT NULL,
  spend_micros bigint NOT NULL,
  superseded_by smallint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_notices_budget_period_threshold_uq UNIQUE (budget_id, period_start, threshold),
  CONSTRAINT budget_notices_scope_shape CHECK (
    (scope_kind = 'repo' AND user_id IS NOT NULL AND repo_url IS NOT NULL AND team_id IS NULL)
    OR (scope_kind = 'team-repo' AND team_id IS NOT NULL AND repo_url IS NOT NULL AND user_id IS NULL)
    OR (scope_kind = 'team' AND team_id IS NOT NULL AND user_id IS NULL AND repo_url IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_budget_notices_team_id ON budget_notices (team_id);
CREATE INDEX IF NOT EXISTS idx_budget_notices_user_id ON budget_notices (user_id);

CREATE TABLE IF NOT EXISTS budget_notice_recipients (
  notice_id bigint NOT NULL REFERENCES budget_notices(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at timestamptz,
  PRIMARY KEY (notice_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_notice_recipients_user
  ON budget_notice_recipients (user_id, notice_id DESC);
CREATE INDEX IF NOT EXISTS idx_budget_notice_recipients_unread
  ON budget_notice_recipients (user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS budget_events (
  id bigserial PRIMARY KEY,
  budget_id integer REFERENCES budgets(id) ON DELETE SET NULL,
  scope_kind varchar(16) NOT NULL,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  team_id integer REFERENCES teams(id) ON DELETE CASCADE,
  repo_url varchar(4000),
  budget_label varchar(64) NOT NULL,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  actor_email varchar(320),
  event_type varchar(32) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_events_event_type_check CHECK (event_type IN (
    'created', 'edited', 'deleted', 'threshold_crossed', 'threshold_superseded',
    'email_sent', 'email_skipped', 'email_failed'
  )),
  CONSTRAINT budget_events_scope_shape CHECK (
    (scope_kind = 'repo' AND user_id IS NOT NULL AND repo_url IS NOT NULL AND team_id IS NULL)
    OR (scope_kind = 'team-repo' AND team_id IS NOT NULL AND repo_url IS NOT NULL AND user_id IS NULL)
    OR (scope_kind = 'team' AND team_id IS NOT NULL AND user_id IS NULL AND repo_url IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_budget_events_team ON budget_events (team_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_budget_events_user ON budget_events (user_id, id DESC);

COMMENT ON TABLE budgets IS 'Spend budget of one scope and period (at most one per scope and period); written by BudgetsService, read by SpendService and the threshold job.';
COMMENT ON COLUMN budgets.id IS 'Budget id.';
COMMENT ON COLUMN budgets.scope_kind IS 'repo (personal repository: user_id + repo_url) | team-repo (team_id + repo_url) | team (team_id only).';
COMMENT ON COLUMN budgets.user_id IS 'Owner of a personal-repository budget; NULL for team scopes.';
COMMENT ON COLUMN budgets.team_id IS 'Team of a team-repo or team budget; NULL for a personal repository.';
COMMENT ON COLUMN budgets.repo_url IS 'Repository URL of the scope (no FK; repo removal and URL rewrites are applied in code); NULL for a whole-team budget.';
COMMENT ON COLUMN budgets.period IS 'day | week (Monday start) | month, in time_zone.';
COMMENT ON COLUMN budgets.amount_micros IS 'Budget amount in micro-USD (1 USD = 1000000).';
COMMENT ON COLUMN budgets.thresholds IS 'Notice thresholds in percent of the amount (1-200), distinct, sorted ascending.';
COMMENT ON COLUMN budgets.time_zone IS 'IANA time zone the period boundaries are computed in.';
COMMENT ON COLUMN budgets.created_by IS 'User who created the budget; NULL once that user is deleted.';
COMMENT ON COLUMN budgets.created_at IS 'Creation time.';
COMMENT ON COLUMN budgets.updated_at IS 'Last edit time.';

COMMENT ON TABLE budget_notices IS 'Threshold crossing of one budget in one period, written once by the threshold job; scope and budget columns are snapshots that survive budget deletion.';
COMMENT ON COLUMN budget_notices.id IS 'Notice id.';
COMMENT ON COLUMN budget_notices.budget_id IS 'Budget that crossed the threshold; NULL once the budget is deleted.';
COMMENT ON COLUMN budget_notices.scope_kind IS 'Snapshot of budgets.scope_kind (repo | team-repo | team).';
COMMENT ON COLUMN budget_notices.user_id IS 'Snapshot of budgets.user_id; cascades the notice on user deletion.';
COMMENT ON COLUMN budget_notices.team_id IS 'Snapshot of budgets.team_id; cascades the notice on team deletion.';
COMMENT ON COLUMN budget_notices.repo_url IS 'Snapshot of budgets.repo_url; rewritten with repository URL rewrites.';
COMMENT ON COLUMN budget_notices.budget_label IS 'Snapshot label of the budget, e.g. Monthly $50.00.';
COMMENT ON COLUMN budget_notices.period IS 'Snapshot of budgets.period (day | week | month).';
COMMENT ON COLUMN budget_notices.amount_micros IS 'Snapshot of the budget amount in micro-USD.';
COMMENT ON COLUMN budget_notices.time_zone IS 'Snapshot of the budget IANA time zone.';
COMMENT ON COLUMN budget_notices.period_start IS 'Start of the budget period the threshold was crossed in (inclusive).';
COMMENT ON COLUMN budget_notices.period_end IS 'End of that budget period (exclusive).';
COMMENT ON COLUMN budget_notices.threshold IS 'Crossed threshold in percent of the amount.';
COMMENT ON COLUMN budget_notices.spend_micros IS 'Period spend in micro-USD when the crossing was detected.';
COMMENT ON COLUMN budget_notices.superseded_by IS 'NULL = shown notice; otherwise the higher threshold that replaced it in the same check (no recipients, no email).';
COMMENT ON COLUMN budget_notices.created_at IS 'Detection time.';

COMMENT ON TABLE budget_notice_recipients IS 'Recipient of a shown budget notice and their read mark; written by the threshold job, read marks by the notices API.';
COMMENT ON COLUMN budget_notice_recipients.notice_id IS 'Shown notice.';
COMMENT ON COLUMN budget_notice_recipients.user_id IS 'Recipient: the repository owner, or the team owner and managers.';
COMMENT ON COLUMN budget_notice_recipients.read_at IS 'When the recipient opened or dismissed the notice; NULL = unread.';

COMMENT ON TABLE budget_events IS 'Append-only event log of a scope''s budgets: CRUD by users, threshold crossings and email outcomes by the threshold job.';
COMMENT ON COLUMN budget_events.id IS 'Event id; also the page cursor.';
COMMENT ON COLUMN budget_events.budget_id IS 'Budget of the event; NULL once the budget is deleted.';
COMMENT ON COLUMN budget_events.scope_kind IS 'Snapshot of budgets.scope_kind (repo | team-repo | team).';
COMMENT ON COLUMN budget_events.user_id IS 'Snapshot of budgets.user_id; cascades the event on user deletion.';
COMMENT ON COLUMN budget_events.team_id IS 'Snapshot of budgets.team_id; cascades the event on team deletion.';
COMMENT ON COLUMN budget_events.repo_url IS 'Snapshot of budgets.repo_url; rewritten with repository URL rewrites.';
COMMENT ON COLUMN budget_events.budget_label IS 'Snapshot label of the budget, e.g. Monthly $50.00.';
COMMENT ON COLUMN budget_events.actor_user_id IS 'User who made the change; NULL for the threshold job or once the user is deleted.';
COMMENT ON COLUMN budget_events.actor_email IS 'Email snapshot of the actor; NULL = system (threshold job).';
COMMENT ON COLUMN budget_events.event_type IS 'created | edited | deleted | threshold_crossed | threshold_superseded | email_sent | email_skipped | email_failed.';
COMMENT ON COLUMN budget_events.details IS 'Event details: edited {before, after}; threshold_* {threshold, spendMicros, periodStart, supersededBy?}; email_* {noticeId, recipientEmail?, error?}.';
COMMENT ON COLUMN budget_events.created_at IS 'Event time.';
