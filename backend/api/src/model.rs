use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TimedText {
    pub text: String,
    #[serde(default)]
    pub start_ms: i64,
    #[serde(default)]
    pub end_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Transcription {
    pub model: String,
    #[serde(default)]
    pub model_revision: String,
    pub text: String,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub segments: Vec<TimedText>,
    #[serde(default)]
    pub words: Vec<TimedText>,
}
