# STT Model Audit & Hosting Recommendation Report

**Project:** TilTap Backend  
**Date:** 2026-06-14  
**Scope:** Identify the best speech-to-text models for each supported language (ky, tg, uz, en, ru) and specify which models must be self-hosted vs. which can be consumed via API.

---

## Executive Summary

TilTap currently runs a **fully local/self-hosted STT pipeline** through `transcribe_hybrid.py`. No cloud STT API is used. This report audits the current setup, lists the best available models per language, and states the hosting requirement for each.

**Bottom line:** because the project is committed to local STT, **every supported language requires at least one model to be hosted on the server**. The immediate gaps are:

1. **Russian:** referenced Vosk models are missing from `models/` and must be downloaded.
2. **Tajik:** the hosted Vosk model is poor (WER ~38–41%); a better model must be selected and hosted.
3. **Uzbek:** only a small Vosk model is present; the primary model is downloaded from HuggingFace on first use and should be pre-hosted for reproducibility.
4. **English:** relies on HuggingFace Whisper downloads; works but should be pinned/pre-cached.
5. **Kyrgyz:** already correctly hosted with Vosk.

A cloud alternative (OpenAI Whisper API) is included for comparison in case the project later decides to trade hosting for operational simplicity.

---

## Current State

| Language | Current engine | Local model present? | Model size | Notes |
|----------|----------------|----------------------|------------|-------|
| Kyrgyz (`ky`) | Vosk | ✅ `models/vosk-model-ky-0.42` + small fallback | 1.9 GB + 87 MB | Best self-hosted Kyrgyz option identified |
| Tajik (`tg`) | Whisper `distil-large-v3` | ⚠️ Vosk only; unused `whisper-tajik-finetuned-ct2` exists | 796 MB (Vosk), 784 MB (Whisper fine-tune) | Vosk accuracy is very low |
| Uzbek (`uz`) | Wav2Vec2 `Beehzod/wav2vec2-large-xlsr-uzbek_STT_2` → Whisper fallback | ⚠️ Small Vosk present; HF model downloaded on demand | 49 MB (Vosk), ~1.2 GB (HF) | Needs pinned/pre-hosted primary model |
| Russian (`ru`) | Whisper `distil-large-v3` fallback | ❌ `models/vosk-model-ru-0.42` and `models/vosk-model-small-ru-0.22` missing | — | Always falls back to Whisper |
| English (`en`) | Whisper `distil-large-v3` | ⚠️ Downloaded from HF on demand | ~1.5 GB | Works, but not pinned locally |
| Multilingual (`multi`) | Dual-pass Whisper | — | — | Implemented in Python but hidden from Telegram UI |

---

## Recommended Models by Language

### 1. Kyrgyz (`ky`) — KEEP CURRENT SETUP

**Best self-hosted option:**
- **Primary:** `vosk-model-ky-0.42` (1.1–1.9 GB) — WER 8.75% (Common Voice 17), 13.45% (FLEURS)
- **Fallback:** `vosk-model-small-ky-0.42` (~49 MB) — WER 16.96% (CV17), 18.95% (FLEURS)

**Why:** Vosk’s Kyrgyz models are the strongest open-source Kyrgyz ASR models publicly available. The project already hosts both. A Wav2Vec2-XLSR Kyrgyz model exists (`iarfmoose/wav2vec2-large-xlsr-kyrgyz`) but reports ~34% WER, significantly worse than Vosk.

**Hosting required?** ✅ Already hosted. No action needed.

**Download URLs (for reference):**
- https://alphacephei.com/vosk/models/vosk-model-ky-0.42.zip
- https://alphacephei.com/vosk/models/vosk-model-small-ky-0.42.zip

---

### 2. Russian (`ru`) — DOWNLOAD & HOST VOSK

**Best self-hosted option:**
- **Primary:** `vosk-model-ru-0.42` (1.8 GB) — WER 4.5% (audiobooks), 11.1% (open_stt audiobooks), 19.5% (YouTube), 4.4% (Golos crowd)
- **Fallback:** `vosk-model-small-ru-0.22` (45 MB) — WER 11.79% (Golos crowd), 22.71% (audiobooks)

**Alternative (newer, streaming):** `alphacep/vosk-model-streaming-ru` (sherpa-onnx) — WER 11.6% on Sova benchmark vs. Whisper Large V3 15.9%. Requires `sherpa-onnx` instead of `vosk`.

**Why:** The project’s Python code expects Russian Vosk models at `models/vosk-model-ru-0.42` and `models/vosk-model-small-ru-0.22`, but neither exists, so Russian always falls back to Whisper. Vosk 0.42 is significantly faster on CPU and competitive with Whisper on Russian.

**Hosting required?** ❌ Missing — must download and host locally.

**Download URLs:**
- https://alphacephei.com/vosk/models/vosk-model-ru-0.42.zip
- https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip
- Streaming alternative: https://huggingface.co/alphacep/vosk-model-streaming-ru

