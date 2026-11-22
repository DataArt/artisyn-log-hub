-- Remote git repositories and the credential vault (2026-11-22): a user's connections to git
-- hosts (the secret itself lives in the secret store as conn-<id>), the grants of a connection to
-- workspaces, the remotes of a workspace and the git proxy capabilities of running containers.
-- Additive only: existing workspaces have no rows here and behave as before.

CREATE TABLE IF NOT EXISTS connections (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name text NOT NULL,
    name_key text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('git', 'api')),
    provider text NOT NULL,
    base_url text NOT NULL,
    auth_method text NOT NULL,
    username text NULL,
    secret_name text NOT NULL,
    secret_hint text NULL,
    secret_updated_at timestamptz NOT NULL DEFAULT now(),
    public_key text NULL,
    key_fingerprint text NULL,
    known_hosts text NULL,
    host_key_fingerprint text NULL,
    expose_env text NULL,
    status text NOT NULL DEFAULT 'untested'
        CHECK (status IN ('untested', 'ok', 'rejected', 'host_key', 'failed')),
    status_detail text NULL,
    status_user text NULL,
    status_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name_key)
);
CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);

COMMENT ON TABLE connections IS 'A user''s connection to a git host (later also an API): provider, base URL, auth method and public metadata. The secret itself is in the secret store as conn-<id>.';
COMMENT ON COLUMN connections.id IS 'Connection id.';
COMMENT ON COLUMN connections.user_id IS 'Owner; connections are private to their owner.';
COMMENT ON COLUMN connections.name IS 'Name as the user typed it (trimmed).';
COMMENT ON COLUMN connections.name_key IS 'Lowercase name; unique per user.';
COMMENT ON COLUMN connections.kind IS 'git (a git host) or api (reserved for API connections, FR-9).';
COMMENT ON COLUMN connections.provider IS 'Provider descriptor id (connections/providers.rs).';
COMMENT ON COLUMN connections.base_url IS 'Base URL of the host (fixed by the descriptor or typed by the user).';
COMMENT ON COLUMN connections.auth_method IS 'Open-ended auth method: ssh_generated, ssh_uploaded or pat (later oauth and others).';
COMMENT ON COLUMN connections.username IS 'User name for PAT Basic auth when the provider needs one; null otherwise.';
COMMENT ON COLUMN connections.secret_name IS 'Secret store name of the private key or token: conn-<id>.';
COMMENT ON COLUMN connections.secret_hint IS 'Last 4 characters of a PAT, shown in the UI; null for SSH keys.';
COMMENT ON COLUMN connections.secret_updated_at IS 'When the secret was last set or replaced.';
COMMENT ON COLUMN connections.public_key IS 'OpenSSH public key line (SSH methods); null for a PAT.';
COMMENT ON COLUMN connections.key_fingerprint IS 'SHA256 fingerprint of the SSH key; null for a PAT.';
COMMENT ON COLUMN connections.known_hosts IS 'Pinned known_hosts lines of the SSH host; null until pinned.';
COMMENT ON COLUMN connections.host_key_fingerprint IS 'SHA256 fingerprint of the pinned SSH host key; null until pinned.';
COMMENT ON COLUMN connections.expose_env IS 'Env variable name under which a PAT is exposed to the agent in granted workspaces; null = not exposed.';
COMMENT ON COLUMN connections.status IS 'Last outcome of a server-driven operation: untested, ok, rejected, host_key or failed.';
COMMENT ON COLUMN connections.status_detail IS 'Readable detail of the last outcome; null when none.';
COMMENT ON COLUMN connections.status_user IS 'User the host authenticated in the last successful test; null when unknown.';
COMMENT ON COLUMN connections.status_at IS 'When the status was last set; null while untested.';
COMMENT ON COLUMN connections.created_at IS 'When the connection was created.';

