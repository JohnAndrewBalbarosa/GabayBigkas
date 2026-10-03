mod protocol;
mod worker;

use std::{env, sync::Arc};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    routing::{get, post},
};
use protocol::{ErrorResponse, HealthResponse, TranscriptionRequest, WorkerResponse};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::Mutex};
use uuid::Uuid;
use worker::WorkerBridge;

const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;

struct AppState {
    bearer_token: Option<String>,
    worker: Mutex<WorkerBridge>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let python = env::var("BUZZASR_PYTHON").unwrap_or_else(|_| "python3".to_owned());
    let worker_script = env::var("BUZZASR_WORKER_SCRIPT")
        .unwrap_or_else(|_| "backend/model/inference/buzzasr_gpu_worker.py".to_owned());
    let bind_address = env::var("BUZZASR_BIND").unwrap_or_else(|_| "127.0.0.1:4318".to_owned());
    let worker = WorkerBridge::spawn(&python, &worker_script)
        .await
        .map_err(std::io::Error::other)?;
    let (model, model_revision, device, gpu_name) = worker.startup_summary();
    eprintln!(
        "{{\"event\":\"buzzasr.gateway.ready\",\"model\":{model:?},\"model_revision\":{model_revision:?},\"device\":{device:?},\"gpu_name\":{gpu_name:?},\"bind\":{bind_address:?}}}"
    );
    let state = Arc::new(AppState {
        bearer_token: env::var("MODEL_GATEWAY_TOKEN").ok(),
        worker: Mutex::new(worker),
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/transcribe", post(transcribe))
        .layer(DefaultBodyLimit::max(MAX_JSON_BYTES))
        .with_state(state);
    let listener = TcpListener::bind(&bind_address).await?;

    axum::serve(listener, app).await?;
    Ok(())
}

// Mental model: a successful health response proves the child process, model,
// and a fresh CUDA operation are all working at request time.
async fn health(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<HealthResponse>, (StatusCode, Json<ErrorResponse<'static>>)> {
    authorize(&state, &headers)?;
    let request_id = Uuid::new_v4().to_string();
    let response = state
        .worker
        .lock()
        .await
        .health(&request_id)
        .await
        .map_err(internal_worker_error)?;
    if !response.ok {
        return Err(internal_worker_error(
            response
                .error
                .unwrap_or_else(|| "CUDA health probe failed".to_owned()),
        ));
    }
    Ok(Json(health_response_from_worker(response)?))
}

fn health_response_from_worker(
    response: WorkerResponse,
) -> Result<HealthResponse, (StatusCode, Json<ErrorResponse<'static>>)> {
    let model_loaded = required(response.model_loaded, "model_loaded")?;
    let accelerator = required(response.accelerator, "accelerator")?;
    if !model_loaded || accelerator != "cuda" {
        return Err(internal_worker_error(
            "worker did not prove a loaded CUDA model".to_owned(),
        ));
    }
    Ok(HealthResponse {
        status: "ready",
        worker: "alive",
        model_loaded,
        accelerator,
        device: required(response.device, "device")?,
        gpu_name: required(response.gpu_name, "gpu_name")?,
        gpu_memory_free_mb: required(response.gpu_memory_free_mb, "gpu_memory_free_mb")?,
        gpu_memory_total_mb: required(response.gpu_memory_total_mb, "gpu_memory_total_mb")?,
        model: required(response.model, "model")?,
        model_revision: required(response.model_revision, "model_revision")?,
        probe_duration_ms: response.duration_ms,
    })
}

async fn transcribe(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<TranscriptionRequest>,
) -> Result<Json<WorkerResponse>, (StatusCode, Json<ErrorResponse<'static>>)> {
    authorize(&state, &headers)?;
    if request.audio_wav_base64.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid_audio",
                message: "audio_wav_base64 must not be empty".to_owned(),
            }),
        ));
    }

    let request_id = Uuid::new_v4().to_string();
    let response = state
        .worker
        .lock()
        .await
        .transcribe(&request_id, &request.audio_wav_base64)
        .await
        .map_err(internal_worker_error)?;
    if !response.ok {
        return Err(failed_worker_response(response));
    }
    Ok(Json(response))
}

fn authorize(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ErrorResponse<'static>>)> {
    let Some(expected) = state.bearer_token.as_deref() else {
        return Ok(());
    };
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if presented.as_bytes().ct_eq(expected.as_bytes()).into() {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "unauthorized",
                message: "valid bearer token required".to_owned(),
            }),
        ))
    }
}

#[inline]
fn required<T>(
    value: Option<T>,
    field: &'static str,
) -> Result<T, (StatusCode, Json<ErrorResponse<'static>>)> {
    value.ok_or_else(|| internal_worker_error(format!("worker response is missing {field}")))
}

fn failed_worker_response(response: WorkerResponse) -> (StatusCode, Json<ErrorResponse<'static>>) {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(ErrorResponse {
            error: "worker_rejected_request",
            message: response
                .error
                .unwrap_or_else(|| "worker rejected the request".to_owned()),
        }),
    )
}

fn internal_worker_error(message: String) -> (StatusCode, Json<ErrorResponse<'static>>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse {
            error: "worker_unavailable",
            message,
        }),
    )
}
