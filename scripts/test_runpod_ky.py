#!/usr/bin/env python3
"""Send a Kyrgyz audio file to the RunPod GPU STT endpoint and print the result."""
import base64
import json
import os
import sys
import time
import urllib.request

# Force UTF-8 stdout on Windows so Kyrgyz text prints correctly.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ENDPOINT_ID = "1ws4etnfly9xv7"
API_KEY = os.environ.get("TILTAB_GPU_STT_API_KEY", "").strip()
if not API_KEY:
    key_path = ".keys/runpod_personal_api_key"
    if os.path.exists(key_path):
        with open(key_path, "r", encoding="utf-8") as f:
            API_KEY = f.read().strip()

if not API_KEY:
    print("ERROR: Set TILTAB_GPU_STT_API_KEY or provide .keys/runpod_personal_api_key", file=sys.stderr)
    sys.exit(1)

FILE = sys.argv[1] if len(sys.argv) > 1 else "test_audio/youtube/ky_yt_1min.wav"
SYNC = os.environ.get("RUNSYNC", "0") == "1"
RUN_URL = f"https://api.runpod.ai/v2/{ENDPOINT_ID}/run"
RUNSYNC_URL = f"https://api.runpod.ai/v2/{ENDPOINT_ID}/runsync"
STATUS_URL = f"https://api.runpod.ai/v2/{ENDPOINT_ID}/status"

with open(FILE, "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

payload = json.dumps({
    "input": {
        "audio_base64": b64,
        "language": "ky",
        "filename": os.path.basename(FILE),
    }
}).encode()

url = RUNSYNC_URL if SYNC else RUN_URL
req = urllib.request.Request(url, data=payload, headers={
    "Content-Type": "application/json",
    "Authorization": f"Bearer {API_KEY}",
}, method="POST")

print(f"Sending {FILE} ({len(b64)/1024/1024:.2f} MB base64) to {url}...")
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode())
    elapsed = time.time() - t0
    print(f"Initial response in {elapsed:.1f}s")
    print(json.dumps(data, ensure_ascii=False, indent=2))
    job_id = data.get("id")
    if not SYNC and job_id:
        print(f"\nPolling status for {job_id}...")
        status_req = urllib.request.Request(f"{STATUS_URL}/{job_id}", headers={"Authorization": f"Bearer {API_KEY}"})
        for i in range(120):
            with urllib.request.urlopen(status_req, timeout=30) as r:
                status_data = json.loads(r.read().decode())
            status = status_data.get("status")
            print(f"{time.strftime('%H:%M:%S')} {status}")
            if status in ("COMPLETED", "FAILED"):
                out_file = f"runpod_ky_result_{job_id.split('-')[0]}.json"
                with open(out_file, "w", encoding="utf-8") as f:
                    json.dump(status_data, f, ensure_ascii=False, indent=2)
                print(f"Saved full result to {out_file}")
                print(json.dumps(status_data, ensure_ascii=False, indent=2))
                if status_data.get("output") and isinstance(status_data["output"], dict) and "text" in status_data["output"]:
                    print("\n--- TEXT ---")
                    print(status_data["output"]["text"])
                sys.exit(0 if status == "COMPLETED" else 1)
            time.sleep(10)
        print("timeout")
        sys.exit(1)
    if data.get("output") and isinstance(data["output"], dict) and "text" in data["output"]:
        print("\n--- TEXT ---")
        print(data["output"]["text"])
except Exception as e:
    print(f"Error after {time.time()-t0:.1f}s: {e}")