CREATE TABLE IF NOT EXISTS connection_grants (
    connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connection_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS connection_grants_workspace_idx ON connection_grants (workspace_id);

COMMENT ON TABLE connection_grants IS 'Which workspaces may use a connection (through the git proxy, and its exposed env variable).';
COMMENT ON COLUMN connection_grants.connection_id IS 'The granted connection.';
COMMENT ON COLUMN connection_grants.workspace_id IS 'The workspace it is granted to (same owner).';
COMMENT ON COLUMN connection_grants.created_at IS 'When the grant was made.';

CREATE TABLE IF NOT EXISTS workspace_remotes (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name text NOT NULL,
    connection_id uuid NULL REFERENCES connections (id) ON DELETE SET NULL,
    connection_name text NOT NULL,
    url text NOT NULL,
    upstream_url text NOT NULL,
    default_branch text NULL,
    block_default_rewrite boolean NOT NULL DEFAULT true,
    only_ws_branches boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'untested'
        CHECK (status IN ('untested', 'ok', 'rejected', 'host_key', 'failed')),
    status_detail text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS workspace_remotes_connection_idx ON workspace_remotes (connection_id);

COMMENT ON TABLE workspace_remotes IS 'A git remote of a workspace repository, reached through the git proxy at http://wh-git/git/<id>.git.';
COMMENT ON COLUMN workspace_remotes.id IS 'Remote id; also the path of its proxy URL and of its sidecar mirror.';
COMMENT ON COLUMN workspace_remotes.workspace_id IS 'The workspace whose repository has this remote.';
COMMENT ON COLUMN workspace_remotes.name IS 'git remote name (e.g. origin); unique per workspace.';
COMMENT ON COLUMN workspace_remotes.connection_id IS 'The connection whose credential is used; null after the connection was deleted.';
COMMENT ON COLUMN workspace_remotes.connection_name IS 'Name of the connection, kept for the "connection was deleted" message.';
COMMENT ON COLUMN workspace_remotes.url IS 'Repository URL as the user pasted it.';
COMMENT ON COLUMN workspace_remotes.upstream_url IS 'Resolved URL the git proxy fetches from and pushes to (transport of the connection auth method).';
COMMENT ON COLUMN workspace_remotes.default_branch IS 'Default branch of the remote, learned by ls-remote; null until known.';
COMMENT ON COLUMN workspace_remotes.block_default_rewrite IS 'Push policy: reject a force push or delete of the default branch.';
COMMENT ON COLUMN workspace_remotes.only_ws_branches IS 'Push policy: only ws/* branches may be pushed.';
COMMENT ON COLUMN workspace_remotes.status IS 'Last outcome of a server-driven operation on this remote: untested, ok, rejected, host_key or failed.';
COMMENT ON COLUMN workspace_remotes.status_detail IS 'Readable detail of the last outcome; null when none.';
COMMENT ON COLUMN workspace_remotes.created_at IS 'When the remote was attached.';

CREATE TABLE IF NOT EXISTS git_capabilities (
    container text PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    workstream_id uuid NULL REFERENCES workstreams (id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS git_capabilities_workspace_idx ON git_capabilities (workspace_id);

COMMENT ON TABLE git_capabilities IS 'The git proxy capability of a running workspace or workstream container: the proxy lets it reach its workspace remotes only.';
COMMENT ON COLUMN git_capabilities.container IS 'Container name (wh-ws-<uuid> or wh-st-<uuid>).';
COMMENT ON COLUMN git_capabilities.workspace_id IS 'Workspace whose remotes the capability opens.';
COMMENT ON COLUMN git_capabilities.workstream_id IS 'Workstream of a workstream container; null for the workspace container.';
COMMENT ON COLUMN git_capabilities.token_hash IS 'sha256 hex of the capability token; the token itself lives only in the container''s /tmp.';
COMMENT ON COLUMN git_capabilities.created_at IS 'When the capability was issued (each container start issues a new one).';
