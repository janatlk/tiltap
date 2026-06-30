"""Standalone test for burhon97/whisper-tajik-finetuned."""
import sys
import os
import time
import json
import numpy as np
import soundfile as sf

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

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
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    processor = WhisperProcessor.from_pretrained(model_dir)
    model = WhisperForConditionalGeneration.from_pretrained(model_dir)
    model.eval()

    audio = load_audio(wav_path)
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt")

    model.config.forced_decoder_ids = processor.get_decoder_prompt_ids(language="tajik", task="transcribe")

    start = time.time()
    with torch.no_grad():
        predicted_ids = model.generate(inputs["input_features"])
    runtime = time.time() - start

    text = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
    return text, runtime


if __name__ == "__main__":
    if len(sys.argv) < 2:
        wav = "test_audio/youtube/tg_yt.wav"
    else:
        wav = sys.argv[1]

    model_dir = "models/burhon97-whisper-tajik-finetuned"
    text, runtime = transcribe(model_dir, wav)

    result = {
        "model": "burhon97/whisper-tajik-finetuned",
        "audio": wav,
        "text": text,
        "runtime_seconds": round(runtime, 2),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
