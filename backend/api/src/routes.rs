use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

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
    audio::{cleanup_session_files, preprocess_session, write_processed_wav},
    auth::{
        Principal, expired_session_cookie, hash_session_token, issue_session_token, session_cookie,
        session_token, verify_password,
    },
    comparison::compare_session,
    error::ApiError,
    inference_bundle::{ImportedInferenceResult, MODEL_ID, MODEL_REVISION},
    store::{AnnotationItem, AudioChunk, CoachingSession, ImportStart, TranscriptEvent},
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
        .route("/api/inference/jobs", get(list_inference_jobs))
        .route(
            "/api/inference/jobs/{id}/modal-run",
            post(run_inference_job_on_modal),
        )
        .route("/api/inference/jobs/{id}/export", get(export_inference_job))
        .route(
            "/api/inference/jobs/{id}/poc-ticket",
            post(issue_inference_poc_ticket),
        )
        .route(
            "/api/inference/jobs/{id}/poc-export",
            get(export_inference_job_with_poc_ticket),
        )
        .route(
            "/api/inference/jobs/{id}/poc-import",
            post(import_inference_result_with_poc_ticket),
        )
        .route(
            "/api/inference/jobs/{id}/import",
            post(import_inference_result),
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
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ready",
        model_gateway: "configured",
    })
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
    let user = state.store.find_local_user(&request.email)?;
    let Some(user) = user.filter(|user| verify_password(&request.password, &user.password_hash))
    else {
        state.login_limiter.record_failure(&request.email);
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

async fn upload_audio_chunk(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    validate_id(&id)?;
    let principal = require_role(&state, &headers, "learner")?;
    let session = owned_capturing_session(&state, &id, &principal)?;
    let sequence = required_integer_header(&headers, "x-audio-sequence")?;
    let sample_rate = required_integer_header(&headers, "x-sample-rate")?;
    let channels = required_integer_header(&headers, "x-channels")?;
    if sequence < 0 || !(8_000..=96_000).contains(&sample_rate) || !(1..=2).contains(&channels) {
        return Err(ApiError::Invalid("invalid audio chunk metadata".to_owned()));
    }
    if body.is_empty() || body.len() > MAX_CHUNK_BYTES || !body.len().is_multiple_of(2) {
        return Err(ApiError::Invalid("invalid PCM16 chunk body".to_owned()));
    }
    let chunk_dir = state
        .config
        .private_audio_root
        .join(&session.id)
        .join("chunks");
    fs::create_dir_all(&chunk_dir)?;
    let path = chunk_dir.join(format!("{sequence:08}.pcm"));
    fs::write(&path, body)?;
    let chunk = AudioChunk {
        sequence,
        sample_rate: sample_rate as u32,
        channels: channels as u16,
        path: path.to_string_lossy().into_owned(),
    };
    if let Err(error) = state.store.add_audio_chunk(&id, &chunk) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(StatusCode::NO_CONTENT)
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
    let session = owned_capturing_session(&state, &id, &principal)?;
    if !state.store.session_has_adult_consent(&id)? {
        return Err(ApiError::Forbidden);
    }
    state.store.set_coaching_status(&id, "preprocessing")?;
    let chunks = state.store.audio_chunks(&id)?;
    let processed_path = state
        .config
        .private_audio_root
        .join(&id)
        .join("processed.wav");
    let queued = (|| {
        let audio = preprocess_session(&chunks)?;
        write_processed_wav(&processed_path, &audio)?;
        let (audio_sha256, audio_bytes) =
            state
                .inference_bundles
                .describe_audio(&processed_path, audio.sample_rate, 1)?;
        let duration_ms = audio.samples.len() as i64 * 1_000 / audio.sample_rate as i64;
        state.store.create_inference_job(
            &session.id,
            &processed_path.to_string_lossy(),
            &audio_sha256,
            audio_bytes,
            audio.sample_rate,
            1,
            duration_ms,
            MODEL_ID,
            MODEL_REVISION,
        )
    })();
    let job = match queued {
        Ok(job) => job,
        Err(error) => {
            cleanup_session_files(&chunks, &processed_path);
            state.store.set_coaching_status(&id, "failed")?;
            return Err(error);
        }
    };
    cleanup_chunk_files(&chunks);
    tracing::info!(event = "inference.job.created", session_id = %id, job_id = %job.id);
    Ok(Json(FinalizeResponse {
        session_id: id,
        status: "pending_manual_inference".to_owned(),
        review_items: 0,
        inference_job_id: Some(job.id),
    }))
}

fn cleanup_chunk_files(chunks: &[AudioChunk]) {
    for chunk in chunks {
        if let Err(error) = fs::remove_file(&chunk.path) {
            tracing::warn!(event = "audio.chunk_cleanup_failed", error = %error);
        }
    }
}

#[derive(Serialize)]
struct InferenceJobSummary {
    id: String,
    session_id: String,
    status: String,
    model_id: String,
    model_revision: String,
    created_at: i64,
    expires_at: i64,
}

#[derive(Serialize)]
struct PocTicketResponse {
    job_id: String,
    token: String,
    expires_at: i64,
}

async fn issue_inference_poc_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<PocTicketResponse>, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    require_role(&state, &headers, "annotator")?;
    validate_id(&id)?;
    let job = state.store.inference_job(&id)?.ok_or(ApiError::NotFound)?;
    if !matches!(job.status.as_str(), "pending_manual_inference" | "exported") {
        return Err(ApiError::Conflict(
            "inference job is not available for Colab POC processing".to_owned(),
        ));
    }
    let issued = state
        .poc_access
        .issue(&id, job.expires_at, unix_seconds())?;
    tracing::info!(event = "inference.poc_ticket.issued", job_id = %id, expires_at = issued.expires_at);
    Ok(Json(PocTicketResponse {
        job_id: id,
        token: issued.token,
        expires_at: issued.expires_at,
    }))
}

