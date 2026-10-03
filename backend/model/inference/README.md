# BuzzASR inference worker

Ang module na ito lang ang Python boundary ng canonical MVP. Ito ang naglo-load ng
`BuzzASR/filipino` at nagpapatakbo ng pinned GPU inference. Rust pa rin ang may-ari
ng orchestration, persistence, validation, comparison, at annotation.

## Canonical runtime

```text
authorized ZIP export
  -> interactive Google Colab Free notebook
     -> pinned Transformers pipeline on an available CUDA GPU
        -> bounded result JSON for validated Rust import
```

- Canonical MVP entry: `../experiments/colab/buzzasr_colab_gpu.ipynb`
- Canonical model revision: `fb8cf0d93e2437f8d639549c67733ca9db10e055`
- Audio contract: mono PCM16 WAV, 16 kHz, hanggang 10 MiB bawat request
- Output contract: text, segments, word timestamps, model ID, at model revision

Ang `buzzasr_gpu_worker.py`, `buzzasr_tpu_worker.py`, at Rust model gateway ay
experimental/local compatibility paths lamang; hindi sila deployed MVP services.

## Environment

```text
BUZZASR_MODEL_ID=BuzzASR/filipino
BUZZASR_MODEL_REVISION=fb8cf0d93e2437f8d639549c67733ca9db10e055
```

Operator-controlled at interactive ang model access, Hugging Face cache, at CUDA
runtime. Hindi backend, public endpoint, tunnel, unattended worker, o remote-control
path ang Colab notebook.
