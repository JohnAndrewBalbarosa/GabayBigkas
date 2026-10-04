use std::fs;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tower_http::{
    cors::CorsLayer, limit::RequestBodyLimitLayer, services::ServeDir, trace::TraceLayer,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{
        Principal, expired_session_cookie, hash_session_token, issue_session_token, session_cookie,
        session_token, verify_password,
    },
    coach_routes::create_coach_feedback,
    error::ApiError,
    store::{AnnotationItem, CoachingSession, FinalizationEnqueue, TranscriptEvent},
};

const MAX_CHUNK_BYTES: usize = 2 * 1024 * 1024;

pub fn router(state: AppState) -> Router {
    let allowed_origin = state.config.allowed_origin.clone();
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/local/login", post(login))
        .route("/api/auth/session", get(current_session))
        .route("/api/auth/logout", post(logout))
        .route("/api/coaching/sessions", post(create_coaching_session))
        .route("/api/coaching/sessions/{id}", get(get_coaching_session))
        .route(
            "/api/coaching/sessions/{id}/audio/chunks",
            post(upload_audio_chunk),
        )
        .route(
            "/api/coaching/sessions/{id}/agora-transcript-events",
            post(add_transcript_event),
        )
        .route(
            "/api/coaching/sessions/{id}/finalize",
            post(finalize_coaching_session),
        )
        .route(
            "/api/coaching/sessions/{id}/coach-feedback",
            post(create_coach_feedback),
        )
        .route(
            "/api/coaching/sessions/{id}/agent",
            post(crate::coach_routes::start_agent),
        )
        .route(
            "/api/coaching/sessions/{id}/agent/stop",
            post(crate::coach_routes::stop_agent),
        )
        .route(
            "/api/coaching/sessions/{id}/result",
            get(crate::coach_routes::get_session_result),
        )
        .route("/api/annotation/queue", get(annotation_queue))
        .route("/api/annotation/items/{id}", get(annotation_item))
        .route("/api/annotation/items/{id}/audio", get(annotation_audio))
        .route(
            "/api/annotation/items/{id}/decision",
            post(decide_annotation),
        )
        .fallback_service(
            ServeDir::new(".artifacts/build/coach").append_index_html_on_directories(true),
        )
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(MAX_CHUNK_BYTES))
        .layer(TraceLayer::new_for_http())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            bounded_admission,
        ))
        .with_state(state);
    match allowed_origin {
        Some(origin) => router.layer(production_cors(&origin)),
        None => router,
    }
}

fn production_cors(origin: &str) -> CorsLayer {
    let origin =
        HeaderValue::from_str(origin).expect("COACH_ALLOWED_ORIGIN must be a valid origin");
    CorsLayer::new()
        .allow_origin(origin)
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-audio-sequence"),
            HeaderName::from_static("x-sample-rate"),
            HeaderName::from_static("x-channels"),
        ])
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    model_gateway: &'static str,
    coach_feedback: bool,
    agora_agent: bool,
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ready",
        model_gateway: if state.modal_inference.is_some() {
            "configured"
        } else {
            "disabled"
        },
        coach_feedback: state.coach_feedback.is_some(),
        agora_agent: state.agora_agent.is_some(),
    })
}

async fn bounded_admission(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Ok(_permit) = state
        .request_admission
        .acquire(request.method(), request.uri().path())
        .await
    else {
        return ApiError::Busy.into_response();
    };
    next.run(request).await
}

#[derive(Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
struct SessionResponse {
    email: String,
    role: String,
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    state.login_limiter.allow(&request.email)?;
    if request.email.len() > 254 || request.password.len() > 1024 {
        return Err(ApiError::Unauthorized);
    }
    let user = state.store.find_local_user(&request.email)?;
    let verified_user = tokio::task::spawn_blocking(move || {
        user.filter(|user| verify_password(&request.password, &user.password_hash))
    })
    .await
    .map_err(|_| ApiError::Internal)?;
    let Some(user) = verified_user else {
        tracing::warn!(event = "authentication.login.rejected");
        return Err(ApiError::Unauthorized);
    };
    state.login_limiter.clear(&request.email);
    let token = issue_session_token();
    state
        .store
        .create_auth_session(&user.id, &hash_session_token(&token))?;
    tracing::info!(event = "authentication.login.succeeded", role = %user.role);
    let mut response = Json(SessionResponse {
        email: user.email,
        role: user.role,
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&session_cookie(&token, state.config.secure_cookie))
            .map_err(|_| ApiError::Internal)?,
    );
    Ok(response)
}