async fn list_inference_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<InferenceJobSummary>>, ApiError> {
    require_role(&state, &headers, "annotator")?;
    let jobs = state
        .store
        .pending_inference_jobs()?
        .into_iter()
        .map(|job| InferenceJobSummary {
            id: job.id,
            session_id: job.session_id,
            status: job.status,
            model_id: job.model_id,
            model_revision: job.model_revision,
            created_at: job.created_at,
            expires_at: job.expires_at,
        })
        .collect();
    Ok(Json(jobs))
}

async fn export_inference_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    require_role(&state, &headers, "annotator")?;
    export_inference_bundle(&state, id)
}

async fn export_inference_job_with_poc_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let token = bearer_token(&headers)?;
    state.poc_access.begin_export(&id, token, unix_seconds())?;
    match export_inference_bundle(&state, id.clone()) {
        Ok(response) => {
            state.poc_access.finish_export(&id, token)?;
            Ok(response)
        }
        Err(error) => {
            state.poc_access.abort_export(&id, token);
            Err(error)
        }
    }
}

fn export_inference_bundle(state: &AppState, id: String) -> Result<Response, ApiError> {
    validate_id(&id)?;
    let job = state.store.inference_job(&id)?.ok_or(ApiError::NotFound)?;
    if job.expires_at <= unix_seconds() || job.status == "analysis_unavailable" {
        return Err(ApiError::Invalid("inference job has expired".to_owned()));
    }
    let bundle = state.inference_bundles.export_bundle(&job)?;
    state.store.mark_inference_job_exported(&id)?;
    tracing::info!(event = "inference.bundle.exported", job_id = %id, bytes = bundle.len());
    let disposition =
        HeaderValue::from_str(&format!("attachment; filename=\"gabaybigkas-{id}.zip\""))
            .map_err(|_| ApiError::Internal)?;
    let mut response = bundle.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, disposition);
    Ok(response)
}

#[derive(Serialize)]
struct ImportResponse {
    job_id: String,
    status: &'static str,
    review_items: usize,
    idempotent: bool,
}

async fn run_inference_job_on_modal(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<ImportResponse>, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    validate_id(&id)?;
    let principal = require_principal(&state, &headers)?;
    if principal.role != "annotator" {
        if principal.role != "learner" {
            return Err(ApiError::Forbidden);
        }
        let job = state.store.inference_job(&id)?.ok_or(ApiError::NotFound)?;
        let session = state
            .store
            .coaching_session(&job.session_id)?
            .ok_or(ApiError::NotFound)?;
        if session.learner_id != principal.user_id {
            return Err(ApiError::Forbidden);
        }
    }
    let client = state
        .modal_inference
        .clone()
        .ok_or(ApiError::ModelUnavailable)?;
    let job = state.store.claim_inference_job_for_modal(&id)?;
    let outcome = run_modal_inference_workflow(&state, &client, &job).await;
    if let Err(error) = state.store.release_modal_inference_claim(&id) {
        tracing::error!(event = "modal.inference.claim_release_failed", job_id = %id, error = %error);
    }
    outcome
}

async fn run_modal_inference_workflow(
    state: &AppState,
    client: &crate::modal_inference::ModalInferenceClient,
    job: &crate::store::InferenceJob,
) -> Result<Json<ImportResponse>, ApiError> {
    let bundle = state.inference_bundles.export_bundle(job)?;
    let result = client.infer(&job.id, bundle).await?;
    import_inference_result_for_job(state, job.id.clone(), result)
}

async fn import_inference_result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(result): Json<ImportedInferenceResult>,
) -> Result<Json<ImportResponse>, ApiError> {
    ensure_allowed_origin(&headers, state.config.allowed_origin.as_deref())?;
    require_role(&state, &headers, "annotator")?;
    import_inference_result_for_job(&state, id, result)
}

async fn import_inference_result_with_poc_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(result): Json<ImportedInferenceResult>,
) -> Result<Json<ImportResponse>, ApiError> {
    let token = bearer_token(&headers)?;
    state.poc_access.begin_import(&id, token, unix_seconds())?;
    match import_inference_result_for_job(&state, id.clone(), result) {
        Ok(response) => {
            state.poc_access.finish_import(&id, token)?;
            Ok(response)
        }
        Err(error) => {
            state.poc_access.abort_import(&id, token);
            Err(error)
        }
    }
}

