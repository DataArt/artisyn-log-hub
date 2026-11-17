//! Azure Entra ID sign-in (`AUTH_MODE=azure-oauth`, single tenant), mirroring Log Hub's
//! `server/src/auth/azure/`: `GET /api/v1/auth/azure` redirects to the authority with a random
//! state and nonce kept in the session; `GET /api/auth/callback` exchanges the code, verifies the
//! ID token (signature, issuer, audience, expiry, nonce), refuses a token from another tenant and
//! signs the user in by its `email` (or `preferred_username`) claim. Every failure redirects to
//! `/#/login?oauthError=tenant|1`; the detail goes to the log only.
//!
//! The OpenID client is built lazily on first use (provider discovery needs the network, and the
//! `AZURE_*` variables only exist in this mode).

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use openidconnect::core::{
    CoreAuthDisplay, CoreAuthPrompt, CoreAuthenticationFlow, CoreErrorResponseType,
    CoreGenderClaim, CoreJsonWebKey, CoreJweContentEncryptionAlgorithm, CoreJwsSigningAlgorithm,
    CoreProviderMetadata, CoreRevocableToken, CoreRevocationErrorResponse,
    CoreTokenIntrospectionResponse, CoreTokenType,
};
use openidconnect::{
    AdditionalClaims, AuthorizationCode, Client, ClientId, ClientSecret, CsrfToken,
    EmptyExtraTokenFields, EndpointMaybeSet, EndpointNotSet, EndpointSet, IdTokenFields, IssuerUrl,
    Nonce, RedirectUrl, Scope, StandardErrorResponse, StandardTokenResponse, reqwest,
};
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use tower_sessions::Session;

use crate::auth::{AuthMode, js, require_mode, sessions, users};
use crate::config::AuthEnv;
use crate::error::ApiError;
use crate::state::AppState;

/// The Entra ID claims Work Hub reads beyond the standard ones.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AzureClaims {
    /// The directory (tenant) that issued the token.
    pub tid: Option<String>,
}

impl AdditionalClaims for AzureClaims {}

type AzureTokenResponse = StandardTokenResponse<
    IdTokenFields<
        AzureClaims,
        EmptyExtraTokenFields,
        CoreGenderClaim,
        CoreJweContentEncryptionAlgorithm,
        CoreJwsSigningAlgorithm,
    >,
    CoreTokenType,
>;

type AzureClient = Client<
    AzureClaims,
    CoreAuthDisplay,
    CoreGenderClaim,
    CoreJweContentEncryptionAlgorithm,
    CoreJsonWebKey,
    CoreAuthPrompt,
    StandardErrorResponse<CoreErrorResponseType>,
    AzureTokenResponse,
    CoreTokenIntrospectionResponse,
    CoreRevocableToken,
    CoreRevocationErrorResponse,
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointMaybeSet,
    EndpointMaybeSet,
>;

const STATE_KEY: &str = "oauthState";
const NONCE_KEY: &str = "oauthNonce";

/// The Azure settings, read from the raw auth environment (validated at startup in this mode).
#[derive(Debug, Clone, Default)]
pub struct AzureSettings {
    pub tenant_id: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub authority: String,
    pub scopes: Vec<String>,
}

/// `AZURE_AUTHORITY` when set and non-empty, else the tenant's v2.0 authority (Log Hub's
/// `resolveAzureAuthority`; also what `GET config` reports).
pub fn resolve_authority(env: &AuthEnv) -> String {
    match env.get("AZURE_AUTHORITY").map(js::trim) {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => format!(
            "https://login.microsoftonline.com/{}/v2.0",
            js::trim(env.get("AZURE_TENANT_ID").unwrap_or(""))
        ),
    }
}

impl AzureSettings {
    pub fn from_env(env: &AuthEnv) -> Self {
        let get = |n: &str| js::trim(env.get(n).unwrap_or("")).to_string();
        let scopes_raw = env
            .get("AZURE_SCOPES")
            .unwrap_or("openid profile email")
            .to_string();
        AzureSettings {
            tenant_id: get("AZURE_TENANT_ID"),
            client_id: get("AZURE_CLIENT_ID"),
            client_secret: env.get("AZURE_CLIENT_SECRET").unwrap_or("").to_string(),
            redirect_uri: get("AZURE_REDIRECT_URI"),
            authority: resolve_authority(env),
            scopes: scopes_raw
                .split(' ')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
        }
    }

    /// The issuer used for discovery: the authority, with `/v2.0` appended when missing (an
    /// MSAL-style authority `https://login.microsoftonline.com/<tenant>` names the same issuer).
    fn issuer(&self) -> String {
        let a = self.authority.trim_end_matches('/');
        if a.ends_with("/v2.0") {
            a.to_string()
        } else {
            format!("{a}/v2.0")
        }
    }
}

/// The lazily built OpenID client and its HTTP client.
pub struct AzureAuth {
    settings: AzureSettings,
    client: OnceCell<AzureClient>,
    http: reqwest::Client,
}

