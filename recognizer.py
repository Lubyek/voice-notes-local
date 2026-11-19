"""AssemblyAI Universal-3.6 Pro through ProxyAPI."""
from http.client import HTTPSConnection, HTTPException
from io import BytesIO
import json
from pathlib import Path
from uuid import uuid4
import wave

SAMPLE_RATE = 16_000
MODELS = dict(json.loads((Path(__file__).resolve().parent / "docs" / "models.json").read_text(encoding="utf-8")))
MODEL = next(iter(MODELS))


class RecognitionError(Exception):
    pass


class AssemblyAIRecognizer:
    def __init__(self, key):
        self.key = key
        self.state = "ready" if key else "error"
        self.error = None if key else "Укажи PROXYAPI_API_KEY в окружении сервера."

    def transcribe(self, pcm, language, model=MODEL):
        audio = BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            wav.writeframes(pcm)
        boundary = uuid4().hex
        fields = {"model": model}
        if language != "multi":
            fields["language"] = language
        body = BytesIO()
        for name, value in fields.items():
            body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        body.write(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\n'
            'Content-Type: audio/wav\r\n\r\n'.encode()
        )
        body.write(audio.getbuffer())
        body.write(f"\r\n--{boundary}--\r\n".encode())
        conn = HTTPSConnection("api.proxyapi.ru", timeout=120)
        try:
            conn.request("POST", "/v1/audio/transcriptions", body=body.getbuffer(), headers={
                "Authorization": "Bearer " + self.key,
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            })
            response = conn.getresponse()
            if response.status != 200:
                raise RecognitionError(f"ProxyAPI вернул ошибку HTTP {response.status}.")
            payload = json.loads(response.read())
            text = payload.get("text") if isinstance(payload, dict) else None
            if not isinstance(text, str):
                raise RecognitionError("ProxyAPI вернул ответ без текста.")
            return text.strip()
        except (OSError, HTTPException, ValueError) as exc:
            raise RecognitionError("Не удалось получить ответ от ProxyAPI.") from exc
        finally:
            conn.close()
