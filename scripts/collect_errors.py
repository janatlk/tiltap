#!/usr/bin/env python3
"""Collect user-facing errors from the TilTap admin API.

Pulls translation errors and web STT jobs, keeps the ones inside the requested
time window, prints a grouped summary and writes the raw payloads to JSON.

Usage:
    TILTAB_ADMIN_TOKEN=xxx python scripts/collect_errors.py --days 7
    python scripts/collect_errors.py --days 7 --token xxx --base http://95.216.169.56:3000

Note: Telegram transcription errors live in `transcription_requests`, which has
no admin endpoint yet. Read them via SQL or journald (see docs/AI_DEBUG_PLAYBOOK.md).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_BASE = "http://95.216.169.56:3000"


def fetch(base: str, path: str, token: str) -> dict:
    req = urllib.request.Request(
        f"{base}{path}",
        headers={"X-Admin-Token": token, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")[:500]
        raise SystemExit(f"HTTP {err.code} on {path}: {body}") from err
    except urllib.error.URLError as err:
        raise SystemExit(f"Cannot reach {base}{path}: {err.reason}") from err


def parse_ts(value) -> datetime | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def within(item: dict, cutoff: datetime) -> bool:
    for key in ("createdAt", "created_at", "errorAt", "error_at"):
        ts = parse_ts(item.get(key))
        if ts:
            return ts >= cutoff
    # No usable timestamp: keep it so nothing is silently dropped.
    return True


def first(item: dict, *keys, default=None):
    for key in keys:
        if item.get(key) not in (None, ""):
            return item[key]
    return default


def summarize(title: str, items: list[dict], msg_keys: tuple[str, ...]) -> None:
    print(f"\n=== {title}: {len(items)} ===")
    if not items:
        return

    counter = Counter()
    for item in items:
        msg = first(item, *msg_keys, default="(no message)")
        counter[str(msg)[:160]] += 1

    for msg, count in counter.most_common(25):
        print(f"  {count:>4}x  {msg}")

    print("  --- latest 10 ---")
    for item in items[:10]:
        num = first(item, "requestNumber", "request_number", default="?")
        created = first(item, "createdAt", "created_at", default="?")
        lang = first(item, "language", "sourceLang", "source_lang", default="?")
        target = first(item, "targetLang", "target_lang", default="")
        msg = str(first(item, *msg_keys, default=""))[:180]
        arrow = f"{lang}->{target}" if target else str(lang)
        print(f"  #{num} {created} [{arrow}] {msg}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="time window in days (default: 7)")
    parser.add_argument("--base", default=os.environ.get("TILTAB_BASE_URL", DEFAULT_BASE))
    parser.add_argument("--token", default=os.environ.get("TILTAB_ADMIN_TOKEN", ""))
    parser.add_argument("--limit", type=int, default=500, help="rows per endpoint (server caps at 500)")
    parser.add_argument("--out", default="tmp/errors_report.json")
    args = parser.parse_args()

    if not args.token:
        print("TILTAB_ADMIN_TOKEN is not set (use --token or the env var).", file=sys.stderr)
        return 2

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    print(f"Window: last {args.days} days (since {cutoff.isoformat()})")
    print(f"Backend: {args.base}")

    translation_errors = [
        item
        for item in fetch(args.base, f"/api/admin/translations/errors?limit={args.limit}", args.token).get("items", [])
        if within(item, cutoff)
    ]

    web_jobs = fetch(args.base, f"/api/admin/web-jobs?limit={args.limit}", args.token).get("items", [])
    web_recent = [item for item in web_jobs if within(item, cutoff)]
    web_failed = [
        item
        for item in web_recent
        if first(item, "errorMessage", "error_message") or str(first(item, "status", default="")).lower() in {"error", "failed"}
    ]

    summarize("Translation errors", translation_errors, ("errorMessage", "error_message"))
    summarize("Web STT job failures", web_failed, ("errorMessage", "error_message"))

    print(f"\n=== Web jobs in window: {len(web_recent)} total, {len(web_failed)} failed ===")
    if web_recent:
        rate = 100.0 * len(web_failed) / len(web_recent)
        print(f"  failure rate: {rate:.1f}%")
        print("  by status: " + ", ".join(
            f"{status}={count}" for status, count in
            Counter(str(first(item, "status", default="?")) for item in web_recent).most_common()
        ))
        print("  by language: " + ", ".join(
            f"{lang}={count}" for lang, count in
            Counter(str(first(item, "sourceLang", "source_lang", default="?")) for item in web_recent).most_common()
        ))

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "windowDays": args.days,
                "base": args.base,
                "translationErrors": translation_errors,
                "webJobsInWindow": web_recent,
                "webJobFailures": web_failed,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nRaw payloads written to {out_path}")
    print("Telegram STT errors are NOT included — no admin endpoint for transcription_requests.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
