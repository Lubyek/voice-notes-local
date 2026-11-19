"""Local speech recognition adapter. Audio lives in memory."""
import logging
from threading import Thread

SAMPLE_RATE = 16_000


class WhisperRecognizer:
    provider = "whisper"

    def __init__(self, model_name):
        self.model_name = model_name
        self.state = "loading"
        self.error = None
        Thread(target=self._load, name="whisper-setup", daemon=True).start()

    def _load(self):
        try:
            from faster_whisper import WhisperModel

            self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
        except ImportError:
            logging.exception("Could not import faster-whisper")
            self.error = "Установи faster-whisper командой из README."
            self.state = "error"
        except Exception:
            logging.exception("Could not load Whisper model %s", self.model_name)
            self.error = "Не удалось загрузить модель. Проверь интернет при первом запуске и перезапусти сервер."
            self.state = "error"
        else:
            self.state = "ready"

    def transcribe(self, pcm, language):
        import numpy as np

        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        segments, _ = self.model.transcribe(
            samples,
            language=None if language == "multi" else language,
            beam_size=3,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 450},
        )
        return [(segment.start, segment.end, segment.text.strip()) for segment in segments]
