"""Standalone test for vnegi1011/kyrgyz-asr (Wav2Vec2 CTC ONNX)."""
import sys
import os
import time
import json
import numpy as np
import soundfile as sf
import onnxruntime as ort

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_audio(wav_path: str, target_sr: int = 16000):
    audio, sr = sf.read(wav_path)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != target_sr:
        try:
            import librosa
            audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=target_sr)
        except ImportError:
            raise RuntimeError("librosa is required for resampling")
    return audio.astype(np.float32)


def transcribe(model_dir: str, wav_path: str):
    from transformers import Wav2Vec2Processor

    processor = Wav2Vec2Processor.from_pretrained(model_dir)
    session = ort.InferenceSession(
        os.path.join(model_dir, "model.onnx"),
        providers=["CPUExecutionProvider"],
    )

    audio = load_audio(wav_path)
    inputs = processor(audio, sampling_rate=16000, return_tensors="np")
    input_values = inputs["input_values"].astype(np.float32)

    start = time.time()
    logits = session.run(None, {"input_values": input_values})[0]
    runtime = time.time() - start

    predicted_ids = np.argmax(logits, axis=-1)
    text = processor.batch_decode(predicted_ids)[0]
    return text, runtime


if __name__ == "__main__":
    if len(sys.argv) < 2:
        wav = "test_audio/youtube/ky_yt_1min.wav"
    else:
        wav = sys.argv[1]

    model_dir = "models/vnegi1011-kyrgyz-asr"
    text, runtime = transcribe(model_dir, wav)

    result = {
        "model": "vnegi1011/kyrgyz-asr",
        "audio": wav,
        "text": text,
        "runtime_seconds": round(runtime, 2),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
