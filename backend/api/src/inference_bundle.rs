use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::time;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::{
    audio::{ProcessedAudio, read_processed_wav, write_sentence_clip},
    error::ApiError,
    model::{TimedText, Transcription},
    store::{InferenceJob, Store},
};

pub const BUNDLE_SCHEMA_VERSION: u32 = 1;
pub const MODEL_ID: &str = "BuzzASR/filipino";
pub const MODEL_REVISION: &str = "fb8cf0d93e2437f8d639549c67733ca9db10e055";
const MAX_AUDIO_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone)]
pub struct InferenceBundleService {
    private_audio_root: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExportManifest {
    pub schema_version: u32,
    pub job_id: String,
    pub audio_sha256: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub model_id: String,
    pub model_revision: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ImportedInferenceResult {
    pub schema_version: u32,
    pub job_id: String,
    pub audio_sha256: String,
    pub model_id: String,
    pub model_revision: String,
    pub generated_at: i64,
    pub text: String,
    #[serde(default)]
    pub segments: Vec<TimedText>,
    #[serde(default)]
    pub words: Vec<TimedText>,
}

impl InferenceBundleService {
    pub fn new(private_audio_root: PathBuf) -> Self {
        Self { private_audio_root }
    }

    pub fn describe_audio(
        &self,
        path: &Path,
        sample_rate: u32,
        channels: u16,
    ) -> Result<(String, usize), ApiError> {
        let audio = self.read_private_audio(path)?;
        if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES {
            return Err(ApiError::Invalid(
                "processed audio exceeds the bundle limit".to_owned(),
            ));
        }
        if sample_rate != 16_000 || channels != 1 {
            return Err(ApiError::Invalid(
                "processed audio must be mono PCM16 WAV at 16 kHz".to_owned(),
            ));
        }
        Ok((sha256_hex(&audio), audio.len()))
    }

    pub fn export_bundle(&self, job: &InferenceJob) -> Result<Vec<u8>, ApiError> {
        let audio = self.read_private_audio(Path::new(&job.audio_path))?;
        if audio.len() != job.audio_bytes || sha256_hex(&audio) != job.audio_sha256 {
            return Err(ApiError::Conflict(
                "stored audio no longer matches its manifest".to_owned(),
            ));
        }
        let manifest = ExportManifest {
            schema_version: BUNDLE_SCHEMA_VERSION,
            job_id: job.id.clone(),
            audio_sha256: job.audio_sha256.clone(),
            sample_rate: job.sample_rate,
            channels: job.channels,
            model_id: job.model_id.clone(),
            model_revision: job.model_revision.clone(),
            created_at: job.created_at,
            expires_at: job.expires_at,
        };
        create_zip(&manifest, &audio)
    }

    pub fn validate_import(
        &self,
        job: &InferenceJob,
        result: &ImportedInferenceResult,
        now: i64,
    ) -> Result<String, ApiError> {
        if result.schema_version != BUNDLE_SCHEMA_VERSION {
            return Err(ApiError::Invalid(
                "inference result schema mismatch".to_owned(),
            ));
        }
        if result.job_id != job.id || result.audio_sha256 != job.audio_sha256 {
            return Err(ApiError::Invalid(
                "inference result job or audio hash mismatch".to_owned(),
            ));
        }
        if result.model_id != job.model_id || result.model_revision != job.model_revision {
            return Err(ApiError::Invalid(
                "inference result model identity mismatch".to_owned(),
            ));
        }
        if now > job.expires_at
            || result.generated_at < job.created_at
            || result.generated_at > now + 300
        {
            return Err(ApiError::Invalid(
                "inference result is expired or has an invalid timestamp".to_owned(),
            ));
        }
        validate_timestamps(&result.segments, job.duration_ms)?;
        validate_timestamps(&result.words, job.duration_ms)?;
        let canonical = serde_json::to_vec(result).map_err(|_| ApiError::Internal)?;
        Ok(sha256_hex(&canonical))
    }

    pub fn transcription(result: ImportedInferenceResult) -> Transcription {
        Transcription {
            model: result.model_id,
            model_revision: result.model_revision,
            text: result.text,
            duration_ms: 0,
            segments: result.segments,
            words: result.words,
        }
    }

    pub fn cleanup_audio(&self, path: &str) {
        match self.resolve_private_path(Path::new(path)) {
            Ok(path) => match fs::remove_file(&path) {
                Ok(()) => tracing::info!(event = "inference.audio.cleaned"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(event = "inference.audio.cleanup_failed", error = %error)
                }
            },
            Err(error) => {
                tracing::warn!(event = "inference.audio.cleanup_rejected", error = %error)
            }
        }
    }

    pub fn load_processed_audio(&self, path: &str) -> Result<ProcessedAudio, ApiError> {
        let resolved = self.resolve_private_path(Path::new(path))?;
        read_processed_wav(&resolved)
    }

    pub fn write_review_clip(
        &self,
        relative_path: &str,
        audio: &ProcessedAudio,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<(), ApiError> {
        let path = self.private_audio_root.join(relative_path);
        if path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(ApiError::Invalid("invalid review clip path".to_owned()));
        }
        write_sentence_clip(&path, audio, start_ms, end_ms)
    }

    fn read_private_audio(&self, path: &Path) -> Result<Vec<u8>, ApiError> {
        let resolved = self.resolve_private_path(path)?;
        fs::read(resolved).map_err(Into::into)
    }

    fn resolve_private_path(&self, path: &Path) -> Result<PathBuf, ApiError> {
        let root = self.private_audio_root.canonicalize()?;
        let resolved = path.canonicalize()?;
        if !resolved.starts_with(root) {
            return Err(ApiError::Forbidden);
        }
        Ok(resolved)
    }
}

pub async fn run_expired_job_cleanup(store: Arc<Store>, bundles: InferenceBundleService) {
    let mut interval = time::interval(Duration::from_secs(60));
    loop {
        interval.tick().await;
        match store.expire_inference_jobs() {
            Ok(paths) => paths.iter().for_each(|path| bundles.cleanup_audio(path)),
            Err(error) => tracing::error!(event = "inference.expiry.failed", error = %error),
        }
    }
}

fn create_zip(manifest: &ExportManifest, audio: &[u8]) -> Result<Vec<u8>, ApiError> {
    let cursor = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o600);
    zip.start_file("manifest.json", options)
        .map_err(zip_error)?;
    let manifest_json = serde_json::to_vec_pretty(manifest).map_err(|_| ApiError::Internal)?;
    zip.write_all(&manifest_json)?;
    zip.start_file("audio.wav", options).map_err(zip_error)?;
    zip.write_all(audio)?;
    Ok(zip.finish().map_err(zip_error)?.into_inner())
}

fn validate_timestamps(items: &[TimedText], duration_ms: i64) -> Result<(), ApiError> {
    let mut previous_start = 0;
    for item in items {
        if item.text.len() > 1_000
            || item.start_ms < 0
            || item.end_ms < item.start_ms
            || item.start_ms < previous_start
            || item.end_ms > duration_ms + 1_000
        {
            return Err(ApiError::Invalid(
                "inference result contains malformed timestamps".to_owned(),
            ));
        }
        previous_start = item.start_ms;
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn zip_error(error: zip::result::ZipError) -> ApiError {
    tracing::error!(event = "inference.bundle.failed", error = %error);
    ApiError::Internal
}

#[cfg(test)]
mod tests {
    use super::{ImportedInferenceResult, InferenceBundleService, MODEL_ID, MODEL_REVISION};
    use crate::{model::TimedText, store::InferenceJob};
    use tempfile::tempdir;

    fn job(path: &str) -> InferenceJob {
        InferenceJob {
            id: "opaque-job".to_owned(),
            session_id: "session".to_owned(),
            audio_path: path.to_owned(),
            audio_sha256: "hash".to_owned(),
            audio_bytes: 44,
            sample_rate: 16_000,
            channels: 1,
            duration_ms: 1_000,
            model_id: MODEL_ID.to_owned(),
            model_revision: MODEL_REVISION.to_owned(),
            status: "pending_manual_inference".to_owned(),
            result_sha256: None,
            created_at: 100,
            expires_at: 200,
        }
    }

    fn result() -> ImportedInferenceResult {
        ImportedInferenceResult {
            schema_version: 1,
            job_id: "opaque-job".to_owned(),
            audio_sha256: "hash".to_owned(),
            model_id: MODEL_ID.to_owned(),
            model_revision: MODEL_REVISION.to_owned(),
            generated_at: 150,
            text: "kumusta".to_owned(),
            segments: vec![],
            words: vec![TimedText {
                text: "kumusta".to_owned(),
                start_ms: 0,
                end_ms: 900,
            }],
        }
    }

    #[test]
    fn rejects_expired_and_mismatched_results() {
        let root = tempdir().unwrap();
        let service = InferenceBundleService::new(root.path().to_owned());
        assert!(
            service
                .validate_import(&job("unused"), &result(), 201)
                .is_err()
        );
        let mut wrong = result();
        wrong.model_revision = "wrong".to_owned();
        assert!(
            service
                .validate_import(&job("unused"), &wrong, 160)
                .is_err()
        );
    }

    #[test]
    fn rejects_malformed_timestamps() {
        let root = tempdir().unwrap();
        let service = InferenceBundleService::new(root.path().to_owned());
        let mut malformed = result();
        malformed.words[0].end_ms = 2_001;
        assert!(
            service
                .validate_import(&job("unused"), &malformed, 160)
                .is_err()
        );
    }
}
