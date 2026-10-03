# Model

Owns the BuzzASR boundary. `experiments/colab/` is the canonical interactive MVP GPU path with manual ZIP transfer and an optional one-shot HTTPS POC mode. Each manual run processes one job and exits. `inference/` owns only pinned Python model loading and inference, and `api/` remains an optional local gateway experiment. `deployment/aws/` contains only the AWS GPU deferral notice.

The model emits transcription evidence with timestamps. It does not issue pronunciation judgments.

## One-shot HTTPS POC

1. Mag-login bilang `annotator`, pumili ng isang pending job, at pindutin ang `Colab POC` para gumawa ng two-hour, job-scoped ticket.
2. Buksan ang `experiments/colab/buzzasr_colab_gpu.ipynb`, pumili ng GPU runtime, at patakbuhin ang cells manually.
3. Piliin ang `direct`, ilagay ang HTTPS Rust API base URL, eksaktong job ID, at ticket sa hidden prompt.
4. Hayaang matapos ang isang export, inference, at import; pagkatapos ay i-disconnect at i-delete ang runtime.

Walang Google password, application password, cookie, Agora secret, o AWS credential na inilalagay sa notebook. Kapag may failure, ayusin muna ang sanhi bago manual na ulitin ang kasalukuyang step; walang automatic retry.
