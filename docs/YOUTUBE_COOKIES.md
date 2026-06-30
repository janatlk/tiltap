# YouTube on Hetzner — Fixing "Sign in to confirm"

YouTube aggressively blocks datacenter IPs (including Hetzner). If every link returns **"Sign in to confirm you’re not a bot"**, the only free fix is to feed `yt-dlp` fresh browser credentials.

## What you need

1. `YOUTUBE_COOKIES_BASE64` — Netscape-format cookies from a logged-in YouTube session.
2. `YOUTUBE_PO_TOKEN` — Proof-of-Origin token from the same browser session.
3. `YOUTUBE_VISITOR_DATA` — YouTube visitor data string from the same session.

## Option A — Automatic (recommended if you have Chrome/Firefox)

1. Install the browser extension **"Get cookies.txt LOCALLY"**.
2. Open https://www.youtube.com and make sure you are **logged in**.
3. Click the extension → **Export cookies for YouTube** → choose **Netscape format**.
4. Save the file as `youtube_cookies.txt`.
5. On your local machine run:
   ```bash
   base64 -w 0 youtube_cookies.txt
   ```
6. Copy the output and set it in `/opt/tiltap/.env`:
   ```env
   YOUTUBE_COOKIES_BASE64=<paste here>
   ```
7. Restart the backend:
   ```bash
   systemctl restart tiltab-backend.service
   ```

## Option B — Manual DevTools extraction

1. Open https://www.youtube.com in a browser where you are logged in.
2. Open DevTools → **Network** tab.
3. Refresh the page and click any video.
4. Find a request to `https://www.youtube.com/youtubei/v1/player`.
5. In the **request payload** look for:
   - `serviceIntegrityDimensions.poToken`
   - `context.client.visitorData`
6. Copy both values to `/opt/tiltap/.env`:
   ```env
   YOUTUBE_PO_TOKEN=<poToken>
   YOUTUBE_VISITOR_DATA=<visitorData>
   ```
7. Also add cookies as described in Option A.
8. Restart backend.

## How to test

```bash
cd /opt/tiltap
python3 validate_youtube.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

Expected:
```json
{"ok": true, "title": "...", "duration": 123}
```

## Important caveats

- Cookies and PO tokens **expire**. You will need to refresh them periodically.
- Do **not** share your YouTube cookies publicly — they grant access to your Google account on YouTube.
- If cookies still do not help, the Hetzner IP may be hard-flagged. The next step is a cheap residential proxy or running `yt-dlp` on a non-datacenter machine.

## Paid fallback

If the free cookie method stops working reliably, the cheapest paid option is a **residential SOCKS5/HTTP proxy** (~$5–$15/month). Set it in `.env`:

```env
YOUTUBE_PROXY=http://user:pass@host:port
```
