# Model

Owns the BuzzASR boundary. `experiments/colab/` is the canonical interactive MVP GPU path, `inference/` owns only pinned Python model loading and inference, and `api/` remains an optional local gateway experiment. `deployment/aws/` contains only the AWS GPU deferral notice.

The model emits transcription evidence with timestamps. It does not issue pronunciation judgments.
