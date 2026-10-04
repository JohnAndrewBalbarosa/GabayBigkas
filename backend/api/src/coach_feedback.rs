use std::time::Duration;

use reqwest::{Client, Response, header::AUTHORIZATION, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{config::Config, error::ApiError};

const MAX_PROVIDER_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub struct CoachFeedbackService {
    client: Client,
    agora_history_base: String,
    agora_app_id: String,
    agora_token: String,
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
        let Some(youtube_api_key) = &config.youtube_api_key else {
            return Ok(None);
        };
        match (&config.agora_app_id, &config.agora_convo_token) {
            (Some(app_id), Some(token)) => Self::new(
                app_id.clone(),
                token.clone(),
                youtube_api_key.clone(),
                "https://api.agora.io/api/conversational-ai-agent/v2/projects".to_owned(),
                "https://www.googleapis.com/youtube/v3/search".to_owned(),
            ),
            _ => Err(
                "AGORA_APP_ID and AGORA_CONVO_TOKEN are required when YOUTUBE_API_KEY is set"
                    .to_owned(),
            ),
        }
    }

    pub async fn generate(
        &self,
        agent_id: &str,
        expected_phrases: &[String],
    ) -> Result<GeneratedCoachFeedback, ApiError> {
        validate_agent_id(agent_id)?;
        let coach_message = self.latest_assistant_message(agent_id).await?;
        let query = youtube_query(expected_phrases)?;
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
            youtube_search_url,
            youtube_api_key,
        }))
    }

    async fn latest_assistant_message(&self, agent_id: &str) -> Result<String, ApiError> {
        let url = format!(
            "{}/{}/agents/{}/history",
            self.agora_history_base, self.agora_app_id, agent_id
        );
        let response = self
            .client
            .get(url)
            .header(AUTHORIZATION, format!("agora token={}", self.agora_token))
            .send()
            .await
            .map_err(|_| ApiError::ModelUnavailable)?;
        let history: AgoraHistory = provider_json(response).await?;
        history
            .contents
            .into_iter()
            .rev()
            .find(|item| item.role == "assistant" && !item.content.trim().is_empty())
            .map(|item| item.content)
            .ok_or_else(|| {
                ApiError::Conflict("Agora agent has no completed coach response".to_owned())
            })
    }

    async fn first_youtube_result(&self, query: &str) -> Result<YoutubeResource, ApiError> {
        let response = self
            .client
            .get(&self.youtube_search_url)
            .query(&[
                ("part", "snippet"),
                ("type", "video"),
                ("maxResults", "1"),
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
        let item =
            search.items.into_iter().next().ok_or_else(|| {
                ApiError::Conflict("YouTube returned no practice video".to_owned())
            })?;
        validate_video_id(&item.id.video_id)?;
        Ok(YoutubeResource {
            title: item.snippet.title.chars().take(300).collect(),
            url: format!("https://www.youtube.com/watch?v={}", item.id.video_id),
            video_id: item.id.video_id,
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

async fn provider_json<T: DeserializeOwned>(mut response: Response) -> Result<T, ApiError> {
    if !response.status().is_success() {
        return Err(ApiError::ModelUnavailable);
    }
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
    serde_json::from_slice(&body).map_err(|_| ApiError::ModelUnavailable)
}

fn youtube_query(expected_phrases: &[String]) -> Result<String, ApiError> {
    let phrase = expected_phrases
        .iter()
        .find(|phrase| !phrase.trim().is_empty())
        .ok_or_else(|| ApiError::Invalid("session has no expected phrase".to_owned()))?;
    Ok(format!(
        "{} English pronunciation practice",
        phrase.trim().chars().take(200).collect::<String>()
    ))
}

fn validate_agent_id(agent_id: &str) -> Result<(), ApiError> {
    if agent_id.is_empty()
        || agent_id.len() > 128
        || !agent_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(ApiError::Invalid("invalid Agora agent id".to_owned()));
    }
    Ok(())
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
    use super::{CoachFeedbackService, validate_agent_id, validate_video_id, youtube_query};
    use crate::config::Config;

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
}