fn import_inference_result_for_job(
    state: &AppState,
    id: String,
    result: ImportedInferenceResult,
) -> Result<Json<ImportResponse>, ApiError> {
    validate_id(&id)?;
    let job = state.store.inference_job(&id)?.ok_or(ApiError::NotFound)?;
    let result_sha256 = state
        .inference_bundles
        .validate_import(&job, &result, unix_seconds())?;
    let started = state.store.begin_inference_import(&id, &result_sha256)?;
    if matches!(started, ImportStart::Idempotent) {
        return Ok(Json(ImportResponse {
            job_id: id,
            status: "review_ready",
            review_items: 0,
            idempotent: true,
        }));
    }
    let ImportStart::Started(job) = started else {
        unreachable!()
    };
    let imported = import_result_workflow(state, &job, &result_sha256, result);
    match imported {
        Ok(review_items) => {
            state.inference_bundles.cleanup_audio(&job.audio_path);
            tracing::info!(event = "inference.result.imported", job_id = %id, review_items);
            Ok(Json(ImportResponse {
                job_id: id,
                status: "review_ready",
                review_items,
                idempotent: false,
            }))
        }
        Err(error) => {
            let _ = state.store.abort_inference_import(&id, &result_sha256);
            tracing::warn!(event = "inference.result.rejected", job_id = %id, reason = %error);
            Err(error)
        }
    }
}

fn import_result_workflow(
    state: &AppState,
    job: &crate::store::InferenceJob,
    result_sha256: &str,
    result: ImportedInferenceResult,
) -> Result<usize, ApiError> {
    let session = state
        .store
        .coaching_session(&job.session_id)?
        .ok_or(ApiError::NotFound)?;
    let audio = state
        .inference_bundles
        .load_processed_audio(&job.audio_path)?;
    let buzz = crate::inference_bundle::InferenceBundleService::transcription(result);
    let agora = state.store.transcript_events(&session.id)?;
    let candidates = compare_session(&session.expected_phrases, &agora, &buzz);
    let mut items = Vec::with_capacity(candidates.len());
    for (index, candidate) in candidates.iter().enumerate() {
        let item_id = format!("{}-{index}", job.id);
        let clip_key = format!("{}/clips/{}.wav", session.id, item_id);
        state.inference_bundles.write_review_clip(
            &clip_key,
            &audio,
            candidate.sentence_start_ms,
            candidate.sentence_end_ms,
        )?;
        items.push(AnnotationItem {
            id: item_id,
            session_id: session.id.clone(),
            expected_text: candidate.expected_text.clone(),
            agora_text: candidate.agora_text.clone(),
            buzz_text: candidate.buzz_text.clone(),
            sentence_start_ms: candidate.sentence_start_ms,
            sentence_end_ms: candidate.sentence_end_ms,
            focus_start_ms: candidate.focus_start_ms,
            focus_end_ms: candidate.focus_end_ms,
            clip_key,
            status: "pending".to_owned(),
        });
    }
    state
        .store
        .complete_inference_import(&job.id, result_sha256, &items)?;
    Ok(items.len())
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
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
    validate_id(&id)?;
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
    require_role(&state, &headers, "annotator")?;
    validate_id(&id)?;
    let item = state
        .store
        .annotation_item(&id)?
        .ok_or(ApiError::NotFound)?;
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
    validate_id(&id)?;
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

fn require_principal(state: &AppState, headers: &HeaderMap) -> Result<Principal, ApiError> {
    let token = session_token(headers).ok_or(ApiError::Unauthorized)?;
    state
        .store
        .resolve_principal(&hash_session_token(&token))?
        .ok_or(ApiError::Unauthorized)
}

fn require_role(state: &AppState, headers: &HeaderMap, role: &str) -> Result<Principal, ApiError> {
    let principal = require_principal(state, headers)?;
    if principal.role != role {
        return Err(ApiError::Forbidden);
    }
    Ok(principal)
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .ok_or(ApiError::Unauthorized)
}

fn owned_capturing_session(
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
    if session.status != "capturing" {
        return Err(ApiError::Conflict(
            "session is not accepting input".to_owned(),
        ));
    }
    Ok(session)
}

fn validate_id(id: &str) -> Result<(), ApiError> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| ApiError::Invalid("invalid resource id".to_owned()))
}

fn required_integer_header(headers: &HeaderMap, name: &str) -> Result<i64, ApiError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| ApiError::Invalid(format!("missing or invalid {name}")))
}

fn ensure_allowed_origin(
    headers: &HeaderMap,
    allowed_origin: Option<&str>,
) -> Result<(), ApiError> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(());
    };
    let origin = origin.to_str().map_err(|_| ApiError::Forbidden)?;
    if origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("http://localhost:")
        || allowed_origin.is_some_and(|allowed| origin == allowed)
    {
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
