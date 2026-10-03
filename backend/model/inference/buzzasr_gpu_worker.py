#!/usr/bin/env python3
"""Persistent BuzzASR CUDA worker with a strict JSON Lines protocol."""

from __future__ import annotations

import base64
import binascii
import json
import os
import sys
import time
import wave
from io import BytesIO
from typing import Any

import numpy as np
import torch
from transformers import (
    AutomaticSpeechRecognitionPipeline,
    WhisperForConditionalGeneration,
    WhisperProcessor,
)

MODEL_ID = os.environ.get("BUZZASR_MODEL_ID", "BuzzASR/filipino")
MODEL_REVISION = os.environ.get("BUZZASR_MODEL_REVISION", "fb8cf0d93e2437f8d639549c67733ca9db10e055")
SAMPLE_RATE = 16_000
INFERENCE_SAMPLES = SAMPLE_RATE * 30
MAX_WAV_BYTES = 10 * 1024 * 1024
MEBIBYTE = 1024 * 1024


def main() -> None:
    device = require_cuda_device()
    gpu_name = torch.cuda.get_device_name(device)
    log("buzzasr.worker.loading", model=MODEL_ID, device=str(device), gpu_name=gpu_name)
    processor = WhisperProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    model = WhisperForConditionalGeneration.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        dtype=torch.float16,
        low_cpu_mem_usage=True,
    ).to(device).eval()
    transcriber = AutomaticSpeechRecognitionPipeline(
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        device=device,
        torch_dtype=torch.float16,
    )
    prove_cuda_execution(device)
    emit(
        {
            "type": "ready",
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "device": str(device),
            "accelerator": "cuda",
            "gpu_name": gpu_name,
        }
    )

    for line in sys.stdin:
        if not line.strip():
            continue
        handle_request(line, transcriber, device, gpu_name)


def handle_request(
    line: str,
    transcriber: AutomaticSpeechRecognitionPipeline,
    device: torch.device,
    gpu_name: str,
) -> None:
    started = time.perf_counter()
    request_id = "unknown"
    try:
        request = json.loads(line)
        request_id = require_string(request, "request_id")
        action = require_string(request, "action")
        if action == "health":
            emit_health(request_id, device, gpu_name, started)
            return
        if action != "transcribe":
            raise ValueError(f"unsupported action: {action}")
        transcribe(request_id, request, transcriber, device, started)
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


def emit_health(
    request_id: str,
    device: torch.device,
    gpu_name: str,
    started: float,
) -> None:
    prove_cuda_execution(device)
    free_bytes, total_bytes = torch.cuda.mem_get_info(device)
    emit(
        {
            "request_id": request_id,
            "ok": True,
            "model_loaded": True,
            "accelerator": "cuda",
            "device": str(device),
            "gpu_name": gpu_name,
            "gpu_memory_free_mb": free_bytes // MEBIBYTE,
            "gpu_memory_total_mb": total_bytes // MEBIBYTE,
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "duration_ms": elapsed_ms(started),
        }
    )


def transcribe(
    request_id: str,
    request: dict[str, Any],
    transcriber: AutomaticSpeechRecognitionPipeline,
    device: torch.device,
    started: float,
) -> None:
    encoded_audio = require_string(request, "audio_wav_base64")
    audio = decode_wav(encoded_audio)
    fixed_audio = fit_inference_window(audio)
    with torch.inference_mode():
        result = transcriber(
            fixed_audio,
            return_timestamps="word",
            generate_kwargs={
                "max_new_tokens": 128,
                "num_beams": 1,
                "do_sample": False,
            },
        )
    text = str(result.get("text", "")).strip()
    words = timed_words(result.get("chunks", []))
    segments = sentence_span(text, words)
    emit(
        {
            "request_id": request_id,
            "ok": True,
            "text": text,
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "device": str(device),
            "duration_ms": elapsed_ms(started),
            "segments": segments,
            "words": words,
        }
    )


def timed_words(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for chunk in chunks:
        timestamp = chunk.get("timestamp")
        if not isinstance(timestamp, (list, tuple)) or len(timestamp) != 2:
            continue
        start, end = timestamp
        if start is None or end is None:
            continue
        words.append(
            {
                "text": str(chunk.get("text", "")).strip(),
                "start_ms": round(float(start) * 1000),
                "end_ms": round(float(end) * 1000),
            }
        )
    return words


def sentence_span(text: str, words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not text or not words:
        return []
    return [
        {
            "text": text,
            "start_ms": words[0]["start_ms"],
            "end_ms": words[-1]["end_ms"],
        }
    ]


def require_cuda_device() -> torch.device:
    if not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA is unavailable; select Runtime > Change runtime type > GPU in Colab"
        )
    device = torch.device("cuda:0")
    prove_cuda_execution(device)
    return device


def prove_cuda_execution(device: torch.device) -> None:
    probe = torch.tensor([20.0, 22.0], device=device).sum()
    if probe.item() != 42.0:
        raise RuntimeError("CUDA computation probe returned an unexpected result")
    torch.cuda.synchronize(device)


def decode_wav(encoded_audio: str) -> np.ndarray:
    try:
        raw = base64.b64decode(encoded_audio, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("audio_wav_base64 is not valid base64") from error
    if len(raw) > MAX_WAV_BYTES:
        raise ValueError("decoded WAV exceeds the 10 MiB limit")

    try:
        with wave.open(BytesIO(raw), "rb") as wav_file:
            if wav_file.getnchannels() != 1:
                raise ValueError("WAV must be mono")
            if wav_file.getsampwidth() != 2:
                raise ValueError("WAV must use signed 16-bit PCM")
            if wav_file.getframerate() != SAMPLE_RATE:
                raise ValueError("WAV sample rate must be 16000 Hz")
            frames = wav_file.readframes(wav_file.getnframes())
    except (wave.Error, EOFError) as error:
        raise ValueError("audio is not a valid PCM WAV") from error
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def fit_inference_window(audio: np.ndarray) -> np.ndarray:
    if audio.size >= INFERENCE_SAMPLES:
        return audio[:INFERENCE_SAMPLES]
    return np.pad(audio, (0, INFERENCE_SAMPLES - audio.size))


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, dict):
        raise ValueError("request must be a JSON object")
    result = value.get(field)
    if not isinstance(result, str) or not result:
        raise ValueError(f"{field} must be a non-empty string")
    return result


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, separators=(",", ":")), flush=True)


def log(event: str, **fields: Any) -> None:
    print(
        json.dumps(
            {"event": event, **fields},
            separators=(",", ":"),
            default=str,
        ),
        file=sys.stderr,
        flush=True,
    )


def elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


if __name__ == "__main__":
    main()
