# Annotator

Owns the private review queue, sentence-context playback, focused mismatch range, and bounded annotation decisions.

The browser submits only `confirmed_transcript`, `corrected_transcript`, `insufficient_evidence`, or `out_of_scope_language`, with bounded correction text and notes where applicable. It does not own inference execution or result import.
