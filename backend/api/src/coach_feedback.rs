use std::time::Duration;

use reqwest::{Client, Response, header::AUTHORIZATION, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    agora_agent::sensitive_authorization, agora_tokens::AgoraTokenIssuer, config::Config,
    error::ApiError, store::CoachAgentBinding,
};

const MAX_PROVIDER_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub struct CoachFeedbackService {
    client: Client,
    agora_history_base: String,
    agora_app_id: String,
    agora_token: String,
    token_issuer: Option<AgoraTokenIssuer>,
    youtube_search_url: String,
    youtube_api_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct YoutubeResource {
    pub title: String,
    pub video_id: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeneratedCoachFeedback {
    pub coach_message: String,
    pub youtube_resource: YoutubeResource,
}

impl CoachFeedbackService {
    pub fn from_config(config: &Config) -> Result<Option<Self>, String> {
        match (
            &config.agora_app_id,
            &config.agora_convo_token,
            &config.youtube_api_key,
        ) {
            (Some(app_id), token, Some(youtube_api_key))
                if token.is_some() || config.agora_app_certificate.is_some() =>
            {
                let mut service = Self::new(
                    app_id.clone(),
                    token.clone().unwrap_or_default(),
                    youtube_api_key.clone(),
                    "https://api.agora.io/api/conversational-ai-agent/v2/projects".to_owned(),
                    "https://www.googleapis.com/youtube/v3/search".to_owned(),
                )?;
                if let Some(service) = service.as_mut() {
                    service.token_issuer = AgoraTokenIssuer::from_config(config);
                }
                Ok(service)
            }
            _ => Ok(None),
        }
    }

    pub async fn generate(
        &self,
        binding: &CoachAgentBinding,
        practice_words: &[String],
    ) -> Result<GeneratedCoachFeedback, ApiError> {
        let agent_id = binding.agent_id.as_deref().ok_or(ApiError::NotFound)?;
        validate_agent_id(agent_id)?;
        let coach_message = self.latest_assistant_message(binding).await?;
        let query = youtube_query(practice_words)?;
        let youtube_resource = self.first_youtube_result(&query).await?;
        Ok(GeneratedCoachFeedback {
            coach_message,
            youtube_resource,
        })
    }

    fn new(
        agora_app_id: String,
        agora_token: String,
        youtube_api_key: String,
        agora_history_base: String,
        youtube_search_url: String,
    ) -> Result<Option<Self>, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(12))
            .redirect(Policy::none())
            .build()
            .map_err(|error| format!("failed to build coach feedback client: {error}"))?;
        Ok(Some(Self {
            client,
            agora_history_base,
            agora_app_id,
            agora_token,
            token_issuer: None,
            youtube_search_url,
            youtube_api_key,
        }))
    }

    async fn latest_assistant_message(
        &self,
        binding: &CoachAgentBinding,
    ) -> Result<String, ApiError> {
        let agent_id = binding.agent_id.as_deref().ok_or(ApiError::NotFound)?;
        let token = match &self.token_issuer {
            Some(issuer) => issuer.issue(binding).await?.server_token,
            None => self.agora_token.clone(),
        };
        let url = format!(
            "{}/{}/agents/{}/history",
            self.agora_history_base, self.agora_app_id, agent_id
        );
        let response = self
            .client
            .get(url)
            .header(AUTHORIZATION, sensitive_authorization(&token)?)
            .send()
            .await
            .map_err(|_| ApiError::ModelUnavailable)?;
        let history: AgoraHistory = provider_json(response).await?;
        select_session_response(history.contents, &binding.session_id)
    }

    async fn first_youtube_result(&self, query: &str) -> Result<YoutubeResource, ApiError> {
        let response = self
            .client
            .get(&self.youtube_search_url)
            .query(&[
                ("part", "snippet"),
                ("type", "video"),
                ("maxResults", "3"),
                ("safeSearch", "strict"),
                ("videoEmbeddable", "true"),
                ("videoSyndicated", "true"),
                ("q", query),
                ("key", &self.youtube_api_key),
            ])
            .send()
            .await
            .map_err(|_| ApiError::ModelUnavailable)?;
        let search: YoutubeSearch = provider_json(response).await?;
        search
            .items
            .into_iter()
            .find_map(|item| {
                validate_video_id(&item.id.video_id).ok()?;
                Some(YoutubeResource {
                    title: item.snippet.title.chars().take(300).collect(),
                    url: format!("https://www.youtube.com/watch?v={}", item.id.video_id),
                    video_id: item.id.video_id,
                })
            })
            .ok_or_else(|| {
                ApiError::Conflict("YouTube returned no embeddable practice video".to_owned())
            })
    }
}

