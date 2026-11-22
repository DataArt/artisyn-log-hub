//! The connection lifecycle (plan D14): create, edit, regenerate, delete and grants. The DB and
//! the vault are written first; the git proxy is then synced tolerantly (D1 item 10), so these
//! work while the sidecar is not ready. Only a key generation or a key import needs the proxy.

use bytes::Bytes;
use uuid::Uuid;

use super::fields::{self, FieldError};
use super::providers::{self, AuthMethod, Provider};
use super::repo::{self, ConnectionRow, ConnectionUpdate, KIND_GIT, NewConnection};
use crate::auth::users::UserRow;
use crate::docker::containers as dcontainers;
use crate::error::ApiError;
use crate::gitproxy::{self, ctl};
use crate::names as display_names;
use crate::secrets;
use crate::state::AppState;
use crate::workspaces::{self, WorkspaceRow, repo as ws_repo};

/// Message of a duplicate connection name.
pub const MSG_DUPLICATE_CONNECTION: &str = "You already have a connection with this name.";
/// Most characters in a PAT user name.
const MAX_USERNAME_CHARS: usize = 256;

/// The body of a new connection (D11a).
#[derive(Debug, Clone, Default)]
pub struct CreateInput {
    pub name: String,
    pub provider: String,
    pub base_url: Option<String>,
    pub auth_method: String,
    pub username: Option<String>,
    pub secret: Option<String>,
    pub passphrase: Option<String>,
    pub expose_env: Option<String>,
}

/// The editable fields (D11a): `None` keeps a field; `expose_env: Some(None)` turns it off.
#[derive(Debug, Clone, Default)]
pub struct UpdateInput {
    pub name: Option<String>,
    pub secret: Option<String>,
    pub passphrase: Option<String>,
    pub username: Option<String>,
    pub expose_env: Option<Option<String>>,
}

/// A secret ready for the vault, with the public metadata stored in the row.
struct NewSecret {
    value: Vec<u8>,
    hint: Option<String>,
    public_key: Option<String>,
    fingerprint: Option<String>,
}

pub(crate) fn field_error(e: FieldError) -> ApiError {
    ApiError::bad_request(e.code(), e.message())
}

/// The vault name of a connection's secret.
pub fn secret_name(id: Uuid) -> String {
    format!("conn-{id}")
}

/// The env variables that carry an agent's token (never exposable, D9).
fn agent_envs(st: &AppState) -> Vec<&'static str> {
    st.agents
        .ids()
        .into_iter()
        .filter_map(|id| st.agents.get(id).and_then(|a| a.token_env()))
        .collect()
}

fn parse_method(p: &Provider, raw: &str) -> Result<AuthMethod, ApiError> {
    AuthMethod::parse(raw)
        .filter(|m| p.supports(*m))
        .ok_or_else(|| {
            ApiError::invalid_connection("This provider does not support that sign-in method.")
        })
}

/// A trimmed, non-empty user name; `None` for an empty one.
fn clean_username(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(u) = raw.map(str::trim).filter(|u| !u.is_empty()) else {
        return Ok(None);
    };
    if u.chars().count() > MAX_USERNAME_CHARS
        || u.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(ApiError::invalid_connection(
            "Enter the user name without spaces or line breaks.",
        ));
    }
    Ok(Some(u.to_string()))
}

fn require_username(
    p: &Provider,
    method: AuthMethod,
    username: Option<&str>,
) -> Result<(), ApiError> {
    if method == AuthMethod::Pat && p.needs_username() && username.is_none() {
        return Err(ApiError::invalid_connection(
            "Enter the user name the token belongs to.",
        ));
    }
    Ok(())
}

/// Shape check of an exposed env name plus its uniqueness among the user's other connections.
async fn check_expose(
    st: &AppState,
    user_id: i64,
    except: Option<Uuid>,
    name: &str,
    method: AuthMethod,
) -> Result<(), ApiError> {
    fields::validate_expose_env(name, method, &agent_envs(st)).map_err(field_error)?;
    let taken = repo::list_for_user(&st.db, user_id)
        .await?
        .into_iter()
        .any(|c| Some(c.id) != except && c.expose_env.as_deref() == Some(name));
    if taken {
        return Err(ApiError::invalid_env_name(
            "Another connection already exposes this variable.",
        ));
    }
    Ok(())
}

/// D9: the exposed name must not clash with the `containerEnv` of a granted workspace whose
/// container is running.
async fn check_container_env(
    st: &AppState,
    name: &str,
    workspaces: &[WorkspaceRow],
) -> Result<(), ApiError> {
    for ws in workspaces {
        let container = workspaces::container_name(ws);
        let running = matches!(
            dcontainers::inspect(&st.docker, &container).await,
            Ok(Some(info)) if info.running
        );
        if running
            && workspaces::definition_env(st, &container)
                .await
                .contains_key(name)
        {
            return Err(ApiError::invalid_env_name(format!(
                "The workspace {} already sets {name} in its containerEnv.",
                ws.name
            )));
        }
    }
    Ok(())
}

