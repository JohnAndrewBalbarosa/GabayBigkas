use serde::Serialize;

use crate::{model::Transcription, store::TranscriptEvent};

#[derive(Clone, Debug, Serialize)]
pub struct ComparisonCandidate {
    pub expected_text: String,
    pub agora_text: String,
    pub buzz_text: String,
    pub sentence_start_ms: i64,
    pub sentence_end_ms: i64,
    pub focus_start_ms: i64,
    pub focus_end_ms: i64,
}

pub fn compare_session(
    expected_phrases: &[String],
    agora_events: &[TranscriptEvent],
    buzz: &Transcription,
) -> Vec<ComparisonCandidate> {
    expected_phrases
        .iter()
        .enumerate()
        .filter_map(|(index, expected)| {
            let agora = agora_events.get(index)?;
            let buzz_words = buzz
                .words
                .iter()
                .filter(|word| word.end_ms >= agora.start_ms && word.start_ms <= agora.end_ms)
                .collect::<Vec<_>>();
            let buzz_text = if buzz_words.is_empty() {
                buzz.segments
                    .iter()
                    .filter(|segment| {
                        segment.end_ms >= agora.start_ms && segment.start_ms <= agora.end_ms
                    })
                    .map(|segment| segment.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                buzz_words
                    .iter()
                    .map(|word| word.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            if normalize(&agora.text) == normalize(&buzz_text) {
                return None;
            }
            let first_mismatch = buzz_words.iter().find(|word| {
                !normalize(expected)
                    .split_whitespace()
                    .any(|expected_word| expected_word == normalize(&word.text))
            });
            let focus_start = first_mismatch.map_or(agora.start_ms, |word| word.start_ms);
            let focus_end = first_mismatch.map_or(agora.end_ms, |word| word.end_ms);
            Some(ComparisonCandidate {
                expected_text: expected.clone(),
                agora_text: agora.text.clone(),
                buzz_text,
                sentence_start_ms: (agora.start_ms - 250).max(0),
                sentence_end_ms: agora.end_ms + 250,
                focus_start_ms: focus_start,
                focus_end_ms: focus_end.max(focus_start + 1),
            })
        })
        .collect()
}

fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character.is_whitespace() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use crate::{model::Transcription, store::TranscriptEvent};

    use super::compare_session;

    #[test]
    fn disagreement_is_review_candidate_not_pronunciation_verdict() {
        let candidates = compare_session(
            &["fifty people".to_owned()],
            &[TranscriptEvent {
                sequence: 0,
                text: "pifty people".to_owned(),
                start_ms: 1_000,
                end_ms: 2_000,
            }],
            &Transcription {
                model: "BuzzASR/filipino".to_owned(),
                model_revision: "test".to_owned(),
                text: "fifty people".to_owned(),
                duration_ms: 2_000,
                segments: Vec::new(),
                words: Vec::new(),
            },
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].sentence_start_ms, 750);
    }
}