**Recommended action:**
1. Download `vosk-model-ru-0.42` and `vosk-model-small-ru-0.22` into `models/`.
2. Verify `transcribe_hybrid.py` uses the correct paths.
3. Add model download step to setup/CI scripts so the server does not start without them.

---

### 3. Tajik (`tg`) — REPLACE OR SUPPLEMENT VOSK

**Current self-hosted option:**
- `vosk-model-tg-0.22` (327 MB) — WER 41.1% (FLEURS)
- `vosk-model-small-tg-0.22` (50 MB) — WER 38.4% (FLEURS)

**Better candidates:**
1. **`models/whisper-tajik-finetuned-ct2` (784 MB)** — already in the repo but unused. Likely better than Vosk because it is a Whisper model fine-tuned on Tajik data, but its exact WER is unknown and must be benchmarked.
2. **`openai/whisper-large-v3` / `distil-large-v3`** — general multilingual Whisper; handles Tajik Cyrillic but sometimes confuses it with Persian/Arabic script.
3. **Re-skill open Tajik ASR (2025)** — new model trained on hundreds of hours of Tajik news/speech. Early results look promising, but it is not yet a clear production choice. Track at: Asia-Plus / Re-skill partnership announcements and HuggingFace.

**Why:** Tajik Vosk accuracy is the worst of the five languages. The project already owns a Tajik-fine-tuned Whisper model that is not being used. It should be evaluated first before downloading additional models.

**Hosting required?** ⚠️ Yes, but the model choice is unresolved.

**Recommended action:**
1. Benchmark the existing `whisper-tajik-finetuned-ct2` against the current Whisper fallback using `test_audio/tg.wav`.
2. If the fine-tuned model is clearly better, switch the Tajik route to use it.
3. If not, evaluate Whisper `large-v3` or Re-skill’s model.
4. Remove whichever model is not selected to free ~0.8–1.6 GB.

---

### 4. Uzbek (`uz`) — PIN THE PRIMARY MODEL

**Current self-hosted option:**
- `vosk-model-small-uz-0.22` (49 MB) — WER 13.54% (Common Voice), 12.92% (IS2AI USC)

**Primary used by code:**
- `Beehzod/wav2vec2-large-xlsr-uzbek_STT_2` (~1.2 GB, HuggingFace) — downloaded on demand

**Better/fine-tuned Whisper candidates:**
- `BlueRaccoon/whisper-small-uz` (~1.7 GB, Spark NLP mirror: `asr_whisper_small_uzbek`)
- `aslon1213/whisper-small-uz-with-uzbekvoice`

**Why:** The current primary model is downloaded from HuggingFace the first time an Uzbek audio is processed. This makes deployment unreliable and hard to reproduce. The small Vosk model is acceptable as a lightweight fallback but there is no large Vosk Uzbek model.

**Hosting required?** ⚠️ Partial. The primary model should be pre-downloaded and hosted locally.

**Recommended action:**
1. Pre-download `Beehzod/wav2vec2-large-xlsr-uzbek_STT_2` (or a fine-tuned Whisper Uzbek model) into a cache directory and pin it in deployment.
2. Keep `vosk-model-small-uz-0.22` as a CPU-light fallback.
3. Benchmark the Wav2Vec2 model against the fine-tuned Whisper options to pick the best primary.

---

### 5. English (`en`) — PIN OR ADD VOSK FALLBACK

**Best self-hosted options:**
- **Primary:** Whisper `distil-large-v3` or `large-v3` (~1.5 GB, HuggingFace) — WER ~4% on clean English
- **Alternative local:** `vosk-model-en-us-0.42-gigaspeech` (2.3 GB) — WER 5.64% (librispeech), or `vosk-model-en-us-0.22` (1.8 GB) — WER 5.69%
- **Lightweight local fallback:** `vosk-model-small-en-us-0.15` (40 MB) — WER 9.85%

**Why:** The current English path uses Whisper downloaded from HuggingFace, which is fine for accuracy but not pinned. If the goal is a fully reproducible local deployment, the model should be cached.

**Hosting required?** ⚠️ Indirectly — model is pulled on demand. Recommend pre-caching.

**Recommended action:**
1. Pre-cache the Whisper English model during setup/CI.
2. Optionally add a small Vosk English fallback for offline/low-resource scenarios.

---

## Multilingual / Code-Switching Mode

The backend already implements a `multi` dual-pass Whisper mode (auto-detect + forced Russian merge). This is the right approach for Turkic–Russian code-switching, but it is **not exposed in the Telegram UI**.

**Recommended action:**
- Add `🌍 Auto / Multilingual` to the source-language keyboard so users can reach the existing `multi` pipeline.
- Ensure the dual-pass mode uses the best available per-language models (e.g., Kyrgyz Vosk + Russian Vosk) instead of Whisper-only where possible.