/// The workspaces (any state) a connection is granted to.
async fn granted_workspaces(st: &AppState, conn_id: Uuid) -> Result<Vec<WorkspaceRow>, ApiError> {
    let mut out = Vec::new();
    for g in repo::grants_of(&st.db, conn_id).await? {
        if let Some(ws) = ws_repo::get_by_id(&st.db, g.workspace_id).await? {
            out.push(ws);
        }
    }
    Ok(out)
}

/// The private key, `PUBLIC <line>` and `FINGERPRINT <fp>` of `keygen` / `import-key`.
pub(crate) fn parse_key_report(out: &str) -> Option<(String, String, String)> {
    let mut key = String::new();
    let mut public = None;
    let mut fingerprint = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("PUBLIC ") {
            public = Some(p.trim().to_string());
        } else if let Some(f) = line.strip_prefix("FINGERPRINT ") {
            fingerprint = Some(f.trim().to_string());
        } else if public.is_none() {
            key.push_str(line);
            key.push('\n');
        }
    }
    if !key.trim_start().starts_with("-----BEGIN") {
        return None;
    }
    Some((key, public?, fingerprint?))
}

fn key_secret(out: &str) -> Result<NewSecret, ApiError> {
    let (key, public, fp) = parse_key_report(out)
        .ok_or_else(|| ApiError::internal("the git proxy returned an unreadable key report"))?;
    Ok(NewSecret {
        value: key.into_bytes(),
        hint: None,
        public_key: Some(public),
        fingerprint: Some(fp),
    })
}

