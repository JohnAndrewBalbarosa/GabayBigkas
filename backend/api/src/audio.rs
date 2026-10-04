use std::{fs, io::Cursor, path::Path};

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};

use crate::{error::ApiError, store::AudioChunk};

pub fn persist_pcm_chunk(
    directory: &Path,
    sequence: i64,
    sample_rate: u32,
    channels: u16,
    body: &[u8],
) -> Result<AudioChunk, ApiError> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    fs::create_dir_all(directory)?;
    let hash = format!("{:x}", Sha256::digest(body));
    let path = directory.join(format!("{sequence:08}-{sample_rate}-{channels}-{hash}.pcm"));
    if !path.exists() {
        let temporary = directory.join(format!("{}.partial", uuid::Uuid::new_v4()));
        let outcome = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(body)?;
            file.sync_all()?;
            match fs::hard_link(&temporary, &path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                Err(error) => Err(error),
            }
        })();
        let _ = fs::remove_file(&temporary);
        outcome?;
    }
    if fs::read(&path)? != body {
        return Err(ApiError::Conflict(
            "stored PCM content is inconsistent".to_owned(),
        ));
    }
    Ok(AudioChunk {
        sequence,
        sample_rate,
        channels,
        path: path.to_string_lossy().into_owned(),
    })
}

pub const TARGET_SAMPLE_RATE: u32 = 16_000;
const WINDOW_SECONDS: usize = 30;
const OVERLAP_SECONDS: usize = 5;

pub fn cleanup_capture_directory(root: &Path, session_id: &str) {
    if uuid::Uuid::parse_str(session_id).is_err() {
        return;
    }
    let Ok(root) = root.canonicalize() else {
        return;
    };
    let chunks = root.join(session_id).join("chunks");
    let Ok(target) = chunks.canonicalize() else {
        return;
    };
    if !target.starts_with(&root) {
        return;
    }
    if let Err(error) = fs::remove_dir_all(&target) {
        tracing::warn!(event = "audio.capture_cleanup.failed", session_id, error = %error);
    }
}

#[derive(Clone, Debug)]
pub struct ProcessedAudio {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
}

#[derive(Clone, Debug)]
pub struct AudioWindow {
    pub index: usize,
    pub start_ms: i64,
    pub wav: Vec<u8>,
}

pub fn preprocess_session(chunks: &[AudioChunk]) -> Result<ProcessedAudio, ApiError> {
    validate_chunk_sequence(chunks)?;
    let sample_rate = chunks[0].sample_rate;
    let channels = chunks[0].channels;
    let mut interleaved = Vec::new();
    let capture_bytes = chunks.iter().try_fold(0_u64, |total, chunk| {
        fs::metadata(&chunk.path).map(|metadata| total.saturating_add(metadata.len()))
    })?;
    if capture_bytes > 128 * 1024 * 1024 {
        return Err(ApiError::Invalid(
            "session exceeds the capture budget".to_owned(),
        ));
    }
    for chunk in chunks {
        if chunk.sample_rate != sample_rate || chunk.channels != channels {
            return Err(ApiError::Invalid(
                "audio format changed during the session".to_owned(),
            ));
        }
        let bytes = fs::read(&chunk.path)?;
        if bytes.len() % 2 != 0 {
            return Err(ApiError::Invalid(
                "PCM chunk has an odd byte length".to_owned(),
            ));
        }
        let (pairs, remainder) = bytes.as_chunks::<2>();
        debug_assert!(remainder.is_empty());
        interleaved.extend(pairs.iter().map(|pair| i16::from_le_bytes(*pair)));
    }
    if interleaved.len() > sample_rate as usize * channels as usize * 300 {
        return Err(ApiError::Invalid(
            "session exceeds the five-minute MVP limit".to_owned(),
        ));
    }
    let mono = mix_to_mono(&interleaved, channels)?;
    let resampled = resample_linear(&mono, sample_rate, TARGET_SAMPLE_RATE);
    Ok(ProcessedAudio {
        samples: normalize_signal(&resampled),
        sample_rate: TARGET_SAMPLE_RATE,
    })
}

pub fn inference_windows(audio: &ProcessedAudio) -> Result<Vec<AudioWindow>, ApiError> {
    let window_samples = audio.sample_rate as usize * WINDOW_SECONDS;
    let overlap_samples = audio.sample_rate as usize * OVERLAP_SECONDS;
    let step = window_samples - overlap_samples;
    let mut windows = Vec::new();
    let mut start = 0;
    while start < audio.samples.len() {
        let end = (start + window_samples).min(audio.samples.len());
        windows.push(AudioWindow {
            index: windows.len(),
            start_ms: samples_to_ms(start, audio.sample_rate),
            wav: wav_bytes(&audio.samples[start..end], audio.sample_rate)?,
        });
        if end == audio.samples.len() {
            break;
        }
        start += step;
    }
    Ok(windows)
}

pub fn write_processed_wav(path: &Path, audio: &ProcessedAudio) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, wav_bytes(&audio.samples, audio.sample_rate)?)?;
    Ok(())
}

pub fn read_processed_wav(path: &Path) -> Result<ProcessedAudio, ApiError> {
    let mut reader = WavReader::open(path).map_err(|error| {
        tracing::error!(event = "audio.processed_read_failed", error = %error);
        ApiError::Internal
    })?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != TARGET_SAMPLE_RATE || spec.bits_per_sample != 16 {
        return Err(ApiError::Invalid(
            "processed audio format is invalid".to_owned(),
        ));
    }
    let samples = reader
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            tracing::error!(event = "audio.processed_decode_failed", error = %error);
            ApiError::Internal
        })?;
    Ok(ProcessedAudio {
        samples,
        sample_rate: spec.sample_rate,
    })
}

