use agora_token::{rtc_token_builder, rtm_token_builder};

use crate::{config::Config, error::ApiError, store::CoachAgentBinding};

const MIN_TOKEN_TTL_SECONDS: i64 = 60;
const MAX_TOKEN_TTL_SECONDS: i64 = 600;

#[derive(Clone)]
pub struct AgoraTokenIssuer {
    app_id: String,
    certificate: String,
}

pub struct AgoraTokens {
    pub client_rtc_token: String,
    pub client_rtm_token: String,
    pub agent_token: String,
    pub server_token: String,
}

impl AgoraTokenIssuer {
    pub fn from_config(config: &Config) -> Option<Self> {
        Some(Self {
            app_id: config.agora_app_id.clone()?,
            certificate: config.agora_app_certificate.clone()?,
        })
    }

    pub async fn issue(&self, binding: &CoachAgentBinding) -> Result<AgoraTokens, ApiError> {
        let ttl = bounded_token_ttl(binding.expires_at)?;
        let client_uid = numeric_uid(&binding.client_uid)?;
        numeric_uid(&binding.agent_uid)?;
        validate_token_scope(self, binding)?;

        let client_rtc_token = rtc_token_builder::build_token_with_uid(
            &self.app_id,
            &self.certificate,
            &binding.channel,
            client_uid,
            rtc_token_builder::ROLE_SUBSCRIBER,
            ttl,
            ttl,
        )
        .map_err(|_| token_generation_failed("client_rtc"))?;
        let client_rtm_token = rtm_token_builder::build_token(
            &self.app_id,
            &self.certificate,
            &binding.client_uid,
            ttl,
        )
        .map_err(|_| token_generation_failed("client_rtm"))?;
        let agent_token = rtc_token_builder::build_token_with_rtm(
            &self.app_id,
            &self.certificate,
            &binding.channel,
            &binding.agent_uid,
            rtc_token_builder::ROLE_PUBLISHER,
            ttl,
            ttl,
        )
        .map_err(|_| token_generation_failed("agent"))?;
        let server_token = rtc_token_builder::build_token_with_rtm(
            &self.app_id,
            &self.certificate,
            &binding.channel,
            &binding.client_uid,
            rtc_token_builder::ROLE_PUBLISHER,
            ttl,
            ttl,
        )
        .map_err(|_| token_generation_failed("server"))?;

        tracing::info!(
            event = "agora.tokens.issued",
            session_id = %binding.session_id,
            ttl_seconds = ttl,
        );
        Ok(AgoraTokens {
            client_rtc_token,
            client_rtm_token,
            agent_token,
            server_token,
        })
    }
}

#[inline]
fn bounded_token_ttl(expires_at: i64) -> Result<u32, ApiError> {
    let ttl = (expires_at - crate::store::unix_now()).min(MAX_TOKEN_TTL_SECONDS);
    if ttl < MIN_TOKEN_TTL_SECONDS {
        return Err(ApiError::Conflict(
            "coach agent credentials have expired".to_owned(),
        ));
    }
    u32::try_from(ttl).map_err(|_| ApiError::Internal)
}

#[inline]
fn numeric_uid(value: &str) -> Result<u32, ApiError> {
    value
        .parse::<u32>()
        .ok()
        .filter(|uid| *uid > 0)
        .ok_or_else(|| invalid_token_scope("uid"))
}

fn validate_token_scope(
    issuer: &AgoraTokenIssuer,
    binding: &CoachAgentBinding,
) -> Result<(), ApiError> {
    if !is_hex_identifier(&issuer.app_id) || !is_hex_identifier(&issuer.certificate) {
        return Err(invalid_token_scope("credentials"));
    }
    let Some(channel_id) = binding.channel.strip_prefix("coach-") else {
        return Err(invalid_token_scope("channel"));
    };
    if !is_hex_identifier(channel_id) {
        return Err(invalid_token_scope("channel"));
    }
    Ok(())
}