async fn current_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SessionResponse>, ApiError> {
    let principal = require_principal(&state, &headers)?;
    Ok(Json(SessionResponse {
        email: principal.email,
        role: principal.role,
    }))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    if let Some(token) = session_token(&headers) {
        state
            .store
            .revoke_auth_session(&hash_session_token(&token))?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&expired_session_cookie(state.config.secure_cookie))
            .map_err(|_| ApiError::Internal)?,
    );
    Ok(response)
}

#[derive(Deserialize)]
struct CreateSessionRequest {
    exercise_id: String,
    expected_phrases: Vec<String>,
    recording_consent: bool,
    adult_consent: bool,
}

async fn create_coaching_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<CoachingSession>), ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    let principal = require_role(&state, &headers, "learner")?;
    if !request.recording_consent || !request.adult_consent {
        return Err(ApiError::Invalid(
            "recording and consenting-adult confirmation are required".to_owned(),
        ));
    }
    if request.exercise_id.trim().is_empty()
        || request.expected_phrases.is_empty()
        || request.expected_phrases.len() > 50
        || request
            .expected_phrases
            .iter()
            .any(|phrase| phrase.len() > 500)
    {
        return Err(ApiError::Invalid("invalid guided exercise".to_owned()));
    }
    let session = state.store.create_coaching_session(
        &principal.user_id,
        &request.exercise_id,
        &request.expected_phrases,
        request.adult_consent,
    )?;
    tracing::info!(event = "coaching.session.created", session_id = %session.id);
    Ok((StatusCode::CREATED, Json(session)))
}

async fn get_coaching_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<CoachingSession>, ApiError> {
    validate_id(&id)?;
    let principal = require_principal(&state, &headers)?;
    let session = state
        .store
        .coaching_session(&id)?
        .ok_or(ApiError::NotFound)?;
    if principal.role != "annotator" && session.learner_id != principal.user_id {
        return Err(ApiError::Forbidden);
    }
    Ok(Json(session))
}

#[derive(Serialize)]
struct ChunkAccepted {
    accepted: bool,
    idempotent: bool,
}

async fn upload_audio_chunk(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<ChunkAccepted>, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    validate_id(&id)?;
    let principal = require_role(&state, &headers, "learner")?;
    let session = owned_capturing_session(&state, &id, &principal)?;
    let sequence = required_integer_header(&headers, "x-audio-sequence")?;
    let sample_rate = required_integer_header(&headers, "x-sample-rate")?;
    let channels = required_integer_header(&headers, "x-channels")?;
    if !(0..2048).contains(&sequence)
        || !(8_000..=96_000).contains(&sample_rate)
        || !(1..=2).contains(&channels)
    {
        return Err(ApiError::Invalid("invalid audio chunk metadata".to_owned()));
    }
    if body.is_empty()
        || body.len() > MAX_CHUNK_BYTES
        || !body.len().is_multiple_of(2 * channels as usize)
    {
        return Err(ApiError::Invalid("invalid PCM16 chunk body".to_owned()));
    }
    let chunk_dir = state
        .config
        .private_audio_root
        .join(&session.id)
        .join("chunks");
    let idempotent = tokio::task::spawn_blocking(move || {
        let chunk = crate::audio::persist_pcm_chunk(
            &chunk_dir,
            sequence,
            sample_rate as u32,
            channels as u16,
            &body,
        )?;
        state.store.add_audio_chunk_bounded(&id, &chunk, body.len())
    })
    .await
    .map_err(|_| ApiError::Internal)??;
    Ok(Json(ChunkAccepted {
        accepted: true,
        idempotent,
    }))
}

