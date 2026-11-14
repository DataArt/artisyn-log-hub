-- Work Hub initial schema. Runs inside WORK_HUB_DB_SCHEMA (search_path set by the pool).
-- auth_sessions is created separately by tower-sessions' PostgresStore::migrate().

CREATE TABLE IF NOT EXISTS users (
    id bigserial PRIMARY KEY,
    email text NOT NULL,
    email_key text NOT NULL,
    password_hash text NULL,
    email_confirmed_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_key_unique UNIQUE (email_key)
);

COMMENT ON TABLE users IS 'Work Hub user accounts (own users, not shared with Log Hub).';
COMMENT ON COLUMN users.id IS 'User id.';
COMMENT ON COLUMN users.email IS 'Email as the user typed it (trimmed).';
COMMENT ON COLUMN users.email_key IS 'Lowercase email; the uniqueness and lookup key.';
COMMENT ON COLUMN users.password_hash IS 'Argon2id PHC string; null for users without a password (modes none and azure-oauth).';
COMMENT ON COLUMN users.email_confirmed_at IS 'When the email was confirmed (password-confirm mode); null = not confirmed.';
COMMENT ON COLUMN users.created_at IS 'When the account was created.';

CREATE TABLE IF NOT EXISTS email_tokens (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT email_tokens_kind_check CHECK (kind IN ('confirm', 'reset')),
    CONSTRAINT email_tokens_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS email_tokens_user_id_idx ON email_tokens (user_id);

COMMENT ON TABLE email_tokens IS 'One-time email confirmation and password reset tokens.';
COMMENT ON COLUMN email_tokens.id IS 'Token row id.';
COMMENT ON COLUMN email_tokens.user_id IS 'User the token belongs to.';
COMMENT ON COLUMN email_tokens.kind IS 'confirm (email confirmation, 24 h) or reset (password reset, 1 h).';
COMMENT ON COLUMN email_tokens.token_hash IS 'SHA-256 hex of the token sent by email; the token itself is never stored.';
COMMENT ON COLUMN email_tokens.expires_at IS 'After this moment the token is rejected.';
COMMENT ON COLUMN email_tokens.used_at IS 'When the token was used; null = unused.';
COMMENT ON COLUMN email_tokens.created_at IS 'When the token was issued (drives the resend cooldown).';

CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name text NOT NULL,
    name_key text NOT NULL,
    working_branch text NOT NULL DEFAULT 'main',
    agent text NOT NULL DEFAULT 'claude',
    state text NOT NULL,
    container_user text NULL,
    container_uid int NULL,
    container_gid int NULL,
    home_dir text NULL,
    base_image text NULL,
    checkpoint_seq int NOT NULL DEFAULT 0,
    checkpoint_image text NULL,
    login_state text NOT NULL DEFAULT 'missing',
    login_at timestamptz NULL,
    configure_started_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspaces_user_name_unique UNIQUE (user_id, name_key),
    CONSTRAINT workspaces_state_check CHECK (state IN ('creating', 'ready')),
    CONSTRAINT workspaces_login_state_check CHECK (login_state IN ('missing', 'ok'))
);

COMMENT ON TABLE workspaces IS 'A user''s workspace: a git repo in Docker volumes plus its container (wh-ws-<id>).';
COMMENT ON COLUMN workspaces.id IS 'Workspace uuid; also part of its Docker object names and labels.';
COMMENT ON COLUMN workspaces.user_id IS 'Owner; every query is filtered by it.';
COMMENT ON COLUMN workspaces.name IS 'Display name as the user typed it (trimmed).';
COMMENT ON COLUMN workspaces.name_key IS 'Lowercase display name; unique per user.';
COMMENT ON COLUMN workspaces.working_branch IS 'Branch checked out in /workspace/repo; base of new workstreams.';
COMMENT ON COLUMN workspaces.agent IS 'Agent adapter id (claude in the alpha).';
COMMENT ON COLUMN workspaces.state IS 'creating (being set up, hidden from lists) or ready.';
COMMENT ON COLUMN workspaces.container_user IS 'User every exec runs as; filled before ready.';
COMMENT ON COLUMN workspaces.container_uid IS 'Numeric uid of container_user.';
COMMENT ON COLUMN workspaces.container_gid IS 'Numeric gid of container_user.';
COMMENT ON COLUMN workspaces.home_dir IS 'Home directory of container_user (the home volume mount point).';
COMMENT ON COLUMN workspaces.base_image IS 'Image the container is created from (default or built devcontainer image); filled before ready.';
COMMENT ON COLUMN workspaces.checkpoint_seq IS 'Number of the last configure checkpoint; 0 = none.';
COMMENT ON COLUMN workspaces.checkpoint_image IS 'Latest checkpoint image (wh-ckpt-<id>:<seq>); preferred over base_image when set.';
COMMENT ON COLUMN workspaces.login_state IS 'Agent login as last seen: missing or ok.';
COMMENT ON COLUMN workspaces.login_at IS 'When the agent login was last seen to become ok.';
COMMENT ON COLUMN workspaces.configure_started_at IS 'When the running configure session started; null = none running.';
COMMENT ON COLUMN workspaces.created_at IS 'When the workspace was created.';