pub fn write_sentence_clip(
    path: &Path,
    audio: &ProcessedAudio,
    start_ms: i64,
    end_ms: i64,
) -> Result<(), ApiError> {
    let bounded_start = start_ms.max(0) as usize * audio.sample_rate as usize / 1_000;
    let bounded_end = (end_ms.max(start_ms + 1) as usize * audio.sample_rate as usize / 1_000)
        .min(audio.samples.len());
    if bounded_start >= bounded_end {
        return Err(ApiError::Invalid(
            "sentence clip is outside the audio duration".to_owned(),
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        path,
        wav_bytes(
            &audio.samples[bounded_start..bounded_end],
            audio.sample_rate,
        )?,
    )?;
    Ok(())
}

pub fn cleanup_session_files(chunks: &[AudioChunk], processed_path: &Path) {
    for chunk in chunks {
        if let Err(error) = fs::remove_file(&chunk.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(event = "audio.cleanup.failed", path = %chunk.path, error = %error);
        }
    }
    if let Err(error) = fs::remove_file(processed_path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(event = "audio.cleanup.failed", path = %processed_path.display(), error = %error);
    }
}

fn validate_chunk_sequence(chunks: &[AudioChunk]) -> Result<(), ApiError> {
    if chunks.is_empty() {
        return Err(ApiError::Invalid("session has no audio chunks".to_owned()));
    }
    for (expected, chunk) in chunks.iter().enumerate() {
        if chunk.sequence != expected as i64 {
            return Err(ApiError::Invalid(format!(
                "missing audio chunk at sequence {expected}"
            )));
        }
    }
    Ok(())
}

fn mix_to_mono(samples: &[i16], channels: u16) -> Result<Vec<i16>, ApiError> {
    if channels == 0 || channels > 2 {
        return Err(ApiError::Invalid(
            "only mono or stereo PCM is supported".to_owned(),
        ));
    }
    if !samples.len().is_multiple_of(channels as usize) {
        return Err(ApiError::Invalid("PCM frames are incomplete".to_owned()));
    }
    Ok(samples
        .chunks_exact(channels as usize)
        .map(|frame| {
            let sum: i32 = frame.iter().map(|sample| *sample as i32).sum();
            (sum / channels as i32) as i16
        })
        .collect())
}

fn resample_linear(samples: &[i16], source_rate: u32, target_rate: u32) -> Vec<i16> {
    if samples.is_empty() || source_rate == target_rate {
        return samples.to_vec();
    }
    let output_len = samples.len() * target_rate as usize / source_rate as usize;
    (0..output_len)
        .map(|output_index| {
            let source_position = output_index as f64 * source_rate as f64 / target_rate as f64;
            let left = source_position.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let fraction = source_position - left as f64;
            let value = samples[left] as f64 * (1.0 - fraction) + samples[right] as f64 * fraction;
            value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
        })
        .collect()
}

fn normalize_signal(samples: &[i16]) -> Vec<i16> {
    if samples.is_empty() {
        return Vec::new();
    }
    let mean = samples.iter().map(|sample| *sample as f64).sum::<f64>() / samples.len() as f64;
    let centered: Vec<f64> = samples.iter().map(|sample| *sample as f64 - mean).collect();
    let peak = centered
        .iter()
        .fold(0.0_f64, |value, sample| value.max(sample.abs()));
    let gain = if peak > 0.0 {
        (i16::MAX as f64 * 0.9 / peak).min(4.0)
    } else {
        1.0
    };
    centered
        .into_iter()
        .map(|sample| {
            (sample * gain)
                .round()
                .clamp(i16::MIN as f64, i16::MAX as f64) as i16
        })
        .collect()
}

fn wav_bytes(samples: &[i16], sample_rate: u32) -> Result<Vec<u8>, ApiError> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = WavWriter::new(
            &mut cursor,
            WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            },
        )
        .map_err(|_| ApiError::Internal)?;
        for sample in samples {
            writer
                .write_sample(*sample)
                .map_err(|_| ApiError::Internal)?;
        }
        writer.finalize().map_err(|_| ApiError::Internal)?;
    }
    Ok(cursor.into_inner())
}

fn samples_to_ms(samples: usize, sample_rate: u32) -> i64 {
    (samples as u64 * 1_000 / sample_rate as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::{ProcessedAudio, TARGET_SAMPLE_RATE, inference_windows, normalize_signal};

    #[test]
    fn windows_overlap_and_keep_monotonic_offsets() {
        let audio = ProcessedAudio {
            samples: vec![0; TARGET_SAMPLE_RATE as usize * 61],
            sample_rate: TARGET_SAMPLE_RATE,
        };
        let windows = inference_windows(&audio).expect("windows");
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].start_ms, 0);
        assert_eq!(windows[1].start_ms, 25_000);
        assert_eq!(windows[2].start_ms, 50_000);
    }

    #[test]
    fn normalization_removes_dc_without_unbounded_gain() {
        let normalized = normalize_signal(&[1_000, 1_100, 900]);
        assert_eq!(normalized.iter().map(|value| *value as i32).sum::<i32>(), 0);
        assert!(normalized.iter().all(|value| value.abs() <= 400));
    }
}
