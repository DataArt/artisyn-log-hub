//! Admin routes (FR-12, plan D15): session required; a user not listed in
//! `WORK_HUB_ADMIN_EMAILS` answers 403 `forbidden`.

use axum::Json;
use axum::extract::State;

use crate::admin::{self, Overview};
use crate::auth::{self, CurrentUser};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// `GET /api/v1/admin/overview` → [`Overview`].
pub async fn overview(State(st): State<AppState>, user: CurrentUser) -> ApiResult<Json<Overview>> {
    if !auth::is_admin(&st.config, &user.user) {
        return Err(ApiError::forbidden());
    }
    Ok(Json(admin::overview(&st).await?))
}