/// A fresh ed25519 key pair made in the sidecar (needs a ready proxy).
async fn keygen(st: &AppState, name_key: &str) -> Result<NewSecret, ApiError> {
    let comment: String = format!("workhub-{name_key}")
        .chars()
        .map(|c| {
            if c.is_whitespace() || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let out = ctl::ctl(st, &["keygen", &comment], None, ctl::CTL_TIMEOUT).await?;
    if !out.success() {
        return Err(ApiError::internal(format!(
            "git proxy keygen exited with code {}: {}",
            out.exit_code,
            out.stderr_str().trim()
        )));
    }
    key_secret(&out.stdout_str())
}

/// An uploaded key with its passphrase removed in the sidecar (needs a ready proxy). The
/// passphrase is never stored.
async fn import_key(
    st: &AppState,
    key: &str,
    passphrase: Option<&str>,
) -> Result<NewSecret, ApiError> {
    fields::validate_private_key(key).map_err(field_error)?;
    let pass = passphrase.unwrap_or("");
    if pass.contains(['\n', '\r']) {
        return Err(ApiError::invalid_connection(
            "The passphrase cannot contain line breaks.",
        ));
    }
    let mut stdin = format!("{pass}\n").into_bytes();
    stdin.extend_from_slice(key.trim_start().as_bytes());
    if !stdin.ends_with(b"\n") {
        stdin.push(b'\n');
    }
    let out = ctl::ctl(
        st,
        &["import-key"],
        Some(Bytes::from(stdin)),
        ctl::CTL_TIMEOUT,
    )
    .await?;
    if !out.success() {
        return Err(ApiError::invalid_connection(
            "The private key could not be read. Check the passphrase and that it is a private key.",
        ));
    }
    key_secret(&out.stdout_str())
}

fn pat_secret(raw: &str) -> Result<NewSecret, ApiError> {
    let pat = raw.trim();
    fields::validate_pat(pat).map_err(field_error)?;
    let chars: Vec<char> = pat.chars().collect();
    let hint: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    Ok(NewSecret {
        value: pat.as_bytes().to_vec(),
        hint: Some(hint),
        public_key: None,
        fingerprint: None,
    })
}

/// The secret of a create or a secret replace (D14).
async fn make_secret(
    st: &AppState,
    method: AuthMethod,
    name_key: &str,
    secret: Option<&str>,
    passphrase: Option<&str>,
) -> Result<NewSecret, ApiError> {
    match method {
        AuthMethod::SshGenerated => keygen(st, name_key).await,
        AuthMethod::SshUploaded => {
            let key = secret
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| field_error(FieldError::PrivateKey))?;
            import_key(st, key, passphrase).await
        }
        AuthMethod::Pat => pat_secret(secret.ok_or_else(|| field_error(FieldError::Pat))?),
    }
}

/// `sync_connection` that only logs when the proxy is not ready (D1 item 10).
async fn sync_tolerant(st: &AppState, id: Uuid) {
    if let Err(e) = gitproxy::sync_connection(st, id).await {
        tracing::info!(
            "connection {id}: not synced to the git proxy: {}",
            e.message
        );
    }
}

async fn sync_routes_tolerant(st: &AppState) {
    if let Err(e) = gitproxy::sync_routes(st).await {
        tracing::info!("git proxy routes not synced: {}", e.message);
    }
}

async fn owned(st: &AppState, user: &UserRow, id: Uuid) -> Result<ConnectionRow, ApiError> {
    repo::get_owned(&st.db, user.id, id)
        .await?
        .ok_or_else(ApiError::not_found)
}

/// Creates a connection (D14): field rules, the secret (key generation / import in the sidecar,
/// or the PAT), the vault entry `conn-<id>`, the row, then a tolerant sync to the git proxy.
pub async fn create(
    st: &AppState,
    user: &UserRow,
    input: CreateInput,
) -> Result<ConnectionRow, ApiError> {
    let name =
        display_names::validate_display_name(&input.name).map_err(ApiError::invalid_connection)?;
    let name_key = display_names::name_key(&name);
    let p = providers::get(&input.provider)
        .filter(|p| p.kind == KIND_GIT)
        .ok_or_else(|| ApiError::invalid_connection("Choose one of the listed providers."))?;
    let base_url = fields::validate_base_url(p, input.base_url.as_deref().unwrap_or(""))
        .map_err(field_error)?;
    let method = parse_method(p, &input.auth_method)?;
    let username = clean_username(input.username.as_deref())?;
    require_username(p, method, username.as_deref())?;
    let expose = input
        .expose_env
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string);
    if let Some(e) = &expose {
        check_expose(st, user.id, None, e, method).await?;
    }
    if repo::list_for_user(&st.db, user.id)
        .await?
        .iter()
        .any(|c| c.name_key == name_key)
    {
        return Err(ApiError::duplicate_name(MSG_DUPLICATE_CONNECTION));
    }
    let secret = make_secret(
        st,
        method,
        &name_key,
        input.secret.as_deref(),
        input.passphrase.as_deref(),
    )
    .await?;

    let id = Uuid::new_v4();
    let vault_name = secret_name(id);
    secrets::put(st, user.id, &vault_name, &secret.value).await?;
    let new = NewConnection {
        id,
        user_id: user.id,
        name: &name,
        name_key: &name_key,
        kind: KIND_GIT,
        provider: p.id,
        base_url: &base_url,
        auth_method: method.as_str(),
        username: username.as_deref(),
        secret_name: &vault_name,
        secret_hint: secret.hint.as_deref(),
        public_key: secret.public_key.as_deref(),
        key_fingerprint: secret.fingerprint.as_deref(),
        expose_env: expose.as_deref(),
    };
    let row = match repo::insert(&st.db, &new).await {
        Ok(row) => row,
        Err(e) => {
            let _ = secrets::delete(st, user.id, &vault_name).await;
            return Err(if ws_repo::is_unique_violation(&e) {
                ApiError::duplicate_name(MSG_DUPLICATE_CONNECTION)
            } else {
                e.into()
            });
        }
    };
    sync_tolerant(st, id).await;
    Ok(row)
}

/// Edits a connection (D14): rename, user name, exposed variable (with the D9 `containerEnv`
/// check) and a secret replace (status back to `untested`). Provider, base URL and auth method
/// never change.
pub async fn update(
    st: &AppState,
    user: &UserRow,
    id: Uuid,
    input: UpdateInput,
) -> Result<ConnectionRow, ApiError> {
    let row = owned(st, user, id).await?;
    let p = providers::get(&row.provider)
        .ok_or_else(|| ApiError::internal(format!("connection {id}: unknown provider")))?;
    let method = AuthMethod::parse(&row.auth_method)
        .ok_or_else(|| ApiError::internal(format!("connection {id}: unknown auth method")))?;

    let name = match input.name.as_deref() {
        Some(raw) => {
            let n =
                display_names::validate_display_name(raw).map_err(ApiError::invalid_connection)?;
            let k = display_names::name_key(&n);
            if k != row.name_key
                && repo::list_for_user(&st.db, user.id)
                    .await?
                    .iter()
                    .any(|c| c.id != id && c.name_key == k)
            {
                return Err(ApiError::duplicate_name(MSG_DUPLICATE_CONNECTION));
            }
            Some((n, k))
        }
        None => None,
    };
    let username = match input.username.as_deref() {
        Some(raw) => {
            let u = clean_username(Some(raw))?;
            require_username(p, method, u.as_deref())?;
            Some(u)
        }
        None => None,
    };
    let expose = match &input.expose_env {
        Some(Some(raw)) if !raw.trim().is_empty() => {
            let e = raw.trim().to_string();
            check_expose(st, user.id, Some(id), &e, method).await?;
            check_container_env(st, &e, &granted_workspaces(st, id).await?).await?;
            Some(Some(e))
        }
        Some(_) => Some(None),
        None => None,
    };
    let secret = match input.secret.as_deref() {
        Some(_) if method == AuthMethod::SshGenerated => {
            return Err(ApiError::invalid_connection(
                "A key generated by Work Hub cannot be replaced; regenerate it instead.",
            ));
        }
        Some(s) => Some(
            make_secret(
                st,
                method,
                &row.name_key,
                Some(s),
                input.passphrase.as_deref(),
            )
            .await?,
        ),
        None => None,
    };

    let fields_update = ConnectionUpdate {
        name: name.as_ref().map(|(n, k)| (n.as_str(), k.as_str())),
        username: username.as_ref().map(|u| u.as_deref()),
        expose_env: expose.as_ref().map(|e| e.as_deref()),
    };
    match repo::update_fields(&st.db, user.id, id, &fields_update).await {
        Ok(Some(_)) => {}
        Ok(None) => return Err(ApiError::not_found()),
        Err(e) if ws_repo::is_unique_violation(&e) => {
            return Err(ApiError::duplicate_name(MSG_DUPLICATE_CONNECTION));
        }
        Err(e) => return Err(e.into()),
    }
    if let Some(s) = &secret {
        secrets::put(st, user.id, &row.secret_name, &s.value).await?;
        repo::set_secret_meta(
            &st.db,
            id,
            s.hint.as_deref(),
            s.public_key.as_deref(),
            s.fingerprint.as_deref(),
        )
        .await?;
    }
    if secret.is_some() || username.is_some() {
        sync_tolerant(st, id).await;
    }
    owned(st, user, id).await
}

