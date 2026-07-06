#!/usr/bin/env python3
"""Local test for the RunPod handler (no RunPod runtime required)."""

import argparse
import base64
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="Path to audio file")
    parser.add_argument("language", default="ru", nargs="?")
    args = parser.parse_args()

    with open(args.audio, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode("utf-8")

    event = {"input": {"audio_base64": audio_b64, "language": args.language, "filename": args.audio}}
    result = handler.handler(event)
    print(result)


if __name__ == "__main__":
    main()