#[inline]
fn is_hex_identifier(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn invalid_token_scope(scope: &'static str) -> ApiError {
    tracing::warn!(event = "agora.token_scope.invalid", scope);
    ApiError::ModelUnavailable
}

fn token_generation_failed(token_kind: &'static str) -> ApiError {
    tracing::warn!(event = "agora.token_generation.failed", token_kind);
    ApiError::ModelUnavailable
}

#[cfg(test)]
mod tests {
    use agora_token::access_token::{
        self, AccessToken, PRIVILEGE_JOIN_CHANNEL, PRIVILEGE_LOGIN, PRIVILEGE_PUBLISH_AUDIO_STREAM,
        SERVICE_TYPE_RTC, SERVICE_TYPE_RTM, ServiceRtc, ServiceRtm,
    };

    use super::*;

    const APP_ID: &str = "970CA35de60c44645bbae8a215061b33";
    const APP_CERTIFICATE: &str = "5CFd2fd1755d40ecb72977518be15d3b";

    #[tokio::test]
    async fn issues_signed_tokens_with_expected_scopes() {
        let issuer = issuer();
        let tokens = issuer.issue(&binding()).await.unwrap();

        let client_rtc = parse_token(&tokens.client_rtc_token);
        let client_rtc_service = service::<ServiceRtc>(&client_rtc, SERVICE_TYPE_RTC);
        assert_eq!(client_rtc_service.channel_name, binding().channel);
        assert_eq!(client_rtc_service.uid, "1002");
        assert!(
            client_rtc_service
                .service
                .privileges
                .contains_key(&PRIVILEGE_JOIN_CHANNEL)
        );
        assert!(
            !client_rtc_service
                .service
                .privileges
                .contains_key(&PRIVILEGE_PUBLISH_AUDIO_STREAM)
        );

        let client_rtm = parse_token(&tokens.client_rtm_token);
        let client_rtm_service = service::<ServiceRtm>(&client_rtm, SERVICE_TYPE_RTM);
        assert_eq!(client_rtm_service.user_id, "1002");
        assert!(
            client_rtm_service
                .service
                .privileges
                .contains_key(&PRIVILEGE_LOGIN)
        );

        assert_combined_token(&tokens.agent_token, "1001");
        assert_combined_token(&tokens.server_token, "1002");
        assert_ne!(tokens.agent_token, tokens.server_token);
        for token in [
            tokens.client_rtc_token,
            tokens.client_rtm_token,
            tokens.agent_token,
            tokens.server_token,
        ] {
            assert!(token.starts_with("007"));
            assert!(!token.contains(APP_CERTIFICATE));
        }
    }

    #[tokio::test]
    async fn rejects_expired_or_unbounded_token_scopes() {
        let issuer = issuer();
        let mut invalid = binding();
        invalid.expires_at = crate::store::unix_now() + 59;
        assert!(matches!(
            issuer.issue(&invalid).await,
            Err(ApiError::Conflict(_))
        ));

        for mutate in [
            |binding: &mut CoachAgentBinding| binding.channel = "../other".to_owned(),
            |binding: &mut CoachAgentBinding| binding.client_uid = "0".to_owned(),
            |binding: &mut CoachAgentBinding| binding.agent_uid = "not-a-uid".to_owned(),
        ] {
            let mut invalid = binding();
            mutate(&mut invalid);
            assert!(matches!(
                issuer.issue(&invalid).await,
                Err(ApiError::ModelUnavailable)
            ));
        }
    }

    fn issuer() -> AgoraTokenIssuer {
        AgoraTokenIssuer {
            app_id: APP_ID.to_owned(),
            certificate: APP_CERTIFICATE.to_owned(),
        }
    }

    fn binding() -> CoachAgentBinding {
        CoachAgentBinding {
            session_id: "session-1".to_owned(),
            agent_id: None,
            channel: format!("coach-{}", "c".repeat(32)),
            agent_uid: "1001".to_owned(),
            client_uid: "1002".to_owned(),
            status: "starting".to_owned(),
            expires_at: crate::store::unix_now() + 600,
        }
    }

    fn parse_token(token: &str) -> AccessToken {
        let mut parsed = access_token::create_access_token();
        assert!(parsed.parse(token).unwrap());
        assert!(parsed.verify_signature(APP_CERTIFICATE));
        parsed
    }

    fn service<T: 'static>(token: &AccessToken, service_type: u16) -> &T {
        token
            .services
            .iter()
            .find(|service| service.get_service_type() == service_type)
            .and_then(|service| service.as_any().downcast_ref::<T>())
            .expect("expected token service")
    }

    fn assert_combined_token(token: &str, expected_uid: &str) {
        let parsed = parse_token(token);
        let rtc = service::<ServiceRtc>(&parsed, SERVICE_TYPE_RTC);
        let rtm = service::<ServiceRtm>(&parsed, SERVICE_TYPE_RTM);
        assert_eq!(rtc.uid, expected_uid);
        assert_eq!(rtm.user_id, expected_uid);
        assert!(
            rtc.service
                .privileges
                .contains_key(&PRIVILEGE_PUBLISH_AUDIO_STREAM)
        );
        assert!(rtm.service.privileges.contains_key(&PRIVILEGE_LOGIN));
    }
}