async fn add_transcript_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(event): Json<TranscriptEvent>,
) -> Result<StatusCode, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    validate_id(&id)?;
    let principal = require_role(&state, &headers, "learner")?;
    owned_capturing_session(&state, &id, &principal)?;
    state.store.add_transcript_event(&id, &event)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct FinalizeResponse {
    session_id: String,
    status: String,
    acknowledged: bool,
    idempotent: bool,
    review_items: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    inference_job_id: Option<String>,
}

async fn finalize_coaching_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<FinalizeResponse>, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    validate_id(&id)?;
    let principal = require_role(&state, &headers, "learner")?;
    let session = owned_session(&state, &id, &principal)?;
    if session.status != "capturing" {
        return Ok(Json(FinalizeResponse {
            session_id: id,
            status: session.status,
            acknowledged: true,
            idempotent: true,
            review_items: 0,
            inference_job_id: session.inference_job_id,
        }));
    }
    if !state.store.session_has_adult_consent(&id)? {
        return Err(ApiError::Forbidden);
    }
    if state.store.enqueue_session_finalization(&id)? == FinalizationEnqueue::Existing {
        let existing = state
            .store
            .coaching_session(&id)?
            .ok_or(ApiError::NotFound)?;
        return Ok(Json(FinalizeResponse {
            session_id: id,
            status: existing.status,
            acknowledged: true,
            idempotent: true,
            review_items: 0,
            inference_job_id: existing.inference_job_id,
        }));
    }
    state.inference_ready.notify_one();
    Ok(Json(FinalizeResponse {
        session_id: id,
        status: "queued".to_owned(),
        acknowledged: true,
        idempotent: false,
        review_items: 0,
        inference_job_id: None,
    }))
}

async fn annotation_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AnnotationItem>>, ApiError> {
    require_role(&state, &headers, "annotator")?;
    Ok(Json(state.store.annotation_items()?))
}

async fn annotation_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<AnnotationItem>, ApiError> {
    require_role(&state, &headers, "annotator")?;
    validate_annotation_id(&id)?;
    Ok(Json(
        state
            .store
            .annotation_item(&id)?
            .ok_or(ApiError::NotFound)?,
    ))
}

async fn annotation_audio(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let principal = require_principal(&state, &headers)?;
    validate_annotation_id(&id)?;
    let item = state
        .store
        .annotation_item(&id)?
        .ok_or(ApiError::NotFound)?;
    if principal.role != "annotator" {
        owned_session(&state, &item.session_id, &principal)?;
    }
    let path = state.config.private_audio_root.join(item.clip_key);
    let body = fs::read(path).map_err(|error| {
        tracing::warn!(event = "annotation.audio.read_failed", annotation_id = %id, error = %error);
        ApiError::NotFound
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, "audio/wav"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response())
}

#[derive(Deserialize)]
struct DecisionRequest {
    decision: String,
    corrected_text: Option<String>,
    notes: Option<String>,
}

async fn decide_annotation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<DecisionRequest>,
) -> Result<StatusCode, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    let principal = require_role(&state, &headers, "annotator")?;
    validate_annotation_id(&id)?;
    let allowed = [
        "confirmed_transcript",
        "corrected_transcript",
        "insufficient_evidence",
        "out_of_scope_language",
    ];
    if !allowed.contains(&request.decision.as_str())
        || request
            .notes
            .as_ref()
            .is_some_and(|notes| notes.len() > 2_000)
        || (request.decision == "corrected_transcript"
            && request
                .corrected_text
                .as_ref()
                .is_none_or(|text| text.trim().is_empty() || text.len() > 4_000))
    {
        return Err(ApiError::Invalid("invalid annotation decision".to_owned()));
    }
    state.store.decide_annotation(
        &id,
        &principal.user_id,
        &request.decision,
        request.corrected_text.as_deref(),
        request.notes.as_deref(),
    )?;
    tracing::info!(event = "annotation.decision.recorded", annotation_id = %id, decision = %request.decision);
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn require_principal(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Principal, ApiError> {
    let token = session_token(headers).ok_or(ApiError::Unauthorized)?;
    state
        .store
        .resolve_principal(&hash_session_token(&token))?
        .ok_or(ApiError::Unauthorized)
}

pub(crate) fn require_role(
    state: &AppState,
    headers: &HeaderMap,
    role: &str,
) -> Result<Principal, ApiError> {
    let principal = require_principal(state, headers)?;
    if principal.role != role {
        return Err(ApiError::Forbidden);
    }
    Ok(principal)
}

fn owned_capturing_session(
    state: &AppState,
    id: &str,
    principal: &Principal,
) -> Result<CoachingSession, ApiError> {
    let session = owned_session(state, id, principal)?;
    if session.status != "capturing" {
        return Err(ApiError::Conflict(
            "session is not accepting input".to_owned(),
        ));
    }
    Ok(session)
}

pub(crate) fn owned_session(
    state: &AppState,
    id: &str,
    principal: &Principal,
) -> Result<CoachingSession, ApiError> {
    let session = state
        .store
        .coaching_session(id)?
        .ok_or(ApiError::NotFound)?;
    if session.learner_id != principal.user_id {
        return Err(ApiError::Forbidden);
    }
    Ok(session)
}

pub(crate) fn validate_id(id: &str) -> Result<(), ApiError> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| ApiError::Invalid("invalid resource id".to_owned()))
}

