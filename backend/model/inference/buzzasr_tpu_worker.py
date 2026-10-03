"""Persistent JSONL bridge between the Rust gateway and a Colab TPU.

Stdout is reserved for protocol messages. Diagnostics go to stderr.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import wave
from typing import Any

import numpy as np
import torch
import torch_xla
from transformers import WhisperForConditionalGeneration, WhisperProcessor

MODEL_ID = os.environ.get("BUZZASR_MODEL_ID", "BuzzASR/filipino")
MODEL_REVISION = os.environ.get("BUZZASR_MODEL_REVISION", "fb8cf0d93e2437f8d639549c67733ca9db10e055")
MAX_WAV_BYTES = 10 * 1024 * 1024
REQUIRED_SAMPLE_RATE = 16_000
FIXED_AUDIO_SECONDS = 30


def main() -> None:
    device = torch_xla.device()
    if not str(device).startswith("xla"):
        raise RuntimeError(f"TPU required; resolved device was {device}")

    log("buzzasr.worker.loading", model=MODEL_ID, device=str(device))
    processor = WhisperProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    model = WhisperForConditionalGeneration.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        dtype=torch.bfloat16,
    ).to(device).eval()
    torch_xla.sync()

    emit(
        {
            "type": "ready",
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "device": str(device),
        }
    )
    for line in sys.stdin:
        handle_request(line, processor, model, device)


def handle_request(
    line: str,
    processor: WhisperProcessor,
    model: WhisperForConditionalGeneration,
    device: torch.device,
) -> None:
    request_id = "unknown"
    started = time.monotonic()
    try:
        request = json.loads(line)
        request_id = require_string(request, "request_id")
        encoded_audio = require_string(request, "audio_wav_base64")
        audio = decode_pcm16_mono_wav(encoded_audio)
        input_features = prepare_fixed_features(processor, audio).to(
            device=device,
            dtype=torch.bfloat16,
        )

        with torch.inference_mode():
            token_ids = model.generate(
                input_features,
                max_new_tokens=128,
                num_beams=1,
                do_sample=False,
            )
        text = processor.batch_decode(
            token_ids.cpu(),
            skip_special_tokens=True,
        )[0].strip()
        emit(
            {
                "request_id": request_id,
                "ok": True,
                "text": text,
                "model": MODEL_ID,
                "model_revision": MODEL_REVISION,
                "segments": [],
                "words": [],
                "device": str(device),
                "duration_ms": elapsed_ms(started),
            }
        )
    except Exception as error:  # Protocol boundary owns error serialization.
        log(
            "buzzasr.worker.request_failed",
            request_id=request_id,
            error_type=type(error).__name__,
            error=str(error)[:500],
        )
        emit(
            {
                "request_id": request_id,
                "ok": False,
                "error": f"{type(error).__name__}: {str(error)[:500]}",
                "duration_ms": elapsed_ms(started),
            }
        )


def decode_pcm16_mono_wav(encoded_audio: str) -> np.ndarray:
    try:
        raw = base64.b64decode(encoded_audio, validate=True)
    except ValueError as error:
        raise ValueError("audio_wav_base64 is not valid base64") from error

    if not raw or len(raw) > MAX_WAV_BYTES:
        raise ValueError("WAV must contain 1 to 10485760 bytes")

    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as error:
        raise ValueError("audio must be a valid PCM WAV file") from error

    if channels != 1 or sample_width != 2 or sample_rate != REQUIRED_SAMPLE_RATE:
        raise ValueError("audio must be mono, PCM16, and 16000 Hz")

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if samples.size == 0:
        raise ValueError("audio contains no samples")

    return fit_fixed_audio_window(samples)


def fit_fixed_audio_window(samples: np.ndarray) -> np.ndarray:
    target_samples = REQUIRED_SAMPLE_RATE * FIXED_AUDIO_SECONDS
    fixed = np.zeros(target_samples, dtype=np.float32)
    copied_samples = min(samples.size, target_samples)
    fixed[:copied_samples] = samples[:copied_samples]
    return fixed


def prepare_fixed_features(
    processor: WhisperProcessor,
    audio: np.ndarray,
) -> torch.Tensor:
    return processor(
        audio,
        sampling_rate=REQUIRED_SAMPLE_RATE,
        return_tensors="pt",
    ).input_features


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, dict) or not isinstance(value.get(field), str):
        raise ValueError(f"{field} must be a string")
    return value[field]


def emit(message: dict[str, Any]) -> None:
    print(json.dumps(message, separators=(",", ":")), flush=True)


def log(event: str, **details: Any) -> None:
    record = {"event": event, **details}
    print(json.dumps(record, separators=(",", ":")), file=sys.stderr, flush=True)


def elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


if __name__ == "__main__":
    main()
