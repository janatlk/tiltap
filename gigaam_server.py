#!/usr/bin/env python3
"""Persistent local STT worker that keeps GigaAM resident in memory.

The CLI path (transcribe_hybrid.py) is spawned fresh per request, so GigaAM
reloads (~2.8s) every time. This long-running worker loads the model once and
reuses it, removing that per-request cost. The Node backend calls it for the
GigaAM languages (ky/uz/ru) and transparently falls back to spawning
transcribe_hybrid.py if this worker is unreachable or errors.

Protocol:
  GET  /health              -> {"status":"ok","warm":bool}
  POST /transcribe  JSON:
        {"input_path": "...", "ffmpeg_path": "...", "language": "ky|uz|ru|..."}
    -> 200 {"text","language","segments",...}   (same schema as the CLI)
    -> 4xx/5xx {"error": "..."}

The backend and this worker run on the same host, so audio is passed by file
path (the backend already writes a temp file) rather than over the wire.
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8")

# Use the on-disk HuggingFace cache that already holds GigaAM so the worker
# never has to hit the network. Overridable via the environment.
os.environ.setdefault("HF_HOME", "/opt/tiltap/models/hf_cache")

import transcribe_hybrid as th  # noqa: E402  (after HF_HOME is set)

# GigaAM inference is CPU-bound and already uses all cores. Serialize requests so
# two concurrent transcriptions don't thrash the CPU against each other — this
# mirrors the backend's existing one-at-a-time remote-STT policy.
_lock = threading.Lock()
_state = {"warm": False}


def _warm_up():
    """Load GigaAM once at startup so the first real request is fast."""
    try:
        th.get_gigaam_model()
        _state["warm"] = True
        print("[gigaam-server] GigaAM loaded and resident", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[gigaam-server] warmup failed (will retry on first request): {e}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok", "warm": _state["warm"]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._send(400, {"error": f"bad request: {e}"})
            return

        input_path = req.get("input_path")
        ffmpeg_path = req.get("ffmpeg_path")
        language = req.get("language")
        if not input_path or not ffmpeg_path:
            self._send(400, {"error": "input_path and ffmpeg_path are required"})
            return
        if not os.path.exists(input_path):
            self._send(400, {"error": f"input_path does not exist: {input_path}"})
            return

        lang = language if (language and language != "auto") else None
        try:
            with _lock:
                output = th.run_transcription(input_path, ffmpeg_path, lang)
            _state["warm"] = True
            self._send(200, output)
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e)[:500]})

    def log_message(self, *args):
        # Silence the default per-request stderr logging; the backend logs calls.
        pass


def main():
    host = os.environ.get("GIGAAM_SERVER_HOST", "127.0.0.1")
    port = int(os.environ.get("GIGAAM_SERVER_PORT", "8010"))
    threading.Thread(target=_warm_up, daemon=True).start()
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[gigaam-server] listening on {host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
