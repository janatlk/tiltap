#!/usr/bin/sh
# Production startup script.

set -e

echo "[startup] Starting Tiltab server..."
exec node dist/server.js