/// A new key pair for an `ssh_generated` connection (D14); the pinned host key is kept.
pub async fn regenerate_key(
    st: &AppState,
    user: &UserRow,
    id: Uuid,
) -> Result<ConnectionRow, ApiError> {
    let row = owned(st, user, id).await?;
    if AuthMethod::parse(&row.auth_method) != Some(AuthMethod::SshGenerated) {
        return Err(ApiError::not_generated_key());
    }
    let s = keygen(st, &row.name_key).await?;
    secrets::put(st, user.id, &row.secret_name, &s.value).await?;
    repo::set_secret_meta(
        &st.db,
        id,
        None,
        s.public_key.as_deref(),
        s.fingerprint.as_deref(),
    )
    .await?;
    sync_tolerant(st, id).await;
    owned(st, user, id).await
}

/// Deletes a connection (D14). Without `force`, 409 `connection_in_use` while remotes use it;
/// otherwise the row (grants cascade, remotes keep its name), the vault entry, then a tolerant
/// `drop_connection` and `sync_routes`.
pub async fn delete(st: &AppState, user: &UserRow, id: Uuid, force: bool) -> Result<(), ApiError> {
    let row = owned(st, user, id).await?;
    if !force {
        let mut in_use: Vec<(Uuid, String)> = Vec::new();
        for u in repo::used_by(&st.db, id).await? {
            if !in_use.iter().any(|(wid, _)| *wid == u.workspace_id) {
                in_use.push((u.workspace_id, u.workspace_name));
            }
        }
        if !in_use.is_empty() {
            return Err(ApiError::connection_in_use(in_use));
        }
    }
    if !repo::delete(&st.db, user.id, id).await? {
        return Err(ApiError::not_found());
    }
    secrets::delete(st, user.id, &row.secret_name).await?;
    if let Err(e) = gitproxy::drop_connection(st, id).await {
        tracing::info!(
            "connection {id}: not dropped from the git proxy: {}",
            e.message
        );
    }
    sync_routes_tolerant(st).await;
    Ok(())
}

/// Replaces the workspaces a connection is granted to. Every id must be one of the user's ready
/// workspaces (else 404); an exposed variable must not clash with a running workspace's
/// `containerEnv` (D9).
pub async fn set_grants(
    st: &AppState,
    user: &UserRow,
    id: Uuid,
    workspace_ids: &[Uuid],
) -> Result<ConnectionRow, ApiError> {
    let row = owned(st, user, id).await?;
    let mut targets: Vec<WorkspaceRow> = Vec::new();
    for wid in workspace_ids {
        if targets.iter().any(|w| w.id == *wid) {
            continue;
        }
        let ws = ws_repo::get_owned(&st.db, user.id, *wid)
            .await?
            .ok_or_else(ApiError::not_found)?;
        targets.push(ws);
    }
    if let Some(name) = row.expose_env.as_deref() {
        check_container_env(st, name, &targets).await?;
    }
    let ids: Vec<Uuid> = targets.iter().map(|w| w.id).collect();
    repo::replace_grants(&st.db, user.id, id, &ids).await?;
    sync_routes_tolerant(st).await;
    Ok(row)
}
