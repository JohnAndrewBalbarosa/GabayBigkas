use std::{env, path::PathBuf};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub database_path: PathBuf,
    pub private_audio_root: PathBuf,
    pub secure_cookie: bool,
    pub allowed_origin: Option<String>,
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
        }
    }
}
