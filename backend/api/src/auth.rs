use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::ApiError;

pub const SESSION_COOKIE: &str = "coach_session";

#[derive(Clone, Debug)]
pub struct Principal {
    pub user_id: String,
    pub email: String,
    pub role: String,
}

#[derive(Clone, Default)]
pub struct LoginLimiter {
    attempts: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
}

impl LoginLimiter {
    pub fn allow(&self, identity: &str) -> Result<(), ApiError> {
        let mut attempts = self.attempts.lock().map_err(|_| ApiError::Internal)?;
        let recent = attempts.entry(identity.to_ascii_lowercase()).or_default();
        recent.retain(|attempt| attempt.elapsed() < Duration::from_secs(60));
        if recent.len() >= 5 {
            return Err(ApiError::Conflict(
                "too many login attempts; retry after one minute".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn record_failure(&self, identity: &str) {
        if let Ok(mut attempts) = self.attempts.lock() {
            attempts
                .entry(identity.to_ascii_lowercase())
                .or_default()
                .push(Instant::now());
        }
    }

    pub fn clear(&self, identity: &str) {
        if let Ok(mut attempts) = self.attempts.lock() {
            attempts.remove(&identity.to_ascii_lowercase());
        }
    }
}

pub fn hash_password(password: &str) -> Result<String, ApiError> {
    validate_password(password)?;
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|_| ApiError::Internal)?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|value| value.to_string())
        .map_err(|error| {
            tracing::error!(event = "authentication.password_hash.failed", error = %error);
            ApiError::Internal
        })
}

pub fn verify_password(password: &str, encoded: &str) -> bool {
    PasswordHash::new(encoded)
        .ok()
        .and_then(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .ok()
        })
        .is_some()
}

pub fn issue_session_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub fn hash_session_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| (name == SESSION_COOKIE).then(|| value.to_owned()))
}

pub fn session_cookie(token: &str, secure: bool) -> String {
    let policy = cookie_security_policy(secure);
    format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; {policy}; Max-Age=28800")
}

pub fn expired_session_cookie(secure: bool) -> String {
    let policy = cookie_security_policy(secure);
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; {policy}; Max-Age=0")
}

fn cookie_security_policy(secure: bool) -> &'static str {
    if secure {
        "SameSite=None; Secure"
    } else {
        "SameSite=Strict"
    }
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    let long_enough = password.chars().count() >= 12;
    let has_letter = password.chars().any(char::is_alphabetic);
    let has_number = password.chars().any(|character| character.is_ascii_digit());
    if long_enough && has_letter && has_number {
        Ok(())
    } else {
        Err(ApiError::Invalid(
            "password must contain at least 12 characters, one letter, and one number".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{hash_password, issue_session_token, session_cookie, verify_password};

    #[test]
    fn password_hash_round_trip_rejects_other_passwords() {
        let hash = hash_password("correct-horse-42").expect("hash password");
        assert!(verify_password("correct-horse-42", &hash));
        assert!(!verify_password("wrong-horse-42", &hash));
        assert!(!hash.contains("correct-horse-42"));
    }

    #[test]
    fn session_tokens_are_opaque_and_unique() {
        let first = issue_session_token();
        let second = issue_session_token();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn secure_session_cookie_supports_the_exact_cross_origin_frontend() {
        let cookie = session_cookie("opaque", true);
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=None; Secure"));
    }
}
