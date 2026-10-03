# Model

Owns the BuzzASR boundary. `modal/` is the primary private single-job T4 path. `experiments/colab/` remains the manual fallback. `inference/` owns pinned Python model loading and inference, `api/` is an optional local gateway experiment, and `deployment/aws/` contains only the AWS GPU deferral notice.

The model emits transcription evidence with timestamps. It does not issue pronunciation judgments.

## Private Modal path

1. Authenticate the Modal CLI without storing its account token in the repository.
2. Run `npm run modal:deploy`; record the private endpoint URL from the bounded result.
3. Create an environment-scoped Proxy Token in Modal.
4. Put the endpoint, token ID, and token secret only in the Rust server secret file and set `COACH_MODAL_ENABLED=true`.
5. An authenticated annotator may run exactly one pending job. Rust owns the claim, request, response validation, import, and explicit retry boundary.

## Colab fallback

1. Mag-login bilang `annotator`, pumili ng isang pending job, at pindutin ang `Colab POC` para gumawa ng two-hour, job-scoped ticket.
2. Buksan ang `experiments/colab/buzzasr_colab_gpu.ipynb`, pumili ng GPU runtime, at patakbuhin ang cells manually.
3. Piliin ang `direct`, ilagay ang HTTPS Rust API base URL, eksaktong job ID, at ticket sa hidden prompt.
4. Hayaang matapos ang isang export, inference, at import; pagkatapos ay i-disconnect at i-delete ang runtime.

Walang Google password, application password, cookie, Agora secret, o AWS credential na inilalagay sa notebook. Kapag may failure, ayusin muna ang sanhi bago manual na ulitin ang kasalukuyang step; walang automatic retry.
