#!/usr/bin/env python3
"""Serve the browser app and its loopback-only JSON / PCM API."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
from threading import Event, Thread
from urllib.parse import parse_qs, urlsplit

from recognizer import MODEL, MODELS, AssemblyAIRecognizer
from recordings import History, MAX_PACKET, Recordings, RequestError

ROOT = Path(__file__).resolve().parent
LANGUAGES = {"ru", "en", "uk", "fr", "de", "es", "it", "pt", "pl", "tr", "zh", "ja", "multi"}
STATIC = {
    "/": ("docs/index.html", "text/html"),
    "/transport.js": ("server-api.js", "text/javascript"),
    "/models.json": ("docs/models.json", "application/json"),
    "/app.js": ("docs/app.js", "text/javascript"),
    "/capture.js": ("docs/capture.js", "text/javascript"),
    "/style.css": ("docs/style.css", "text/css"),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.handle_route("GET")

    def do_POST(self):
        self.handle_route("POST")

    def handle_route(self, method):
        try:
            self.connection.settimeout(5)
            port = self.server.server_port
            allowed_hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}
            if self.headers.get("Host") not in allowed_hosts:
                raise RequestError(403, "Открой сайт через localhost.")
            origin = self.headers.get("Origin")
            if origin and origin not in {f"http://{host}" for host in allowed_hosts}:
                raise RequestError(403, "Запрос с внешнего сайта отклонён.")
            if method == "POST" and self.headers.get("X-Voice-Notes") != "1":
                raise RequestError(403, "Запрос на запись отклонён.")
            target = urlsplit(self.path)
            path = target.path
            if method == "GET" and path in STATIC:
                filename, content_type = STATIC[path]
                self.respond(200, (ROOT / filename).read_bytes(), content_type + "; charset=utf-8")
                return
            if method == "GET" and path == "/favicon.ico":
                self.respond(204, b"", "text/plain")
                return
            self.json_response(200, self.route_api(method, path, target.query))
        except RequestError as exc:
            self.json_response(exc.status, {"error": str(exc)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except Exception:
            logging.exception("Request failed")
            self.json_response(500, {"error": "Ошибка сервера. Подробности в терминале."})

    def route_api(self, method, path, query):
        recordings = self.server.recordings
        if method == "GET" and path == "/api/v1/state":
            return recordings.state()
        if method == "POST" and path == "/api/v1/recordings/clear":
            return recordings.clear_history()
        if path == "/api/v1/recordings":
            if method == "GET":
                term = " ".join(parse_qs(query).get("q", [""])[0][:200].split()).casefold()
                return {"items": recordings.history.read(query=term)}
            body = self.read_json()
            model = body.get("model", MODEL)
            if not isinstance(model, str) or model not in MODELS:
                raise RequestError(400, "Выбери модель из списка.")
            return recordings.start("browser", self.language(body), model)
        match = re.fullmatch(
            r"/api/v1/recordings/([a-f0-9]{32})(?:/(stop|audio/([0-9]{1,8})))?",
            path,
        )
        if match:
            recording_id, action, sequence = match.groups()
            if method == "GET" and action is None:
                return recordings.get(recording_id)
            if method == "POST" and action == "stop":
                interrupted = self.read_json().get("interrupted") is True
                return recordings.finish(
                    recording_id, "browser", interrupted,
                    "Запись в браузере прервалась." if interrupted else None,
                )
            if method == "POST" and sequence is not None:
                pcm = self.read_body(MAX_PACKET)
                return {"status": recordings.append(recording_id, pcm, "browser", int(sequence))}
        raise RequestError(404, "Страница не найдена.")

    def read_body(self, limit):
        size = self.headers.get("Content-Length", "")
        if not size.isdigit() or len(size) > 8 or not 0 < int(size) <= limit:
            raise RequestError(400, "Недопустимый размер запроса.")
        body = self.rfile.read(int(size))
        if len(body) != int(size):
            raise RequestError(400, "Тело запроса получено не полностью.")
        return body

    def read_json(self):
        try:
            payload = json.loads(self.read_body(2048))
        except (ValueError, UnicodeError) as exc:
            raise RequestError(400, "Ожидается JSON.") from exc
        if not isinstance(payload, dict):
            raise RequestError(400, "Ожидается объект JSON.")
        return payload

    @staticmethod
    def language(payload):
        language = payload.get("language", "multi")
        if not isinstance(language, str) or language not in LANGUAGES:
            raise RequestError(400, "Выбери поддерживаемый язык записи.")
        return language

    def json_response(self, status, value):
        self.respond(status, json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def respond(self, status, data, mime):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Permissions-Policy", "microphone=(self), camera=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def log_message(self, format_string, *args):
        if not self.path.startswith("/api/"):
            super().log_message(format_string, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=ROOT / "data" / "history.sqlite3")
    options = parser.parse_args()

    key = os.environ.get("PROXYAPI_API_KEY", "").strip()
    if not key and (credential_dir := os.environ.get("CREDENTIALS_DIRECTORY")):
        credential = Path(credential_dir) / "proxyapi.key"
        if credential.is_file():
            key = credential.read_text().strip()

    with ThreadingHTTPServer(("127.0.0.1", options.port), Handler) as server:
        server.recordings = Recordings(History(options.db), AssemblyAIRecognizer(key))
        stopping = Event()

        def expire_disconnected_browser():
            while not stopping.wait(1):
                server.recordings.expire_browser()

        watchdog = Thread(target=expire_disconnected_browser, daemon=True)
        watchdog.start()
        print(f"Голосовые заметки · http://localhost:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            stopping.set()
            watchdog.join()
            server.recordings.close()


if __name__ == "__main__":
    main()
