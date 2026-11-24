//! Connections routes (API changes → Connections): the provider list, the user's connections to
//! git hosts, their Test, key regeneration, grants and the branch list of a repository. A
//! missing, foreign or malformed id answers 404 (D4).

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Deserializer, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use super::IdPath;
use crate::auth::CurrentUser;
use crate::connections::providers::{self, Provider};
use crate::connections::repo::{self, ConnectionRow};
use crate::connections::{self, CreateInput, UpdateInput};
use crate::error::{ApiError, ApiResult};
use crate::secrets;
use crate::state::AppState;

/// `ProviderInfo` of the API. Page URLs keep their `{web}` placeholder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: &'static str,
    pub display_name: &'static str,
    pub short_label: &'static str,
    pub kind: &'static str,
    pub auth_methods: Vec<&'static str>,
    pub base_url_fixed: Option<&'static str>,
    pub base_url_placeholder: &'static str,
    /// Hosted instance offered as an alternative to a self-managed URL (null = none).
    pub base_url_hosted: Option<&'static str>,
    pub needs_username: bool,
    pub allow_http: bool,
    pub token_page_url: Option<&'static str>,
    pub token_scopes: Option<&'static str>,
    pub ssh_keys_page_url: Option<&'static str>,
    pub pr_label: Option<&'static str>,
    pub test_needs_url: bool,
}

impl ProviderInfo {
    fn of(p: &'static Provider) -> Self {
        Self {
            id: p.id,
            display_name: p.display_name,
            short_label: p.short_label,
            kind: p.kind,
            auth_methods: p.auth_methods.iter().map(|m| m.as_str()).collect(),
            base_url_fixed: p.base_fixed,
            base_url_placeholder: p.base_placeholder,
            base_url_hosted: p.base_hosted,
            needs_username: p.needs_username(),
            allow_http: p.allow_http,
            token_page_url: p.token_page,
            token_scopes: p.token_scopes,
            ssh_keys_page_url: p.ssh_keys_page,
            pr_label: p.pr_label,
            test_needs_url: p.test_needs_url,
        }
    }
}

/// A workspace a connection is granted to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub workspace_id: Uuid,
    pub workspace_name: String,
}

/// A remote that uses a connection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedBy {
    pub workspace_id: Uuid,
    pub workspace_name: String,
    pub remote_name: String,
}

/// `Connection` of the API. The secret itself is never part of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub provider: String,
    pub provider_name: String,
    pub base_url: String,
    pub auth_method: String,
    pub username: Option<String>,
    pub secret_set: bool,
    pub secret_hint: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub secret_updated_at: OffsetDateTime,
    pub public_key: Option<String>,
    pub key_fingerprint: Option<String>,
    pub host_key_fingerprint: Option<String>,
    pub expose_env: Option<String>,
    pub status: String,
    pub status_detail: Option<String>,
    pub status_user: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub status_at: Option<OffsetDateTime>,
    pub grants: Vec<Grant>,
    pub used_by: Vec<UsedBy>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A scanned SSH host key (`TestResult.hostKey`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    pub fingerprint: String,
    pub key_type: String,
}

/// `TestResult` of the API.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub result: &'static str,
    pub user: Option<String>,
    pub message: Option<String>,
    pub host_key: Option<HostKey>,
}

impl TestResult {
    pub fn of(r: connections::TestResult) -> Self {
        Self {
            result: r.result.as_str(),
            user: r.user,
            message: r.message,
            host_key: r.host_key.map(|k| HostKey {
                fingerprint: k.fingerprint,
                key_type: k.key_type,
            }),
        }
    }
}

/// `Branches` of the API.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub default_branch: Option<String>,
    pub branches: Vec<String>,
}

/// The display name of a provider id (the id itself for an unknown one).
pub fn provider_name(id: &str) -> String {
    providers::get(id)
        .map(|p| p.display_name.to_string())
        .unwrap_or_else(|| id.to_string())
}

/// The API shape of a row, with its grants, the remotes that use it and whether the vault holds
/// its secret.
async fn connection(st: &AppState, row: ConnectionRow) -> ApiResult<Connection> {
    let grants = repo::grants_of(&st.db, row.id)
        .await?
        .into_iter()
        .map(|g| Grant {
            workspace_id: g.workspace_id,
            workspace_name: g.workspace_name,
        })
        .collect();
    let used_by = repo::used_by(&st.db, row.id)
        .await?
        .into_iter()
        .map(|u| UsedBy {
            workspace_id: u.workspace_id,
            workspace_name: u.workspace_name,
            remote_name: u.remote_name,
        })
        .collect();
    let secret_set = secrets::exists(st, row.user_id, &row.secret_name).await?;
    Ok(Connection {
        id: row.id,
        provider_name: provider_name(&row.provider),
        name: row.name,
        kind: row.kind,
        provider: row.provider,
        base_url: row.base_url,
        auth_method: row.auth_method,
        username: row.username,
        secret_set,
        secret_hint: row.secret_hint,
        secret_updated_at: row.secret_updated_at,
        public_key: row.public_key,
        key_fingerprint: row.key_fingerprint,
        host_key_fingerprint: row.host_key_fingerprint,
        expose_env: row.expose_env,
        status: row.status,
        status_detail: row.status_detail,
        status_user: row.status_user,
        status_at: row.status_at,
        grants,
        used_by,
        created_at: row.created_at,
    })
}

