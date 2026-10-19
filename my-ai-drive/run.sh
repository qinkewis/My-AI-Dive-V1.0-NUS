#!/bin/bash
# Starts My AI Drive at http://127.0.0.1:8765 and opens it in your browser.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
fi
PORT="${PORT:-8765}"
(sleep 1.5 && open "http://127.0.0.1:$PORT") &
exec .venv/bin/uvicorn server.main:app --host 127.0.0.1 --port "$PORT"
