use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct TimedText {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Deserialize)]
pub struct TranscriptionRequest {
    pub audio_wav_base64: String,
}

#[derive(Serialize)]
pub struct WorkerRequest<'a> {
    pub request_id: &'a str,
    pub action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_wav_base64: Option<&'a str>,
}

#[derive(Deserialize)]
pub struct WorkerReady {
    #[serde(rename = "type")]
    pub message_type: String,
    pub model: String,
    pub model_revision: String,
    pub device: String,
    pub accelerator: String,
    pub gpu_name: String,
}

#[derive(Deserialize, Serialize)]
pub struct WorkerResponse {
    pub request_id: String,
    pub ok: bool,
    pub text: Option<String>,
    pub model: Option<String>,
    pub model_revision: Option<String>,
    pub device: Option<String>,
    pub accelerator: Option<String>,
    pub gpu_name: Option<String>,
    pub gpu_memory_free_mb: Option<u64>,
    pub gpu_memory_total_mb: Option<u64>,
    pub model_loaded: Option<bool>,
    pub duration_ms: u64,
    #[serde(default)]
    pub segments: Vec<TimedText>,
    #[serde(default)]
    pub words: Vec<TimedText>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub worker: &'static str,
    pub model_loaded: bool,
    pub accelerator: String,
    pub device: String,
    pub gpu_name: String,
    pub gpu_memory_free_mb: u64,
    pub gpu_memory_total_mb: u64,
    pub model: String,
    pub model_revision: String,
    pub probe_duration_ms: u64,
}

#[derive(Serialize)]
pub struct ErrorResponse<'a> {
    pub error: &'a str,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::{WorkerRequest, WorkerResponse};

    #[test]
    fn health_request_omits_audio() {
        let request = WorkerRequest {
            request_id: "request-1",
            action: "health",
            audio_wav_base64: None,
        };
        let value = serde_json::to_value(request).expect("serialize health request");

        assert_eq!(value["action"], "health");
        assert!(value.get("audio_wav_base64").is_none());
    }

    #[test]
    fn worker_failure_contract_is_explicit() {
        let response: WorkerResponse = serde_json::from_str(
            r#"{"request_id":"request-1","ok":false,"duration_ms":4,"error":"bad audio"}"#,
        )
        .expect("deserialize worker failure");

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("bad audio"));
    }
}
