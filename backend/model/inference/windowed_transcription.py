"""Duration-preserving ASR windows with deterministic overlap ownership."""

from __future__ import annotations

from typing import Any


def transcribe_audio_windows(
    transcriber: Any,
    audio: Any,
    sample_rate: int = 16_000,
) -> dict[str, Any]:
    window_samples = sample_rate * 30
    step_samples = sample_rate * 25
    duration = len(audio) / sample_rate
    chunks: list[dict[str, Any]] = []
    texts: list[str] = []
    for start in range(0, len(audio), step_samples):
        end = min(start + window_samples, len(audio))
        raw = transcriber(
            audio[start:end],
            return_timestamps="word",
            generate_kwargs={"max_new_tokens": 256, "num_beams": 1, "do_sample": False},
        )
        offset = start / sample_rate
        lower = 0.0 if start == 0 else offset + 2.5
        upper = duration if end == len(audio) else offset + 27.5
        window_chunks = raw.get("chunks", [])
        if not window_chunks and str(raw.get("text", "")).strip():
            raise ValueError("word timestamps are required for full-session inference")
        for chunk in window_chunks:
            timestamp = chunk.get("timestamp")
            if not timestamp or len(timestamp) != 2 or timestamp[0] is None or timestamp[1] is None:
                raise ValueError("ASR returned incomplete word timestamps")
            begin, finish = (float(timestamp[0]) + offset, float(timestamp[1]) + offset)
            midpoint = (begin + finish) / 2
            if lower <= midpoint < upper and 0 <= begin < finish <= duration:
                text = str(chunk.get("text", "")).strip()
                if text:
                    chunks.append({"text": text, "timestamp": (begin, finish)})
                    texts.append(text)
        if end == len(audio):
            break
    return {"text": " ".join(texts), "chunks": chunks}
