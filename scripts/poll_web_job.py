#!/usr/bin/env python3
import json, sys, time, urllib.request

job_id = sys.argv[1]
url = f"http://localhost:3000/api/web/jobs/{job_id}"
for i in range(60):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read().decode())
    except Exception as e:
        print("poll error", e)
        time.sleep(10)
        continue
    status = data.get("status")
    print(f"{time.strftime('%H:%M:%S')} {status}")
    if status in ("completed", "failed"):
        print(json.dumps(data, ensure_ascii=False, indent=2))
        sys.exit(0 if status == "completed" else 1)
    time.sleep(10)
print("timeout")
sys.exit(1)
