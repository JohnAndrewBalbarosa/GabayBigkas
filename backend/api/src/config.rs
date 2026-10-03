use std::{env, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub bind: String,
    pub database_path: PathBuf,
    pub private_audio_root: PathBuf,
    pub secure_cookie: bool,
    pub allowed_origin: Option<String>,
    pub modal_enabled: bool,
    pub modal_inference_url: Option<String>,
    pub modal_token_id: Option<String>,
    pub modal_token_secret: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            bind: env::var("COACH_BIND").unwrap_or_else(|_| "127.0.0.1:4320".to_owned()),
            database_path: env::var_os("COACH_DATABASE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".artifacts/state/coach.sqlite3")),
            private_audio_root: env::var_os("COACH_AUDIO_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".artifacts/private/audio")),
            secure_cookie: env::var("COACH_SECURE_COOKIE")
                .map(|value| value.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
            allowed_origin: env::var("COACH_ALLOWED_ORIGIN")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            modal_enabled: env::var("COACH_MODAL_ENABLED")
                .map(|value| value.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
            modal_inference_url: optional_env("COACH_MODAL_INFERENCE_URL"),
            modal_token_id: optional_env("COACH_MODAL_TOKEN_ID"),
            modal_token_secret: optional_env("COACH_MODAL_TOKEN_SECRET"),
        }
    }

    #[cfg(test)]
    pub fn for_test() -> Self {
        Self {
            bind: "127.0.0.1:0".to_owned(),
            database_path: PathBuf::from(":memory:"),
            private_audio_root: PathBuf::from(".artifacts/private/test"),
            secure_cookie: false,
            allowed_origin: None,
            modal_enabled: false,
            modal_inference_url: None,
            modal_token_id: None,
            modal_token_secret: None,
        }
    }
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}