CREATE TABLE IF NOT EXISTS workstreams (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name text NOT NULL,
    name_key text NOT NULL,
    branch text NOT NULL,
    base_branch text NOT NULL,
    state text NOT NULL,
    agent_session_id uuid NOT NULL,
    opened_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz NULL,
    merged_at timestamptz NULL,
    discarded_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workstreams_state_check CHECK (state IN ('opening', 'open', 'closed', 'done', 'discarded')),
    CONSTRAINT workstreams_workspace_branch_unique UNIQUE (workspace_id, branch)
);

CREATE UNIQUE INDEX IF NOT EXISTS workstreams_workspace_name_key_active_idx
    ON workstreams (workspace_id, name_key) WHERE state <> 'discarded';

COMMENT ON TABLE workstreams IS 'A workstream: an agent chat on its own branch in its own container (wh-st-<id>).';
COMMENT ON COLUMN workstreams.id IS 'Workstream uuid; also part of its Docker object names and labels.';
COMMENT ON COLUMN workstreams.workspace_id IS 'Workspace the workstream belongs to.';
COMMENT ON COLUMN workstreams.name IS 'Display name as the user typed it (trimmed).';
COMMENT ON COLUMN workstreams.name_key IS 'Lowercase display name; unique per workspace among not discarded workstreams.';
COMMENT ON COLUMN workstreams.branch IS 'Git branch of the workstream (ws/<slug>); never reused in the workspace.';
COMMENT ON COLUMN workstreams.base_branch IS 'Working branch of the workspace when the workstream was opened.';
COMMENT ON COLUMN workstreams.state IS 'opening (hidden), open, closed, done (merged elsewhere) or discarded.';
COMMENT ON COLUMN workstreams.agent_session_id IS 'Agent session id passed to the start and resume commands.';
COMMENT ON COLUMN workstreams.opened_at IS 'When the workstream was opened.';
COMMENT ON COLUMN workstreams.closed_at IS 'When it was last closed; null while open.';
COMMENT ON COLUMN workstreams.merged_at IS 'When its branch was brought into the base branch.';
COMMENT ON COLUMN workstreams.discarded_at IS 'When it was discarded.';
COMMENT ON COLUMN workstreams.created_at IS 'When the row was inserted.';

CREATE TABLE IF NOT EXISTS terminal_recordings (
    workstream_id uuid PRIMARY KEY REFERENCES workstreams (id) ON DELETE CASCADE,
    file_name text NOT NULL,
    synced_bytes bigint NOT NULL DEFAULT 0,
    initial_cols int NOT NULL DEFAULT 120,
    initial_rows int NOT NULL DEFAULT 32,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE terminal_recordings IS 'The chat terminal recording of a workstream (a file under <DATA_DIR>/recordings).';
COMMENT ON COLUMN terminal_recordings.workstream_id IS 'Workstream the recording belongs to.';
COMMENT ON COLUMN terminal_recordings.file_name IS 'File name of the recording inside <DATA_DIR>/recordings.';
COMMENT ON COLUMN terminal_recordings.synced_bytes IS 'Bytes copied from the container into the file so far.';
COMMENT ON COLUMN terminal_recordings.initial_cols IS 'Terminal width at byte offset 0.';
COMMENT ON COLUMN terminal_recordings.initial_rows IS 'Terminal height at byte offset 0.';
COMMENT ON COLUMN terminal_recordings.updated_at IS 'When the recording was last synced.';

CREATE TABLE IF NOT EXISTS terminal_resizes (
    id bigserial PRIMARY KEY,
    workstream_id uuid NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
    byte_offset bigint NOT NULL,
    cols int NOT NULL,
    rows int NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS terminal_resizes_workstream_offset_idx
    ON terminal_resizes (workstream_id, byte_offset);

COMMENT ON TABLE terminal_resizes IS 'Terminal size changes of a chat recording, for replay.';
COMMENT ON COLUMN terminal_resizes.id IS 'Row id.';
COMMENT ON COLUMN terminal_resizes.workstream_id IS 'Workstream whose recording was resized.';
COMMENT ON COLUMN terminal_resizes.byte_offset IS 'Recording byte offset from which the new size applies.';
COMMENT ON COLUMN terminal_resizes.cols IS 'New terminal width.';
COMMENT ON COLUMN terminal_resizes.rows IS 'New terminal height.';
COMMENT ON COLUMN terminal_resizes.created_at IS 'When the resize happened.';