#[derive(Deserialize)]
struct AgoraHistory {
    #[serde(default)]
    contents: Vec<AgoraHistoryItem>,
}

#[derive(Deserialize)]
struct AgoraHistoryItem {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct YoutubeSearch {
    #[serde(default)]
    items: Vec<YoutubeSearchItem>,
}

#[derive(Deserialize)]
struct YoutubeSearchItem {
    id: YoutubeVideoId,
    snippet: YoutubeSnippet,
}

#[derive(Deserialize)]
struct YoutubeVideoId {
    #[serde(rename = "videoId")]
    video_id: String,
}

#[derive(Deserialize)]
struct YoutubeSnippet {
    title: String,
}

pub(crate) async fn provider_json<T: DeserializeOwned>(
    mut response: Response,
) -> Result<T, ApiError> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Err(ApiError::ModelUnavailable);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::ModelUnavailable)?
    {
        if body.len() + chunk.len() > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(ApiError::ModelUnavailable);
        }
        body.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let provider_code = provider_error_code(&body);
        tracing::warn!(
            event = "provider.http.rejected",
            http_status = status.as_u16(),
            provider_code = %provider_code,
        );
        return Err(ApiError::ModelUnavailable);
    }
    serde_json::from_slice(&body).map_err(|_| ApiError::ModelUnavailable)
}

fn provider_error_code(body: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return "unparseable".to_owned();
    };
    value
        .get("code")
        .or_else(|| value.pointer("/error/code"))
        .and_then(serde_json::Value::as_str)
        .filter(|code| {
            code.len() <= 80
                && code.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
        })
        .unwrap_or("unspecified")
        .to_owned()
}

fn youtube_query(practice_words: &[String]) -> Result<String, ApiError> {
    let word = practice_words
        .iter()
        .find(|word| !word.trim().is_empty())
        .ok_or_else(|| ApiError::Invalid("session has no practice word".to_owned()))?;
    Ok(format!(
        "{} English pronunciation practice",
        word.trim().chars().take(80).collect::<String>()
    ))
}

fn validate_agent_id(agent_id: &str) -> Result<(), ApiError> {
    crate::agora_agent::validate_runtime_agent_id(agent_id)
}

fn select_session_response(
    contents: Vec<AgoraHistoryItem>,
    session_id: &str,
) -> Result<String, ApiError> {
    let marker = format!("[session:{session_id}]");
    let mut awaiting_answer = false;
    let mut answer = None;
    for item in contents {
        if item.role == "user" {
            awaiting_answer = item.content.contains(&marker);
            answer = None;
        } else if awaiting_answer && item.role == "assistant" && !item.content.trim().is_empty() {
            let text = item
                .content
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']');
            if text.len() > 8_000 {
                return Err(ApiError::ModelUnavailable);
            }
            answer = Some(text.trim().to_owned());
        }
    }
    answer
        .filter(|text| !text.is_empty())
        .ok_or_else(|| ApiError::Conflict("awaiting the session coach response via RTM".to_owned()))
}

