use std::{process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

use crate::{config::Config, error::ApiError, store::CoachAgentBinding};

#[derive(Clone)]
pub struct AgoraTokenIssuer {
    app_id: String,
    certificate: String,
    script: String,
}

#[derive(Deserialize)]
pub struct AgoraTokens {
    pub client_rtc_token: String,
    pub client_rtm_token: String,
    pub agent_token: String,
    pub server_token: String,
}

#[derive(Serialize)]
struct TokenRequest<'a> {
    channel: &'a str,
    #[serde(rename = "clientUid")]
    client_uid: &'a str,
    #[serde(rename = "agentUid")]
    agent_uid: &'a str,
    ttl: i64,
}

impl AgoraTokenIssuer {
    pub fn from_config(config: &Config) -> Option<Self> {
        Some(Self {
            app_id: config.agora_app_id.clone()?,
            certificate: config.agora_app_certificate.clone()?,
            script: config.agora_token_script.clone(),
        })
    }

    pub async fn issue(&self, binding: &CoachAgentBinding) -> Result<AgoraTokens, ApiError> {
        timeout(Duration::from_secs(10), self.run_token_adapter(binding))
            .await
            .map_err(|_| ApiError::ModelUnavailable)?
    }

    async fn run_token_adapter(
        &self,
        binding: &CoachAgentBinding,
    ) -> Result<AgoraTokens, ApiError> {
        let ttl = (binding.expires_at - crate::store::unix_now()).min(600);
        if ttl < 60 {
            return Err(ApiError::Conflict(
                "coach agent credentials have expired".to_owned(),
            ));
        }
        let mut child = Command::new("node")
            .arg(&self.script)
            .env("AGORA_APP_ID", &self.app_id)
            .env("AGORA_APP_CERTIFICATE", &self.certificate)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ApiError::ModelUnavailable)?;
        let request = serde_json::to_vec(&TokenRequest {
            channel: &binding.channel,
            client_uid: &binding.client_uid,
            agent_uid: &binding.agent_uid,
            ttl,
        })
        .map_err(|_| ApiError::Internal)?;
        let mut stdin = child.stdin.take().ok_or(ApiError::Internal)?;
        stdin.write_all(&request).await?;
        stdin.shutdown().await?;
        drop(stdin);
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .ok_or(ApiError::Internal)?
            .take(16_385)
            .read_to_end(&mut output)
            .await?;
        if output.len() > 16_384 || !child.wait().await?.success() {
            return Err(ApiError::ModelUnavailable);
        }
        serde_json::from_slice(&output).map_err(|_| ApiError::ModelUnavailable)
    }
}