/// The user's connection; 404 otherwise.
async fn owned(st: &AppState, user: &CurrentUser, id: Uuid) -> ApiResult<ConnectionRow> {
    repo::get_owned(&st.db, user.id(), id)
        .await?
        .ok_or_else(ApiError::not_found)
}

/// A JSON body: 400 `invalid_body` when it does not parse.
pub(super) fn parse_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(body).map_err(|e| {
        ApiError::bad_request("invalid_body", format!("The request is not valid: {e}."))
    })
}

/// Like [`parse_body`], but an empty body is the type's default (bodies that may be `{}`).
pub(super) fn parse_body_or_default<T: serde::de::DeserializeOwned + Default>(
    body: &[u8],
) -> ApiResult<T> {
    if body.iter().all(u8::is_ascii_whitespace) {
        Ok(T::default())
    } else {
        parse_body(body)
    }
}

/// A field that tells "absent" (`None`) from `null` (`Some(None)`).
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    name: String,
    provider: String,
    #[serde(default)]
    base_url: Option<String>,
    auth_method: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    secret: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
    #[serde(default)]
    expose_env: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    secret: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    expose_env: Option<Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestBody {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    accept_host_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantsBody {
    workspace_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
struct BranchesBody {
    url: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct DeleteQuery {
    #[serde(default)]
    force: bool,
}

/// `GET /api/v1/connection-providers` → `ProviderInfo[]`.
pub async fn providers_list(_user: CurrentUser) -> Json<Vec<ProviderInfo>> {
    Json(providers::all().iter().map(ProviderInfo::of).collect())
}

/// `GET /api/v1/connections` → the user's `Connection[]`.
pub async fn list(
    State(st): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<Connection>>> {
    let rows = repo::list_for_user(&st.db, user.id()).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(connection(&st, row).await?);
    }
    Ok(Json(out))
}

/// `POST /api/v1/connections` → 201 `Connection`.
pub async fn create(
    State(st): State<AppState>,
    user: CurrentUser,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let b: CreateBody = parse_body(&body)?;
    let row = connections::create(
        &st,
        &user.user,
        CreateInput {
            name: b.name,
            provider: b.provider,
            base_url: b.base_url,
            auth_method: b.auth_method,
            username: b.username,
            secret: b.secret,
            passphrase: b.passphrase,
            expose_env: b.expose_env,
        },
    )
    .await?;
    let shape = connection(&st, row).await?;
    Ok((StatusCode::CREATED, Json(shape)).into_response())
}

/// `GET /api/v1/connections/{id}` → `Connection`.
pub async fn get(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<Connection>> {
    let row = owned(&st, &user, id).await?;
    Ok(Json(connection(&st, row).await?))
}

/// `PATCH /api/v1/connections/{id}` → `Connection`. Provider, base URL and auth method are not
/// accepted (unknown fields are ignored).
pub async fn update(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Json<Connection>> {
    owned(&st, &user, id).await?;
    let b: UpdateBody = parse_body(&body)?;
    let row = connections::update(
        &st,
        &user.user,
        id,
        UpdateInput {
            name: b.name,
            secret: b.secret,
            passphrase: b.passphrase,
            username: b.username,
            expose_env: b.expose_env,
        },
    )
    .await?;
    Ok(Json(connection(&st, row).await?))
}

/// `DELETE /api/v1/connections/{id}?force=true` → 204 · 409 `connection_in_use`.
pub async fn delete(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    Query(q): Query<DeleteQuery>,
) -> ApiResult<StatusCode> {
    let force = q.force;
    connections::delete(&st, &user.user, id, force).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/connections/{id}/test` `{url?, acceptHostKey?}` → `TestResult`.
pub async fn test(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Json<TestResult>> {
    owned(&st, &user, id).await?;
    let b: TestBody = parse_body_or_default(&body)?;
    let url = b.url.as_deref().map(str::trim).filter(|u| !u.is_empty());
    let accept = b
        .accept_host_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty());
    let result = connections::test(&st, &user.user, id, url, accept).await?;
    Ok(Json(TestResult::of(result)))
}

/// `POST /api/v1/connections/{id}/regenerate-key` `{}` → `Connection` · `not_generated_key`.
pub async fn regenerate_key(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
) -> ApiResult<Json<Connection>> {
    owned(&st, &user, id).await?;
    let row = connections::regenerate_key(&st, &user.user, id).await?;
    Ok(Json(connection(&st, row).await?))
}

/// `PUT /api/v1/connections/{id}/grants` `{workspaceIds}` → `Connection` (replaces the set).
pub async fn set_grants(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Json<Connection>> {
    owned(&st, &user, id).await?;
    let GrantsBody { workspace_ids } = parse_body(&body)?;
    let row = connections::set_grants(&st, &user.user, id, &workspace_ids).await?;
    Ok(Json(connection(&st, row).await?))
}

/// `POST /api/v1/connections/{id}/branches` `{url}` → `Branches`.
pub async fn branches(
    State(st): State<AppState>,
    user: CurrentUser,
    IdPath(id): IdPath,
    body: axum::body::Bytes,
) -> ApiResult<Json<Branches>> {
    owned(&st, &user, id).await?;
    let BranchesBody { url } = parse_body(&body)?;
    let b = connections::branches(&st, &user.user, id, &url).await?;
    Ok(Json(Branches {
        default_branch: b.default_branch,
        branches: b.branches,
    }))
}
