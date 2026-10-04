use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    AppState,
    coach_session::{self, CoachAgentResponse, CoachFeedbackResponse},
    error::ApiError,
    routes::{ensure_allowed_origin, owned_session, require_principal, require_role, validate_id},
};

pub async fn start_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<CoachAgentResponse>, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    validate_id(&id)?;
    let principal = require_role(&state, &headers, "learner")?;
    let session = owned_session(&state, &id, &principal)?;
    Ok(Json(
        coach_session::start_owned_agent(&state, &session).await?,
    ))
}

pub async fn stop_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    validate_id(&id)?;
    let principal = require_role(&state, &headers, "learner")?;
    owned_session(&state, &id, &principal)?;
    coach_session::stop_owned_agent(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct CoachFeedbackRequest {
    agent_id: Option<String>,
}

pub async fn create_coach_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<CoachFeedbackRequest>,
) -> Result<Json<CoachFeedbackResponse>, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    validate_id(&id)?;
    let principal = require_role(&state, &headers, "learner")?;
    let session = owned_session(&state, &id, &principal)?;
    Ok(Json(
        coach_session::fetch_owned_feedback(&state, &session, request.agent_id.as_deref()).await?,
    ))
}

pub async fn get_session_result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    validate_id(&id)?;
    let principal = require_principal(&state, &headers)?;
    let session = state
        .store
        .coaching_session(&id)?
        .ok_or(ApiError::NotFound)?;
    if principal.role != "annotator" && session.learner_id != principal.user_id {
        return Err(ApiError::Forbidden);
    }
    Ok(Json(coach_session::session_result(&state, session)?))
}
