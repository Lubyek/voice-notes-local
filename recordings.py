"""Recording session lifecycle and persistent transcript history."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import sqlite3
from threading import RLock
from time import monotonic
from uuid import uuid4

from recognizer import MODEL, SAMPLE_RATE, RecognitionError

BYTES_PER_SECOND = SAMPLE_RATE * 2
MAX_SECONDS = 15 * 60
MAX_PACKET = BYTES_PER_SECOND
BROWSER_TIMEOUT = 18


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def transcript_text(segments, status):
    text = " ".join(word for part in segments for word in part["text"].split())
    if status == "saved" and text and text[-1].isalnum():
        text += "."
    return text


class History:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""
                CREATE TABLE IF NOT EXISTS recordings (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    source TEXT NOT NULL,
                    language TEXT NOT NULL,
                    status TEXT NOT NULL,
                    duration REAL NOT NULL,
                    segments TEXT NOT NULL,
                    error TEXT
                )
            """)
            db.execute("DELETE FROM recordings WHERE status IN ('recording', 'processing') AND segments = '[]'")
            db.execute("""
                UPDATE recordings SET status = 'interrupted', error = ?
                WHERE status IN ('recording', 'processing')
            """, ("Приложение закрылось. Успевшие обработаться фрагменты сохранены.",))

    def connect(self):
        return closing(sqlite3.connect(self.path))

    def save(self, session):
        with self.connect() as db, db:
            db.execute("""
                INSERT INTO recordings VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status=excluded.status, duration=excluded.duration,
                    segments=excluded.segments, error=excluded.error
            """, (
                session.id, session.created_at, session.source, session.language,
                session.status, session.duration, json.dumps(session.segments, ensure_ascii=False), session.error,
            ))

    def read(self, recording_id=None, query=""):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            if recording_id is not None:
                row = db.execute("SELECT * FROM recordings WHERE id=?", (recording_id,)).fetchone()
                return self.decode(row) if row else None
            rows = db.execute(
                "SELECT * FROM recordings WHERE segments != '[]' ORDER BY created_at DESC"
            )
            matches = []
            for row in rows:
                entry = self.decode(row)
                text = entry.pop("text")
                del entry["segments"]
                if text and query in text.casefold():
                    matches.append(entry)
            return matches

    @staticmethod
    def decode(row):
        entry = dict(row)
        entry["segments"] = json.loads(entry["segments"])
        entry["text"] = transcript_text(entry["segments"], entry["status"])
        entry["preview"] = entry["text"][:150]
        return entry


@dataclass
class Session:
    source: str
    language: str
    id: str = field(default_factory=lambda: uuid4().hex)
    created_at: str = field(default_factory=now)
    status: str = "recording"
    segments: list = field(default_factory=list)
    error: str | None = None
    captured_bytes: int = 0
    next_sequence: int = 0
    last_packet: float = field(default_factory=monotonic)
    pending: bytearray = field(default_factory=bytearray)

    @property
    def duration(self):
        return round(self.captured_bytes / BYTES_PER_SECOND, 3)

    def snapshot(self):
        return {
            "id": self.id, "created_at": self.created_at, "source": self.source,
            "language": self.language, "status": self.status, "duration": self.duration,
            "segments": list(self.segments), "text": transcript_text(self.segments, self.status),
            "error": self.error,
        }


class Recordings:
    def __init__(self, history, recognizer):
        self.history = history
        self.recognizer = recognizer
        self.lock = RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="transcription")
        self.active = None
        self.last = None

    def start(self, source, language):
        with self.lock:
            if self.active:
                raise RequestError(409, "Другая запись ещё идёт или обрабатывается.")
            recognizer = self.recognizer
            if recognizer.state != "ready":
                raise RequestError(503, recognizer.error or "Модель ещё загружается.")
            self.active = Session(source, language)
            return self.active.snapshot()

    def state(self):
        with self.lock:
            return {
                "active": self.active.snapshot() if self.active else None,
                "last": self.last.snapshot() if self.last else None,
                "model": {"state": self.recognizer.state, "error": self.recognizer.error, "provider": MODEL},
            }

    def get(self, recording_id):
        with self.lock:
            for session in (self.active, self.last):
                if session and session.id == recording_id:
                    return session.snapshot()
            entry = self.history.read(recording_id)
            if entry is None:
                raise RequestError(404, "Запись не найдена.")
            return entry

    def append(self, recording_id, pcm, source, sequence):
        if not pcm or len(pcm) % 2 or len(pcm) > MAX_PACKET:
            raise RequestError(400, "Ожидается до одной секунды моно PCM16 с частотой 16 кГц.")
        with self.lock:
            session = self.active
            if not session or session.id != recording_id or session.source != source:
                raise RequestError(409, "Эта запись уже закрыта.")
            if sequence < session.next_sequence:
                return session.status
            if session.status != "recording":
                raise RequestError(409, "Эта запись уже останавливается.")
            if sequence != session.next_sequence:
                raise RequestError(409, "Пропущен аудиофрагмент.")
            session.next_sequence += 1
            session.last_packet = monotonic()
            limit = MAX_SECONDS * BYTES_PER_SECOND
            pcm = pcm[:limit - session.captured_bytes]
            session.captured_bytes += len(pcm)
            session.pending.extend(pcm)
            if session.captured_bytes >= limit:
                self.finish(recording_id, source)
            return session.status

    def _recognize(self, session, pcm):
        try:
            text = self.recognizer.transcribe(pcm, session.language)
        except RecognitionError as error:
            with self.lock:
                session.error = str(error)
            return
        with self.lock:
            if text:
                session.segments.append({"start": 0, "end": session.duration, "text": text})

    def finish(self, recording_id, source, interrupted=False, message=None):
        with self.lock:
            session = self.active
            if not session or session.id != recording_id or session.source != source:
                if self.last and self.last.id == recording_id and self.last.source == source:
                    return self.last.snapshot()
                raise RequestError(404, "Активная запись не найдена.")
            if session.status == "recording":
                session.status = "processing"
                if message:
                    session.error = message
                if not interrupted and len(session.pending) >= BYTES_PER_SECOND // 8:
                    self.worker.submit(self._recognize, session, bytes(session.pending))
                session.pending.clear()
                self.worker.submit(self._finalize, session, interrupted)
            return session.snapshot()

    def _finalize(self, session, interrupted):
        with self.lock:
            if session.error or interrupted:
                session.status = "interrupted"
            else:
                session.status = "saved" if session.segments else "empty"
            if session.segments:
                try:
                    self.history.save(session)
                except (OSError, sqlite3.Error):
                    logging.exception("Could not save final transcript")
                    session.status = "interrupted"
                    session.error = "Не удалось сохранить текст на диск."
            self.last = session
            self.active = None

    def expire_browser(self):
        with self.lock:
            session = self.active
            if session and session.status == "recording" and monotonic() - session.last_packet > BROWSER_TIMEOUT:
                self.finish(session.id, session.source, True, "Браузер отключился до завершения записи.")

    def close(self):
        with self.lock:
            if self.active:
                self.finish(self.active.id, self.active.source, True, "Сервер остановлен.")
        self.worker.shutdown()
