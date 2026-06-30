"""Compare open-source Tajik STT vs ElevenLabs Scribe v2 on the hard fixture."""
import os
import sys
import json
import time

from dotenv import load_dotenv
load_dotenv()

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_reference():
    with open("test_audio/hard_manifest.json", "r", encoding="utf-8") as f:
        return json.load(f)["fixtures"]["tg"]["referenceText"]


def similarity(a: str, b: str):
    def lev(x, y):
        if len(x) < len(y):
            return lev(y, x)
        if not y:
            return len(x)
        prev = list(range(len(y) + 1))
        for i, cx in enumerate(x):
            curr = [i + 1]
            for j, cy in enumerate(y):
                curr.append(min(curr[-1] + 1, prev[j + 1] + 1, prev[j] + (0 if cx == cy else 1)))
            prev = curr
        return prev[-1]

    a, b = a.strip(), b.strip()
    if not a and not b:
        return 100.0, 100.0
    if not a or not b:
        return 0.0, 0.0
    d = lev(a, b)
    char_sim = round(100 * (1 - d / max(len(a), len(b))), 1)
    rw, hw = set(a.lower().split()), set(b.lower().split())
    word_acc = round(100 * len(rw & hw) / len(rw | hw), 1)
    return char_sim, word_acc


def transcribe_local(wav_path: str):
    """Run the same command as the Node transcription service."""
    import subprocess
    import shutil

    ffmpeg = shutil.which("ffmpeg") or os.environ.get("FFMPEG_PATH")
    if not ffmpeg:
        # Try to resolve ffmpeg-static via node if available.
        try:
            ffmpeg = subprocess.check_output(["node", "-p", "require('ffmpeg-static')"], text=True).strip()
        except Exception:
            ffmpeg = "ffmpeg"

    script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "transcribe_hybrid.py")
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, script, wav_path, ffmpeg, "tg"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Local transcription failed: {proc.stderr}")

    # The final JSON line with the transcript is the last JSON object on stdout.
    result = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                parsed = json.loads(line)
                if "text" in parsed and "segments" in parsed:
                    result = parsed
            except json.JSONDecodeError:
                pass
    if result is None:
        raise RuntimeError("Could not parse local transcription output")
    return result.get("text", ""), time.time() - t0


def transcribe_elevenlabs(wav_path: str):
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY not set")

    try:
        import requests
    except ImportError:
        raise RuntimeError("requests not installed")

    url = "https://api.elevenlabs.io/v1/speech-to-text"
    t0 = time.time()
    with open(wav_path, "rb") as f:
        files = {"file": (os.path.basename(wav_path), f, "audio/wav")}
        data = {
            "model_id": os.environ.get("ELEVENLABS_MODEL_ID", "scribe_v2"),
            "tag_audio_events": "true",
            "num_speakers": "1",
            "diarize": "false",
            "timestamps_granularity": "word",
            "language_code": "tgk",
        }
        headers = {"xi-api-key": api_key}
        resp = requests.post(url, files=files, data=data, headers=headers, timeout=600)

    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs error {resp.status_code}: {resp.text[:500]}")

    payload = resp.json()
    text = payload.get("text", "").strip()
    return text, time.time() - t0, payload


if __name__ == "__main__":
    wav_path = "test_audio/youtube/tg_yt.wav"
    ref = load_reference()

    print("Running open-source Tajik STT...", flush=True)
    local_text, local_time = transcribe_local(wav_path)
    local_char, local_word = similarity(ref, local_text)

    print("Running ElevenLabs Scribe v2...", flush=True)
    try:
        el_text, el_time, el_payload = transcribe_elevenlabs(wav_path)
        el_char, el_word = similarity(ref, el_text)
        el_chars_billed = el_payload.get("characters", 0)
    except Exception as e:
        el_text, el_time, el_char, el_word, el_chars_billed = "", 0, 0, 0, 0
        print(f"ElevenLabs failed: {e}", flush=True)

    report = {
        "audio": wav_path,
        "reference": ref,
        "open_source": {
            "text": local_text,
            "char_similarity": local_char,
            "word_accuracy": local_word,
            "runtime_seconds": round(local_time, 2),
        },
        "elevenlabs": {
            "text": el_text,
            "char_similarity": el_char,
            "word_accuracy": el_word,
            "runtime_seconds": round(el_time, 2),
            "characters_billed": el_chars_billed,
        },
    }

    os.makedirs("logs", exist_ok=True)
    with open("logs/benchmark_tajik_elevenlabs.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("\n=== Tajik STT comparison ===")
    print(f"Open-source  char={local_char}% word={local_word}% time={local_time:.1f}s")
    print(f"ElevenLabs   char={el_char}% word={el_word}% time={el_time:.1f}s billed_chars={el_chars_billed}")
    print(f"Report: logs/benchmark_tajik_elevenlabs.json")
