import importlib.util
from pathlib import Path
import unittest

MODULE = Path(__file__).resolve().parents[2] / "backend/model/inference/windowed_transcription.py"
SPEC = importlib.util.spec_from_file_location("windowed_transcription", MODULE)
WINDOWS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WINDOWS)


class WindowedTranscriptionTests(unittest.TestCase):
    def test_full_audio_and_overlap_are_processed_once(self):
        lengths = []

        def transcriber(audio, **_options):
            offset = len(lengths) * 25
            lengths.append(len(audio))
            words = [
                {"text": f"word-{second + offset}", "timestamp": (second, second + 0.5)}
                for second in range(len(audio))
            ]
            return {"chunks": words}

        result = WINDOWS.transcribe_audio_windows(transcriber, [0] * 61, sample_rate=1)
        self.assertEqual(lengths, [30, 30, 11])
        self.assertEqual(len(result["chunks"]), 61)
        self.assertEqual(len(set(result["text"].split())), 61)
        self.assertEqual(result["chunks"][-1]["timestamp"], (60.0, 60.5))

    def test_missing_timestamps_fail_instead_of_silently_losing_audio(self):
        with self.assertRaises(ValueError):
            WINDOWS.transcribe_audio_windows(lambda *_a, **_k: {"text": "hello"}, [0] * 5, 1)

    def test_short_audio_is_not_padded_into_fake_timestamps(self):
        result = WINDOWS.transcribe_audio_windows(
            lambda *_a, **_k: {"chunks": [{"text": "hello", "timestamp": (0, 1)}]}, [0] * 2, 1
        )
        self.assertEqual(result["text"], "hello")


if __name__ == "__main__":
    unittest.main()