fn validate_video_id(video_id: &str) -> Result<(), ApiError> {
    if video_id.len() != 11
        || !video_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(ApiError::ModelUnavailable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        AgoraHistoryItem, CoachFeedbackService, select_session_response, validate_agent_id,
        validate_video_id, youtube_query,
    };
    use crate::config::Config;

    #[test]
    fn unrelated_greetings_and_other_session_messages_are_not_feedback() {
        let item = |role: &str, content: &str| AgoraHistoryItem {
            role: role.to_owned(),
            content: content.to_owned(),
        };
        assert!(select_session_response(vec![item("assistant", "Welcome!")], "owned").is_err());
        assert!(
            select_session_response(
                vec![
                    item("user", "[session:other] evidence"),
                    item("assistant", "Other response")
                ],
                "owned"
            )
            .is_err()
        );
        assert_eq!(
            select_session_response(
                vec![
                    item("assistant", "Welcome!"),
                    item("user", "[session:owned] evidence"),
                    item("assistant", "[Practice slowly.]")
                ],
                "owned"
            )
            .unwrap(),
            "Practice slowly."
        );
        assert!(
            select_session_response(
                vec![
                    item("user", "[session:owned] evidence"),
                    item("assistant", "Good"),
                    item("user", "another request")
                ],
                "owned"
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn owned_history_and_first_safe_youtube_result_form_feedback() {
        use axum::{Json, Router, extract::Query, http::HeaderMap, routing::get};
        use serde_json::json;
        use std::{
            collections::HashMap,
            sync::{
                Arc,
                atomic::{AtomicUsize, Ordering},
            },
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let youtube_calls = calls.clone();
        let app = Router::new()
            .route("/projects/app/agents/agent-1/history", get(|headers: HeaderMap| async move {
                assert_eq!(headers["authorization"], "agora token=test-token");
                Json(json!({"contents": [{"role":"assistant","content":"Welcome"},{"role":"user","content":"[session:owned] evidence"},{"role":"assistant","content":"[Take your time.]"}]}))
            }))
            .route("/youtube", get(move |Query(query): Query<HashMap<String,String>>| {
                let calls = youtube_calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(query["maxResults"], "3");
                    assert_eq!(query["safeSearch"], "strict");
                    assert_eq!(query["type"], "video");
                    assert!(query["q"].contains("Fifty people"));
                    Json(json!({"items":[{"id":{"videoId":"dQw4w9WgXcQ"},"snippet":{"title":"Practice"}}]}))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let service = CoachFeedbackService::new(
            "app".to_owned(),
            "test-token".to_owned(),
            "test-key".to_owned(),
            format!("http://{address}/projects"),
            format!("http://{address}/youtube"),
        )
        .unwrap()
        .unwrap();
        let binding = crate::store::CoachAgentBinding {
            session_id: "owned".to_owned(),
            agent_id: Some("agent-1".to_owned()),
            channel: "channel".to_owned(),
            agent_uid: "1001".to_owned(),
            client_uid: "1002".to_owned(),
            status: "running".to_owned(),
            expires_at: crate::store::unix_now() + 600,
        };
        let feedback = service
            .generate(&binding, &["Fifty people think clearly.".to_owned()])
            .await
            .unwrap();
        assert_eq!(feedback.coach_message, "Take your time.");
        assert_eq!(
            feedback.youtube_resource.url,
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let other = crate::store::CoachAgentBinding {
            session_id: "other".to_owned(),
            ..binding
        };
        assert!(
            service
                .generate(&other, &["Other".to_owned()])
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[test]
    fn missing_youtube_key_disables_adapter_without_breaking_startup() {
        let mut config = Config::for_test();
        config.agora_app_id = Some("app-id".to_owned());
        config.agora_convo_token = Some("token".to_owned());
        assert!(
            CoachFeedbackService::from_config(&config)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn builds_practice_query_from_expected_phrase() {
        assert_eq!(
            youtube_query(&["Fifty people think clearly.".to_owned()]).unwrap(),
            "Fifty people think clearly. English pronunciation practice"
        );
    }

    #[test]
    fn rejects_provider_identifiers_that_can_change_request_paths() {
        assert!(validate_agent_id("../agent").is_err());
        assert!(validate_video_id("not a video id").is_err());
        assert!(validate_agent_id("8ed6a5c3-80da-4910-8e31-92c55c8fea44").is_ok());
        assert!(validate_video_id("dQw4w9WgXcQ").is_ok());
    }

    #[test]
    fn first_valid_video_id_is_selected_when_earlier_items_are_invalid() {
        // Simulates YouTube returning a restricted/malformed video before a valid one.
        // The old code (maxResults=1) would have failed hard; the new code skips bad items.
        use serde_json::json;
        let items = json!([
            {"id": {"videoId": ""}, "snippet": {"title": "Restricted"}},
            {"id": {"videoId": "dQw4w9WgXcQ"}, "snippet": {"title": "Sovereign pronunciation"}}
        ]);
        let search: super::YoutubeSearch = serde_json::from_value(json!({"items": items})).unwrap();
        let result = search.items.into_iter().find_map(|item| {
            validate_video_id(&item.id.video_id).ok()?;
            Some(item.id.video_id)
        });
        assert_eq!(result.as_deref(), Some("dQw4w9WgXcQ"));
    }
}
