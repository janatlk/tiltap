#!/usr/bin/env python3
"""Raw Kyrgyz Vosk transcription without post-processing."""
import json
import os
import subprocess
import sys
import wave

PYTHON_PATH = sys.executable
FFMPEG_PATH = "node_modules/ffmpeg-static/ffmpeg.exe"
MODEL_PATH = "models/vosk-model-ky-0.42"


def convert_to_wav(input_file: str, wav_path: str, ffmpeg_path: str):
    cmd = [
        ffmpeg_path,
        "-y",
        "-i", input_file,
        "-ar", "16000",
        "-ac", "1",
        "-f", "wav",
        wav_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def transcribe_raw(wav_path: str, model_path: str, chunk_seconds: float = 60.0):
    from vosk import Model, KaldiRecognizer

    wf = wave.open(wav_path, "rb")
    nchannels = wf.getnchannels()
    sampwidth = wf.getsampwidth()
    framerate = wf.getframerate()
    nframes = wf.getnframes()
    total_duration = nframes / framerate
    frame_size = nchannels * sampwidth
    chunk_frames = int(chunk_seconds * framerate)

    model = Model(model_path)
    all_words = []
    seg_id = 0
    segments = []

    start_frame = 0
    while start_frame < nframes:
        end_frame = min(start_frame + chunk_frames, nframes)
        wf.setpos(start_frame)
        data = wf.readframes(end_frame - start_frame)

        rec = KaldiRecognizer(model, framerate)
        rec.SetWords(True)
        pos = 0
        frame_bytes = 4000 * frame_size
        while pos < len(data):
            chunk = data[pos:pos + frame_bytes]
            rec.AcceptWaveform(chunk)
            pos += len(chunk)
        part = json.loads(rec.FinalResult())
        offset = start_frame / framerate

        chunk_words = []
        for w in part.get("result", []):
            chunk_words.append({
                "word": w["word"],
                "start": round(w["start"] + offset, 3),
                "end": round(w["end"] + offset, 3),
                "conf": w.get("conf", 0.0),
            })

        if chunk_words:
            text = " ".join(w["word"] for w in chunk_words)
            segments.append({
                "id": seg_id,
                "start": chunk_words[0]["start"],
                "end": chunk_words[-1]["end"],
                "text": text,
                "confidence": 0.0,
            })
            all_words.extend(chunk_words)
            seg_id += 1

        print(f"Chunk {start_frame // chunk_frames + 1}: {len(chunk_words)} words", file=sys.stderr)
        start_frame += chunk_frames

    wf.close()

    full_text = " ".join(w["word"] for w in all_words)
    return {
        "text": full_text,
        "language": "ky",
        "segments": segments,
    }


def main():
    input_file = sys.argv[1]
    output_file = sys.argv[2]

    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        convert_to_wav(input_file, wav_path, FFMPEG_PATH)
        result = transcribe_raw(wav_path, MODEL_PATH)
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    finally:
        os.unlink(wav_path)


if __name__ == "__main__":
    main()