---

## Hosting Requirements Matrix

| Language | Needs local model? | Current status | Recommended fix |
|----------|--------------------|----------------|-----------------|
| Kyrgyz | ✅ Yes | ✅ Hosted | None |
| Russian | ✅ Yes | ❌ Missing | Download `vosk-model-ru-0.42` + small fallback |
| Tajik | ✅ Yes | ⚠️ Hosted but poor | Benchmark `whisper-tajik-finetuned-ct2`; switch if better |
| Uzbek | ✅ Yes | ⚠️ Partial | Pre-download primary Wav2Vec2/Whisper model |
| English | ✅ Yes (for local-only policy) | ⚠️ Pulls on demand | Pre-cache Whisper model |

> **Important:** If the project later accepts a cloud STT API, none of these models need to be hosted locally. See the cloud alternative below.

---

## Cloud Alternative: OpenAI Whisper API

If self-hosting large models is operationally undesirable, the simplest alternative is the **OpenAI Whisper API** (or any OpenAI-compatible Whisper host).

| Attribute | Detail |
|-----------|--------|
| Languages supported | 99+ (includes ky, tg, uz, en, ru) |
| Price | ~$0.006 / minute ($0.36 / hour) |
| Hosting requirement | None — audio is sent to the API |
| Pros | No model downloads, no GPU/VRAM, instant multi-language support, handles code-switching reasonably well |
| Cons | Recurring cost, 25 MB file limit per request, requires internet, privacy/data-residency considerations |

**Verdict:** use only if the project is willing to drop the fully-offline requirement. Otherwise, continue with the local-model fixes above.

---

## Immediate Action Plan

1. **Russian:** Download and extract Vosk models into `models/`:
   ```bash
   wget https://alphacephei.com/vosk/models/vosk-model-ru-0.42.zip
   wget https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip
   unzip vosk-model-ru-0.42.zip -d models/
   unzip vosk-model-small-ru-0.22.zip -d models/
   ```

2. **Tajik:** Benchmark the unused `models/whisper-tajik-finetuned-ct2` against the current Whisper fallback. Decide whether to keep, replace, or remove it.

3. **Uzbek:** Pre-download the primary HuggingFace model and pin it in deployment.

4. **English:** Pre-cache the Whisper English model.

5. **Telegram UI:** Re-expose the `multi` dual-pass mode in the source-language keyboard.

6. **Reproducibility:** Create a `requirements.txt` for Python dependencies and a model-download script so STT setup is repeatable across environments.

---

## Model Quick-Reference Table

| Language | Model | Size | WER (benchmark) | Source |
|----------|-------|------|-----------------|--------|
| Kyrgyz | `vosk-model-ky-0.42` | 1.1 GB | 8.75% (CV17), 13.45% (FLEURS) | alphacephei.com/vosk/models |
| Kyrgyz | `vosk-model-small-ky-0.42` | 49 MB | 16.96% (CV17), 18.95% (FLEURS) | alphacephei.com/vosk/models |
| Russian | `vosk-model-ru-0.42` | 1.8 GB | 4.5% (audiobooks), 11.1% (open_stt) | alphacephei.com/vosk/models |
| Russian | `vosk-model-small-ru-0.22` | 45 MB | 11.79% (Golos), 22.71% (audiobooks) | alphacephei.com/vosk/models |
| Russian | `vosk-model-streaming-ru` | varies | 11.6% (Sova) vs Whisper 15.9% | huggingface.co/alphacep |
| Tajik | `vosk-model-tg-0.22` | 327 MB | 41.1% (FLEURS) | alphacephei.com/vosk/models |
| Tajik | `whisper-tajik-finetuned-ct2` | 784 MB | unknown — needs benchmark | local / HuggingFace |
| Uzbek | `vosk-model-small-uz-0.22` | 49 MB | 13.54% (CV), 12.92% (IS2AI) | alphacephei.com/vosk/models |
| Uzbek | `Beehzod/wav2vec2-large-xlsr-uzbek_STT_2` | ~1.2 GB | ~14.3% reported | HuggingFace |
| English | Whisper `distil-large-v3` | ~1.5 GB | ~4% (clean English) | HuggingFace |
| English | `vosk-model-en-us-0.42-gigaspeech` | 2.3 GB | 5.64% (librispeech) | alphacephei.com/vosk/models |

---

## Sources

- Vosk official model list: https://alphacephei.com/vosk/models
- Vosk streaming Russian model: https://huggingface.co/alphacep/vosk-model-streaming-ru
- OpenAI Whisper API pricing: https://platform.openai.com/pricing
- ISSAI multilingual Turkic ASR: https://issai.nu.edu.kz/turkic-asr/
- Re-skill / Asia-Plus Tajik ASR partnership (2025): public press coverage
- Project local model inventory: `models/`, `test_audio/manifest.json`