impl AzureAuth {
    pub fn new(settings: AzureSettings) -> Self {
        let http = reqwest::ClientBuilder::new()
            // No redirects: the SSRF guard openidconnect recommends.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        AzureAuth {
            settings,
            client: OnceCell::new(),
            http,
        }
    }

    async fn client(&self) -> Result<&AzureClient, String> {
        self.client
            .get_or_try_init(|| async {
                let s = &self.settings;
                let issuer = IssuerUrl::new(s.issuer()).map_err(|e| e.to_string())?;
                let meta = CoreProviderMetadata::discover_async(issuer, &self.http)
                    .await
                    .map_err(|e| format!("provider discovery failed: {e}"))?;
                let redirect =
                    RedirectUrl::new(s.redirect_uri.clone()).map_err(|e| e.to_string())?;
                Ok(AzureClient::from_provider_metadata(
                    meta,
                    ClientId::new(s.client_id.clone()),
                    Some(ClientSecret::new(s.client_secret.clone())),
                )
                .set_redirect_uri(redirect))
            })
            .await
    }

    /// The authority's sign-in URL for this state and nonce.
    pub async fn auth_code_url(&self, state: String, nonce: String) -> Result<String, String> {
        let client = self.client().await?;
        let mut req = client.authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            move || CsrfToken::new(state),
            move || Nonce::new(nonce),
        );
        // `openid` is always sent by the library.
        for scope in self.settings.scopes.iter().filter(|s| *s != "openid") {
            req = req.add_scope(Scope::new(scope.clone()));
        }
        let (url, _, _) = req.url();
        Ok(url.to_string())
    }

    /// Exchanges the code and verifies the ID token; returns `(tid, email)`.
    async fn exchange(
        &self,
        code: String,
        nonce: &str,
    ) -> Result<(Option<String>, Option<String>), String> {
        let client = self.client().await?;
        let token = client
            .exchange_code(AuthorizationCode::new(code))
            .map_err(|e| format!("token endpoint missing: {e}"))?
            .request_async(&self.http)
            .await
            .map_err(|e| format!("token exchange error: {e}"))?;
        let id_token = token
            .extra_fields()
            .id_token()
            .ok_or("no ID token in the token response")?;
        let claims = id_token
            .claims(&client.id_token_verifier(), &Nonce::new(nonce.to_string()))
            .map_err(|e| format!("ID token verification failed: {e}"))?;
        let email = claims
            .email()
            .map(|e| e.as_str().to_string())
            .filter(|e| !e.is_empty())
            .or_else(|| {
                claims
                    .preferred_username()
                    .map(|u| u.as_str().to_string())
                    .filter(|u| !u.is_empty())
            });
        Ok((claims.additional_claims().tid.clone(), email))
    }
}

fn redirect(location: &str) -> Response {
    (
        StatusCode::FOUND,
        [(header::LOCATION, location.to_string())],
    )
        .into_response()
}

fn random_hex16() -> String {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes[..]);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn session_err(e: tower_sessions::session::Error) -> ApiError {
    ApiError::internal(format!("session store: {e}"))
}

/// `GET /api/v1/auth/azure` (mode `azure-oauth`): 302 to the authority.
pub async fn start(State(st): State<AppState>, session: Session) -> Result<Response, ApiError> {
    require_mode(&st, &[AuthMode::AzureOauth])?;
    let (state, nonce) = (random_hex16(), random_hex16());
    session
        .insert(STATE_KEY, &state)
        .await
        .map_err(session_err)?;
    session
        .insert(NONCE_KEY, &nonce)
        .await
        .map_err(session_err)?;
    let url = st
        .azure
        .auth_code_url(state, nonce)
        .await
        .map_err(ApiError::internal)?;
    Ok(redirect(&url))
}

/// `GET /api/auth/callback` (mode `azure-oauth`). Outside `/api/v1/auth` on purpose: it is the
/// redirect URI app registrations already carry for Log Hub.
pub async fn callback(
    State(st): State<AppState>,
    session: Session,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    require_mode(&st, &[AuthMode::AzureOauth])?;
    let expected_state: Option<String> = session.remove(STATE_KEY).await.map_err(session_err)?;
    let expected_nonce: Option<String> = session.remove(NONCE_KEY).await.map_err(session_err)?;

    let fail = |detail: String, reason: &str| {
        tracing::warn!("Azure OAuth callback failed: {detail}");
        redirect(&format!("/#/login?oauthError={reason}"))
    };

    if let Some(error) = q.get("error") {
        let desc = q.get("error_description").map(String::as_str).unwrap_or("");
        return Ok(fail(format!("provider error: {error} {desc}"), "1"));
    }
    let (Some(code), Some(state), Some(expected_state), Some(expected_nonce)) = (
        q.get("code").filter(|c| !c.is_empty()),
        q.get("state").filter(|s| !s.is_empty()),
        expected_state,
        expected_nonce,
    ) else {
        return Ok(fail(
            "missing code or state/nonce validation failure".into(),
            "1",
        ));
    };
    if *state != expected_state {
        return Ok(fail(
            "missing code or state/nonce validation failure".into(),
            "1",
        ));
    }

    let (tid, email) = match st.azure.exchange(code.clone(), &expected_nonce).await {
        Ok(v) => v,
        Err(e) => return Ok(fail(e, "1")),
    };
    let expected_tenant = st.azure.settings.tenant_id.to_lowercase();
    match &tid {
        Some(t) if !expected_tenant.is_empty() && t.to_lowercase() == expected_tenant => {}
        _ => {
            return Ok(fail(
                format!(
                    "tenant mismatch (tid={})",
                    tid.as_deref().unwrap_or("missing")
                ),
                "tenant",
            ));
        }
    }
    let Some(email) = email else {
        return Ok(fail(
            "no email or preferred_username claim on ID token".into(),
            "1",
        ));
    };

    let user = users::find_or_create(&st.db, &email).await?;
    sessions::log_in(&session, &user).await?;
    Ok(redirect("/"))
}
