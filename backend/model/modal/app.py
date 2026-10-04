"""Private, single-job BuzzASR endpoint for the GabayBigkas Modal POC."""

from __future__ import annotations

import base64
import hashlib
import json
import time
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

import modal

APP_NAME = "gabaybigkas-buzzasr"
MODEL_ID = "BuzzASR/filipino"
MODEL_REVISION = "fb8cf0d93e2437f8d639549c67733ca9db10e055"
MODEL_CACHE_PATH = "/models"
MAX_BUNDLE_BYTES = 14 * 1024 * 1024
MAX_AUDIO_BYTES = 10 * 1024 * 1024
WORKER_PATH = Path(__file__).resolve().parents[1] / "inference" / "buzzasr_gpu_worker.py"
WINDOWS_PATH = WORKER_PATH.with_name("windowed_transcription.py")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install(
        "accelerate==1.10.1",
        "fastapi[standard]==0.118.0",
        "numpy==2.2.6",
        "safetensors==0.6.2",
        "torch==2.8.0",
        "transformers==4.57.1",
    )
    .env(
        {
            "BUZZASR_MODEL_ID": MODEL_ID,
            "BUZZASR_MODEL_REVISION": MODEL_REVISION,
            "HF_HOME": MODEL_CACHE_PATH,
        }
    )
    .add_local_file(WORKER_PATH, "/root/buzzasr_gpu_worker.py")
    .add_local_file(WINDOWS_PATH, "/root/windowed_transcription.py")
)
model_volume = modal.Volume.from_name("gabaybigkas-buzzasr-models", create_if_missing=True)
app = modal.App(APP_NAME)


@app.cls(
    image=image,
    gpu="T4",
    max_containers=1,
    scaledown_window=300,
    timeout=600,
    volumes={MODEL_CACHE_PATH: model_volume},
)
class BuzzAsrEndpoint:
    @modal.enter()
    def load_model(self) -> None:
        import torch
        from transformers import (
            AutomaticSpeechRecognitionPipeline,
            WhisperForConditionalGeneration,
            WhisperProcessor,
        )

        from buzzasr_gpu_worker import prove_cuda_execution, require_cuda_device

        self.device = require_cuda_device()
        processor = WhisperProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
        model = WhisperForConditionalGeneration.from_pretrained(
            MODEL_ID,
            revision=MODEL_REVISION,
            dtype=torch.float16,
            low_cpu_mem_usage=True,
        ).to(self.device).eval()
        self.transcriber = AutomaticSpeechRecognitionPipeline(
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            device=self.device,
            torch_dtype=torch.float16,
        )
        prove_cuda_execution(self.device)
        model_volume.commit()
        print(json.dumps({"event": "modal.model.ready", "model": MODEL_ID, "gpu": "T4"}))

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True, docs=False)
    def infer(self, payload: dict[str, Any]) -> dict[str, Any]:
        from fastapi import HTTPException

        try:
            manifest, audio = decode_bundle(payload)
            result = transcribe_bundle(self.transcriber, self.device, manifest, audio)
            print(json.dumps({"event": "modal.inference.completed", "job_id": manifest["job_id"]}))
            return result
        except ValueError as error:
            print(json.dumps({"event": "modal.inference.rejected", "reason": str(error)[:200]}))
            raise HTTPException(status_code=400, detail=str(error)) from error


def decode_bundle(payload: dict[str, Any]) -> tuple[dict[str, Any], bytes]:
    encoded = payload.get("bundle_zip_base64")
    if not isinstance(encoded, str) or len(encoded) > MAX_BUNDLE_BYTES * 2:
        raise ValueError("bundle_zip_base64 is missing or oversized")
    try:
        bundle = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ValueError("bundle_zip_base64 is invalid") from error
    if not bundle or len(bundle) > MAX_BUNDLE_BYTES:
        raise ValueError("decoded bundle is empty or oversized")
    try:
        with zipfile.ZipFile(BytesIO(bundle)) as archive:
            if set(archive.namelist()) != {"manifest.json", "audio.wav"}:
                raise ValueError("bundle entries do not match the contract")
            manifest_info = archive.getinfo("manifest.json")
            audio_info = archive.getinfo("audio.wav")
            if manifest_info.file_size > 16_384 or audio_info.file_size > MAX_AUDIO_BYTES:
                raise ValueError("bundle entry exceeds its size limit")
            manifest = json.loads(archive.read(manifest_info))
            audio = archive.read(audio_info)
    except (zipfile.BadZipFile, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("bundle is not a valid inference archive") from error
    validate_manifest(manifest, audio)
    return manifest, audio


def validate_manifest(manifest: dict[str, Any], audio: bytes) -> None:
    current = int(time.time())
    required = {
        "schema_version",
        "job_id",
        "audio_sha256",
        "sample_rate",
        "channels",
        "model_id",
        "model_revision",
        "created_at",
        "expires_at",
    }
    if not isinstance(manifest, dict) or set(manifest) != required:
        raise ValueError("manifest fields do not match the contract")
    if manifest["schema_version"] != 1 or manifest["sample_rate"] != 16_000 or manifest["channels"] != 1:
        raise ValueError("manifest audio contract is unsupported")
    if manifest["model_id"] != MODEL_ID or manifest["model_revision"] != MODEL_REVISION:
        raise ValueError("manifest model identity is unsupported")
    if not isinstance(manifest["job_id"], str) or len(manifest["job_id"]) > 128:
        raise ValueError("manifest job_id is invalid")
    if manifest["expires_at"] <= current or manifest["created_at"] > current + 300:
        raise ValueError("manifest timestamp is invalid or expired")
    if hashlib.sha256(audio).hexdigest() != manifest["audio_sha256"]:
        raise ValueError("audio hash does not match the manifest")


def transcribe_bundle(
    transcriber: Any,
    device: Any,
    manifest: dict[str, Any],
    audio_wav: bytes,
) -> dict[str, Any]:
    import torch

    from buzzasr_gpu_worker import decode_wav, sentence_span, timed_words
    from windowed_transcription import transcribe_audio_windows

    encoded_audio = base64.b64encode(audio_wav).decode("ascii")
    audio = decode_wav(encoded_audio)
    with torch.inference_mode():
        raw = transcribe_audio_windows(transcriber, audio)
    torch.cuda.synchronize(device)
    text = str(raw.get("text", "")).strip()
    words = timed_words(raw.get("chunks", []))
    return {
        "schema_version": 1,
        "job_id": manifest["job_id"],
        "audio_sha256": manifest["audio_sha256"],
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "generated_at": int(time.time()),
        "text": text,
        "segments": sentence_span(text, words),
        "words": words,
    }