fn validate_annotation_id(id: &str) -> Result<(), ApiError> {
    let (job_id, index) = id
        .rsplit_once('-')
        .ok_or_else(|| ApiError::Invalid("invalid annotation id".to_owned()))?;
    validate_id(job_id)?;
    if index.is_empty() || index.len() > 6 || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ApiError::Invalid("invalid annotation index".to_owned()));
    }
    Ok(())
}

fn required_integer_header(headers: &HeaderMap, name: &str) -> Result<i64, ApiError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| ApiError::Invalid(format!("missing or invalid {name}")))
}

pub(crate) fn ensure_allowed_origin(
    headers: &HeaderMap,
    allowed_origin: Option<&str>,
) -> Result<(), ApiError> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return if allowed_origin.is_some() {
            Err(ApiError::Forbidden)
        } else {
            Ok(())
        };
    };
    let origin = origin.to_str().map_err(|_| ApiError::Forbidden)?;
    let local_origin = reqwest::Url::parse(origin).is_ok_and(|url| {
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
    });
    if allowed_origin.map_or(local_origin, |allowed| origin == allowed) {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, header};

    use super::ensure_allowed_origin;

    #[test]
    fn deployed_origin_requires_exact_origin_and_annotation_ids_accept_only_generated_suffixes() {
        let mut headers = HeaderMap::new();
        assert!(ensure_allowed_origin(&headers, Some("https://frontend.example.test")).is_err());
        for origin in [
            "http://localhost:4173",
            "https://frontend.example.test.attacker.test",
            "http://localhost.attacker.test:4173",
        ] {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            assert!(
                ensure_allowed_origin(&headers, Some("https://frontend.example.test")).is_err()
            );
        }
        assert!(super::validate_annotation_id("8ed6a5c3-80da-4910-8e31-92c55c8fea44-0").is_ok());
        for id in [
            "../secret-0",
            "8ed6a5c3-80da-4910-8e31-92c55c8fea44-x",
            "8ed6a5c3-80da-4910-8e31-92c55c8fea44-1000000",
        ] {
            assert!(super::validate_annotation_id(id).is_err());
        }
    }

    #[test]
    fn origin_guard_allows_local_and_the_exact_configured_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:4173"),
        );
        assert!(ensure_allowed_origin(&headers, None).is_ok());

        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://johnandrewbalbarosa.github.io"),
        );
        assert!(
            ensure_allowed_origin(&headers, Some("https://johnandrewbalbarosa.github.io")).is_ok()
        );
        assert!(ensure_allowed_origin(&headers, Some("https://attacker.invalid")).is_err());
    }
}
