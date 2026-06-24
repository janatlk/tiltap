#!/usr/bin/sh
# Render production startup script.
# Optionally updates yt-dlp to the latest release before launching Node,
# so YouTube downloads are not blocked by an outdated extractor.

set -e

if [ "${YOUTUBE_AUTO_UPDATE_YTDLP:-false}" = "true" ] || [ "${YOUTUBE_AUTO_UPDATE_YTDLP:-0}" = "1" ]; then
  echo "[startup] Updating yt-dlp to the latest version..."
  python3 -m pip install --break-system-packages --no-cache-dir --upgrade "yt-dlp[default]" || true
  echo "[startup] yt-dlp version: $(python3 -c 'import yt_dlp; print(yt_dlp.version.__version__)')"
fi

echo "[startup] Starting Tiltab server..."
exec node dist/server.js
