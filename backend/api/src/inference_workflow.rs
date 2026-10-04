use crate::routes::validate_id;
use crate::{
    AppState,
    audio::{cleanup_session_files, preprocess_session, write_processed_wav},
    comparison::compare_session,
    error::ApiError,
    inference_bundle::{ImportedInferenceResult, MODEL_ID, MODEL_REVISION},
    store::{AnnotationItem, CoachingSession, ImportStart},
};
use axum::Json;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::OwnedSemaphorePermit;

pub async fn finish_session_in_background(
    state: AppState,
    session: CoachingSession,
    _permit: OwnedSemaphorePermit,
) {
    let started = std::time::Instant::now();
    let outcome = prepare_and_run_inference(&state, &session).await;
    if let Err(error) = outcome {
        if let Some(job_id) = state
            .store
            .coaching_session(&session.id)
            .ok()
            .flatten()
            .and_then(|s| s.inference_job_id)
        {
            if let Err(status_error) = state.store.mark_inference_analysis_unavailable(&job_id) {
                tracing::error!(event = "inference.failure_status.failed", session_id = %session.id, error = %status_error);
            }
        } else if let Err(status_error) = state.store.set_coaching_status(&session.id, "failed") {
            tracing::error!(event = "inference.failure_status.failed", session_id = %session.id, error = %status_error);
        }
        tracing::warn!(event = "inference.background.failed", session_id = %session.id, error = %error);
    } else {
        tracing::info!(event = "inference.background.completed", session_id = %session.id, duration_ms = started.elapsed().as_millis() as u64);
    }
}

async fn prepare_and_run_inference(
    state: &AppState,
    session: &CoachingSession,
) -> Result<(), ApiError> {
    let prep_state = state.clone();
    let prep_session = session.clone();
    let job = tokio::task::spawn_blocking(move || {
        let chunks = prep_state.store.audio_chunks(&prep_session.id)?;
        let path = prep_state
            .config
            .private_audio_root
            .join(&prep_session.id)
            .join("processed.wav");
        let prepared = (|| {
            let audio = preprocess_session(&chunks)?;
            write_processed_wav(&path, &audio)?;
            let (hash, bytes) =
                prep_state
                    .inference_bundles
                    .describe_audio(&path, audio.sample_rate, 1)?;
            prep_state.store.create_inference_job(
                &prep_session.id,
                &path.to_string_lossy(),
                &hash,
                bytes,
                audio.sample_rate,
                1,
                audio.samples.len() as i64 * 1000 / audio.sample_rate as i64,
                MODEL_ID,
                MODEL_REVISION,
            )
        })();
        if prepared.is_err() {
            cleanup_session_files(&chunks, &path);
        }
        crate::audio::cleanup_capture_directory(
            &prep_state.config.private_audio_root,
            &prep_session.id,
        );
        prepared
    })
    .await
    .map_err(|_| ApiError::Internal)??;
    let Some(client) = state.modal_inference.as_ref() else {
        state.store.mark_inference_analysis_unavailable(&job.id)?;
        state.inference_bundles.cleanup_audio(&job.audio_path);
        tracing::warn!(event = "inference.provider.disabled", session_id = %session.id);
        return Ok(());
    };
    let claimed = match state.store.claim_inference_job_for_modal(&job.id) {
        Ok(claimed) => claimed,
        Err(error) => {
            state.inference_bundles.cleanup_audio(&job.audio_path);
            return Err(error);
        }
    };
    let outcome = run_modal_inference_workflow(state, client, &claimed).await;
    if let Err(error) = state.store.release_modal_inference_claim(&job.id) {
        tracing::error!(event = "inference.claim_release.failed", job_id = %job.id, error = %error);
    }
    if outcome.is_err() {
        state.inference_bundles.cleanup_audio(&job.audio_path);
    }
    outcome.map(|_| ())
}

#[derive(Serialize)]
pub struct ImportResponse {
    job_id: String,
    status: &'static str,
    review_items: usize,
    idempotent: bool,
}

async fn run_modal_inference_workflow(
    state: &AppState,
    client: &crate::modal_inference::ModalInferenceClient,
    job: &crate::store::InferenceJob,
) -> Result<Json<ImportResponse>, ApiError> {
    let bundle_service = state.inference_bundles.clone();
    let bundle_job = job.clone();
    let bundle = tokio::task::spawn_blocking(move || bundle_service.export_bundle(&bundle_job))
        .await
        .map_err(|_| ApiError::Internal)??;
    let result = client.infer(&job.id, bundle).await?;
    let import_state = state.clone();
    let import_id = job.id.clone();
    tokio::task::spawn_blocking(move || {
        import_inference_result_for_job(&import_state, import_id, result)
    })
    .await
    .map_err(|_| ApiError::Internal)?
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
            if let Err(recovery_error) = state.store.abort_inference_import(&id, &result_sha256) {
                tracing::error!(event = "inference.import_recovery.failed", job_id = %id, error = %recovery_error);
            }
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
    let result_json = serde_json::to_string(&result).map_err(|_| ApiError::Internal)?;
    let buzz = crate::inference_bundle::InferenceBundleService::transcription(result);
    let agora = state.store.transcript_events(&session.id)?;
    let mut candidates = compare_session(&session.expected_phrases, &agora, &buzz);
    if candidates.is_empty() {
        candidates.push(crate::comparison::ComparisonCandidate {
            expected_text: session.expected_phrases.join(" "),
            agora_text: agora
                .iter()
                .map(|event| event.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            buzz_text: buzz.text.clone(),
            sentence_start_ms: 0,
            sentence_end_ms: job.duration_ms,
            focus_start_ms: 0,
            focus_end_ms: job.duration_ms,
        });
    }
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
        .complete_inference_import(&job.id, result_sha256, &items, &result_json)?;
    Ok(items.len())
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
