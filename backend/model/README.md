# Model

Owns the BuzzASR boundary. `modal/` is the private single-job T4 path. `experiments/colab/` is deprecated and not connected to the runtime. `inference/` owns pinned Python model loading and inference, `api/` is an optional local gateway experiment, and `deployment/aws/` contains only the AWS GPU deferral notice.

The model emits transcription evidence with timestamps. It does not issue pronunciation judgments.

## Private Modal path

1. Authenticate the Modal CLI without storing its account token in the repository.
2. Run `npm run modal:deploy`; record the private endpoint URL from the bounded result.
3. Create an environment-scoped Proxy Token in Modal.
4. Put the endpoint, token ID, and token secret only in the Rust server secret file and set `COACH_MODAL_ENABLED=true`.
5. Session finalization starts exactly one background job. Rust owns the claim, request, response validation, import, terminal failure state, and cleanup boundary.

## Deprecated experiment

Ang `experiments/colab/` notebook ay historical reference lamang. Wala itong product route, ticket flow, import control, o fallback role.
