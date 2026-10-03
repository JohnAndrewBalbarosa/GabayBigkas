use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, StatusCode, header::HeaderValue, redirect::Policy};
use serde::Serialize;

use crate::{config::Config, error::ApiError, inference_bundle::ImportedInferenceResult};

const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub struct ModalInferenceClient {
    client: Client,
    endpoint: String,
    token_id: HeaderValue,
    token_secret: HeaderValue,
}

#[derive(Serialize)]
struct ModalRequest {
    bundle_zip_base64: String,
}

impl ModalInferenceClient {
    pub fn from_config(config: &Config) -> Result<Option<Self>, String> {
        if !config.modal_enabled {
            return Ok(None);
        }
        let endpoint = required_setting(&config.modal_inference_url, "COACH_MODAL_INFERENCE_URL")?;
        if !endpoint.starts_with("https://") {
            return Err("COACH_MODAL_INFERENCE_URL must use HTTPS".to_owned());
        }
        let mut token_id = sensitive_header(required_setting(
            &config.modal_token_id,
            "COACH_MODAL_TOKEN_ID",
        )?)?;
        let mut token_secret = sensitive_header(required_setting(
            &config.modal_token_secret,
            "COACH_MODAL_TOKEN_SECRET",
        )?)?;
        token_id.set_sensitive(true);
        token_secret.set_sensitive(true);
        let client = Client::builder()
            .redirect(Policy::limited(4))
            .timeout(Duration::from_secs(650))
            .build()
            .map_err(|_| "failed to initialize the Modal HTTP client".to_owned())?;
        Ok(Some(Self {
            client,
            endpoint: endpoint.to_owned(),
            token_id,
            token_secret,
        }))
    }

    pub async fn infer(
        &self,
        job_id: &str,
        bundle: Vec<u8>,
    ) -> Result<ImportedInferenceResult, ApiError> {
        let started = Instant::now();
        tracing::info!(event = "modal.inference.started", job_id);
        let response = self
            .client
            .post(&self.endpoint)
            .header("Modal-Key", self.token_id.clone())
            .header("Modal-Secret", self.token_secret.clone())
            .json(&ModalRequest {
                bundle_zip_base64: STANDARD.encode(bundle),
            })
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(event = "modal.inference.request_failed", job_id, error = %bounded_error(&error));
                ApiError::ModelUnavailable
            })?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|_| ApiError::ModelUnavailable)?;
        if !status.is_success() {
            tracing::warn!(event = "modal.inference.rejected", job_id, status = %status);
            return Err(map_status(status));
        }
        if body.len() > MAX_RESULT_BYTES {
            tracing::warn!(
                event = "modal.inference.result_oversized",
                job_id,
                bytes = body.len()
            );
            return Err(ApiError::ModelUnavailable);
        }
        let result = serde_json::from_slice(&body).map_err(|_| {
            tracing::warn!(event = "modal.inference.result_invalid", job_id);
            ApiError::ModelUnavailable
        })?;
        tracing::info!(
            event = "modal.inference.completed",
            job_id,
            duration_ms = started.elapsed().as_millis() as u64
        );
        Ok(result)
    }
}

fn required_setting<'a>(setting: &'a Option<String>, name: &str) -> Result<&'a str, String> {
    setting
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is required when COACH_MODAL_ENABLED=true"))
}

fn sensitive_header(value: &str) -> Result<HeaderValue, String> {
    HeaderValue::from_str(value).map_err(|_| "Modal credential contains invalid bytes".to_owned())
}

fn bounded_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection"
    } else if error.is_redirect() {
        "redirect"
    } else {
        "transport"
    }
}

fn map_status(status: StatusCode) -> ApiError {
    match status {
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
            ApiError::Invalid("Modal rejected the bounded inference bundle".to_owned())
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ApiError::ModelUnavailable,
        _ => ApiError::ModelUnavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{Json, Router, http::HeaderMap, routing::post};
    use reqwest::{Client, StatusCode, header::HeaderValue};
    use serde_json::{Value, json};

    use super::{ModalInferenceClient, map_status};
    use crate::config::Config;
    use crate::error::ApiError;

    #[test]
    fn disabled_modal_does_not_require_credentials() {
        let config = Config::for_test();
        assert!(
            ModalInferenceClient::from_config(&config)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn enabled_modal_requires_https_and_complete_credentials() {
        let mut config = Config::for_test();
        config.modal_enabled = true;
        config.modal_inference_url = Some("http://example.test/infer".to_owned());
        config.modal_token_id = Some("id".to_owned());
        config.modal_token_secret = Some("secret".to_owned());
        assert_eq!(
            ModalInferenceClient::from_config(&config).err().unwrap(),
            "COACH_MODAL_INFERENCE_URL must use HTTPS"
        );
    }

    #[tokio::test]
    async fn inference_sends_proxy_credentials_and_a_bounded_bundle() {
        let captured = Arc::new(Mutex::new(None));
        let request_capture = Arc::clone(&captured);
        let app = Router::new().route(
            "/",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let request_capture = Arc::clone(&request_capture);
                async move {
                    *request_capture.lock().unwrap() = Some((headers, body));
                    Json(json!({
                        "schema_version": 1,
                        "job_id": "job-1",
                        "audio_sha256": "abc",
                        "model_id": "BuzzASR/filipino",
                        "model_revision": "revision",
                        "generated_at": 1,
                        "text": "hello",
                        "segments": [],
                        "words": []
                    }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ModalInferenceClient {
            client: Client::new(),
            endpoint: format!("http://{address}"),
            token_id: HeaderValue::from_static("wk-test"),
            token_secret: HeaderValue::from_static("ws-test"),
        };

        let result = client.infer("job-1", vec![1, 2, 3]).await.unwrap();
        let (headers, body) = captured.lock().unwrap().take().unwrap();
        server.abort();

        assert_eq!(result.job_id, "job-1");
        assert_eq!(headers["Modal-Key"], "wk-test");
        assert_eq!(headers["Modal-Secret"], "ws-test");
        assert_eq!(body["bundle_zip_base64"], "AQID");
    }

    #[test]
    fn response_statuses_preserve_validation_and_auth_boundaries() {
        assert!(matches!(
            map_status(StatusCode::UNPROCESSABLE_ENTITY),
            ApiError::Invalid(_)
        ));
        assert!(matches!(
            map_status(StatusCode::UNAUTHORIZED),
            ApiError::ModelUnavailable
        ));
    }
}
