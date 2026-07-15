# Open-Weight LLM Recommendations for Uzbek, Kyrgyz, and Tajik

**Goal:** identify the best openly licensed models for **translation**, **text understanding**, and **ASR-output cleanup/post-processing** in the three Central Asian languages Tiltap supports: **Uzbek (uz)**, **Kyrgyz (ky)**, **Tajik (tg)**.  
**Hardware target:** single NVIDIA RTX A4500 with **16 GB VRAM**, with the option to add system RAM for CPU offloading.  
**Date:** July 2026.

> TL;DR for Tiltap
> 1. **Translation:** use a dedicated NMT model — `NLLB-200-3.3B` (or the distilled 1.3B if you need more headroom). It explicitly covers `uzn_Latn`, `kir_Cyrl`, and `tgk_Cyrl`.
> 2. **Cleanup / understanding:** run a general multilingual instruct model locally. `Qwen2.5-7B-Instruct` (AWQ/GPTQ) is the safest fit on 16 GB when colocated with STT. `Aya-101` (4-bit or CTranslate2 INT8) is the best choice for explicit ky/tg/uz coverage and is Apache 2.0. See [OpenWeight_LLM_for_STT_Cleanup_A4500.md](OpenWeight_LLM_for_STT_Cleanup_A4500.md) for a detailed STT-cleanup report.
> 3. **Do not expect one model to do everything well.** The winning architecture is a **dual pipeline**: NLLB for translation, a small instruct LLM for cleanup/QA/review.

---

## 1. Hardware reality check — RTX A4500 16 GB

| What fits | Approx. VRAM | Notes |
|-----------|--------------|-------|
| 7–8 B param model at FP16 | ~15 GB + KV cache | Marginal; risky for production context lengths. |
| 7 B param AWQ/GPTQ INT4 | ~4.5–6 GB | Comfortable, leaves room for KV cache and a second small model. |
| 14 B param Q4_K_M GGUF | ~8.5–10 GB | Fits, but context length must be capped. |
| 32 B param Q4_K_M | ~18–20 GB | **Does not fit** in 16 GB VRAM unless heavily quantized (Q3 / IQ) or CPU-offloaded. |
| NLLB-200-3.3B FP16 | ~7 GB | Fits easily; use `device_map="cuda"` or CTranslate2. |
| NLLB-200-1.3B distilled FP16 | ~3 GB | Fits with Whisper/CT2 models side-by-side. |

**Practical rule:** keep the GPU resident model footprint below ~12 GB so Whisper, VAD, and KV cache do not run out of memory.

---

## 2. Language-specific facts

| Language | Script | Resource level | Useful related languages | Notes |
|----------|--------|----------------|--------------------------|-------|
| **Uzbek** | Latin (`uzn_Latn`) + Cyrillic legacy | Low-mid | Turkish, Kazakh, Kyrgyz, Uyghur, Russian | Latin script is official. NLLB code is `uzn_Latn`. |
| **Kyrgyz** | Cyrillic (`kir_Cyrl`) | Low | Kazakh, Tatar, Bashkir, Russian, Turkish | Very close to Kazakh; KAZ-LLM may transfer. |
| **Tajik** | Cyrillic (`tgk_Cyrl`) | Very low | Persian/Farsi, Dari, Pashto | Same branch as Persian but different script/norms. Persian models help only after script normalization. |

All three are **agglutinative or fusional** and morphologically rich, so character-level metrics (chrF++) matter more than tokenized BLEU.

---

## 3. Candidate models

### 3.1 Dedicated machine translation (best for translation)

These are seq2seq models trained specifically for translation. They are smaller, faster, and more controllable than LLMs for this task.

| Model | HF ID | Params | Fits A4500? | Strengths | Caveats |
|-------|-------|--------|-------------|-----------|---------|
| **NLLB-200-3.3B** | `facebook/nllb-200-3.3B` | 3.3 B | Yes (~7 GB FP16) | Covers 200 languages incl. `uzn_Latn`, `kir_Cyrl`, `tgk_Cyrl`. Strong published FLORES-200 scores for low-resource pairs. | CC-BY-NC (non-commercial research). Input length soft-cap ~512 tokens. |
| **NLLB-200-distilled-1.3B** | `facebook/nllb-200-distilled-1.3B` | 1.3 B | Yes (~3 GB FP16) | Fast, small, easy to colocate with Whisper/LLM. Fine-tunable with LoRA on a single GPU. | Slightly lower baseline quality than 3.3B. |
| **NLLB-200-distilled-600M** | `facebook/nllb-200-distilled-600M` | 600 M | Yes (~1.5 GB) | Extremely cheap. Good for prototypes or CPU fallback. | Lowest quality of the three. |
| **MADLAD-400-3b-mt** | `google/madlad400-3b-mt` | 3 B | Yes | 450+ languages, Common-Crawl-trained, robust to web text. | T5-based; fewer deployment examples for low-resource Cyrillic pairs. |
| **MADLAD-400-7b-mt** | `google/madlad400-7b-mt` | 7 B | Yes (~14 GB FP16) | Better quality than 3B. | Tight on a 16 GB GPU if other models are loaded. |
| **MADLAD-400-10b-mt** | `google/madlad400-10b-mt` | 10.7 B | No at FP16 | Best MADLAD quality. | Needs quantization or a larger GPU. |

**Language codes for NLLB:**
- Uzbek: `uzn_Latn`
- Kyrgyz: `kir_Cyrl`
- Tajik: `tgk_Cyrl`

**Evidence:** LoResMT 2026 Turkic shared-task submissions showed that a **LoRA-fine-tuned `nllb-200-distilled-600M`** reached chrF++ ~49.7 (Kazakh) and zero-shot LLM prompting reached ~45.6 (Kyrgyz). On Russian→Kyrgyz FLORES-200, NLLB-200-54B scored ~41.7 chrF++, while a custom 800M model reached 44.9–49.1 after targeted data curation. This tells us: **NLLB is the best open starting point, but quality jumps with domain-specific fine-tuning.**

### 3.2 General-purpose multilingual LLMs (best for cleanup / understanding / review)

These are decoder-only instruct models. Use them to:
- Clean up ASR hallucinations, repetitions, and script leakage.
- Do translation QA / review.
- Classify intent or detect language.
- Generate synthetic parallel data for fine-tuning NLLB.

| Model | HF ID | Params | Fits A4500? | Languages | Strengths | Caveats |
|-------|-------|--------|-------------|-----------|-----------|---------|
| **Qwen2.5-7B-Instruct** | `Qwen/Qwen2.5-7B-Instruct` | 7 B | Yes with AWQ/GPTQ/INT4 (~4.5 GB) | 29+ incl. Russian, Chinese, Turkish, Arabic, Persian | Apache 2.0, excellent instruction following, JSON, long context (128k). | Uzbek/Kyrgyz/Tajik not in the official language list; relies on transfer. |
| **Qwen2.5-14B-Instruct** | `Qwen/Qwen2.5-14B-Instruct` | 14 B | Yes at Q4_K_M/AWQ (~9 GB) | Same as 7B | Noticeably stronger reasoning and multilingual transfer. | Slower; needs context capping on 16 GB. |
| **Aya-101** | `CohereForAI/aya-101` | 13 B | Yes with 4-bit BitsAndBytes (~7.5–8 GB) or CTranslate2 INT8 (~13 GB) | 101 languages, **explicitly includes ky, tg, uz** | State-of-the-art among massively multilingual open LLMs; T5 encoder-decoder is a natural fit for text-to-text cleanup. | **Apache 2.0**. Requires T5-aware serving (transformers/CTranslate2, not plain vLLM). |
| **Aya Expanse 8B** | `CohereForAI/aya-expanse-8b` | 8 B | Yes at Q4_K_M (~5 GB) | 23 languages (Russian, Turkish, Persian, Arabic, etc.) | Best multilingual preference-tuned model in its size class; strong translation chrF++ headline scores. | **Does not include Uzbek/Kyrgyz/Tajik**. **CC-BY-NC**. |
| **Llama 3.1 8B Instruct** | `meta-llama/Llama-3.1-8B-Instruct` | 8 B | Yes at Q4_K_M (~5 GB) | Multilingual but English-centric | Great general reasoning. | Weak for low-resource Central Asian languages unless fine-tuned. |
| **Gemma 2 9B IT** | `google/gemma-2-9b-it` | 9 B | Yes at Q4_K_M (~6 GB) | Multilingual | Good general model. | No special advantage for these languages. |

**Key choice:**
- If you want the **best explicit coverage of ky/tg/uz** and can run a 13B model on a separate GPU/endpoint: **Aya-101 4-bit** (Apache 2.0).
- If you want the **safest Apache-licensed model that fits inside the same STT worker**: **Qwen2.5-7B-Instruct AWQ**.
- **Aya Expanse 8B** is excellent for translation into its 23 supported languages, but since Uzbek/Kyrgyz/Tajik are not in that list and its license is CC-BY-NC, it is a weaker direct fit than Aya-101 for these three.

### 3.3 Turkic-specific generative models (transfer option)

| Model | HF ID | Params | Fits? | Relevance |
|-------|-------|--------|-------|-----------|
| **KAZ-LLM 8B** | `issai/Llama-3.1-KazLLM-1.0-8B` | 8 B | Yes | Kazakh-focused LLaMA 3.1 continuation. Because Kazakh and Kyrgyz/Uzbek are closely related, it can be a useful **transfer base** for cleanup or synthetic data generation. CC-BY-NC. |

### 3.4 Encoder-only / embedding models (classification, similarity, retrieval)

These are not generative, but they are cheap and useful for:
- Sentence embedding & retrieval
- Toxicity / topic classification
- Duplicate detection

| Model | HF ID | Size | Notes |
|-------|-------|------|-------|
| **XLM-RoBERTa-large** | `FacebookAI/xlm-roberta-large` | 560 M | Broad multilingual representations; supports Cyrillic and Latin. |
| **LaBSE** | `sentence-transformers/LaBSE` | ~470 M | Cross-lingual sentence embeddings; good for Uzbek/Russian/Tajik similarity. |
| **paraphrase-multilingual-MiniLM** | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | ~120 M | Fast, covers 50+ languages, good baseline. |
| **KyrgyzBERT** | `KyrgyzBERT/kyrgyzbert-base` (or similar) | ~110 M | If available, best for Kyrgyz-specific classification/NER. |
| **UzBERT / BERTbek** | `uzbert` family | ~110 M | Uzbek-specific encoders for classification tasks. |

### 3.5 Tajik-specific tooling

| Resource | Type | Notes |
|----------|------|-------|
| **TajikNLP** | Python library + datasets | First comprehensive Tajik Cyrillic pipeline: normalization, tokenization, POS, morphology, embeddings, NER helpers. Use it as a **pre/post-processor** before calling any LLM. |
| **TajPersLexon** | Lexical resource | 40k Tajik–Persian pairs; useful for script-normalization dictionaries. |
| **NLLB `tgk_Cyrl`** | MT model | Current best open Tajik translation coverage. |

---

## 4. Recommended deployment stack for Tiltap

Given the ASR-first architecture of Tiltap, the LLM layer should be **auxiliary**, not the main translation engine.

```
┌─────────────────────────────────────────────────────────────┐
│  User request                                               │
│     ↓                                                       │
│  Local Whisper / Vosk / GPU worker  → raw transcript        │
│     ↓                                                       │
│  [Optional] TajikNLP normalization (Tajik only)             │
│     ↓                                                       │
│  NLLB-200-3.3B  →  translated text (if translation needed)  │
│     ↓                                                       │
│  Qwen2.5-7B-Instruct / Aya-101  →  cleanup / QA review      │
│     ↓                                                       │
│  Final response                                             │
└─────────────────────────────────────────────────────────────┘
```

### Option A — balanced, production-ready (recommended)

| Role | Model | Quantization | Est. VRAM |
|------|-------|--------------|-----------|
| Translation | `facebook/nllb-200-3.3B` | FP16 / CTranslate2 INT8 | ~7 GB → ~3.5 GB |
| Cleanup / QA | `Qwen/Qwen2.5-7B-Instruct-AWQ` | INT4 | ~4.5 GB |
| Embeddings (optional) | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | FP32 | ~0.5 GB |
| **Total** | | | **~8–12 GB** |

### Option B — maximum language coverage

| Role | Model | Quantization | Est. VRAM |
|------|-------|--------------|-----------|
| Translation | `facebook/nllb-200-distilled-1.3B` | FP16 | ~3 GB |
| Cleanup / QA | `CohereForAI/aya-101` Q4_K_M GGUF | INT4 | ~8 GB |
| **Total** | | | **~11 GB** |

### Option C — minimal / CPU-fallback

| Role | Model | Quantization | Est. VRAM |
|------|-------|--------------|-----------|
| Translation | `facebook/nllb-200-distilled-600M` | INT8 | ~0.8 GB |
| Cleanup | `Qwen/Qwen2.5-3B-Instruct` Q4_K_M | INT4 | ~2 GB |
| **Total** | | | **~3 GB** |

---

## 5. How to deploy

### 5.1 NLLB with CTranslate2 (fast, low VRAM)

```bash
pip install ctranslate2 transformers sentencepiece
```

```python
import ctranslate2
from transformers import AutoTokenizer

model_id = "facebook/nllb-200-3.3B"
ct2_path = "/models/nllb-200-3.3B-ct2-int8"

# One-time conversion
# ct2-transformers-converter --model facebook/nllb-200-3.3B \
#   --output_dir /models/nllb-200-3.3B-ct2-int8 --quantization int8_float16

translator = ctranslate2.Translator(ct2_path, device="cuda", compute_type="int8_float16")
tokenizer = AutoTokenizer.from_pretrained(model_id, src_lang="kir_Cyrl")

text = "Бул кыргызча сүйлөшүү."
inputs = tokenizer(text, return_tensors="pt")
sources = [tokenizer.convert_ids_to_tokens(inputs["input_ids"][0].tolist())]

results = translator.translate_batch(
    sources,
    target_prefix=[["rus_Cyrl"]],
    beam_size=5,
    max_batch_size=64,
)
tokens = results[0].hypotheses[0][1:]  # drop target prefix
print(tokenizer.decode(tokenizer.convert_tokens_to_ids(tokens), skip_special_tokens=True))
```

### 5.2 Qwen2.5 with vLLM (OpenAI-compatible API)

```bash
pip install vllm
vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ \
  --quantization awq \
  --dtype half \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.85
```

Then call it exactly like OpenAI from the Node backend.

### 5.3 Aya-101 with llama.cpp (GGUF)

```bash
# Download a Q4_K_M GGUF, e.g. from lmstudio-community
./llama-server \
  -m models/aya-101-q4_k_m.gguf \
  -ngl 999 \
  -c 4096 \
  --port 8080 \
  --jinja
```

---

## 6. Benchmark snapshot (indicative)

| Model / system | Task | Reported chrF++ | Source |
|----------------|------|-----------------|--------|
| NLLB-200-54B | ru → ky FLORES-200 | ~41.7 | LoResMT 2026 baseline table |
| Custom 800M (curated data) | ru → ky FLORES-200 / shared task | 44.9 / 49.1 | LoResMT 2026 winning system |
| LoRA-fine-tuned NLLB-600M | ru → kk | 49.7 | LoResMT 2026 multi-pair paper |
| Zero-shot DeepSeek-V3.2 / MiMoV2 | ru → ky | 45.6 | LoResMT 2026 multi-pair paper |
| Aya Expanse 8B | general translation avg | 57.2 chrF++ | Cohere Aya Expanse marketing comparison (language subset) |
| Aya-101 | 101-language MMLU/NLU | SOTA among open multilingual LLMs | Üstün et al., 2024 |

> **Takeaway:** dedicated NMT models are competitive for the target translation direction; general LLMs are better used for cleanup, review, and data generation than as the primary translator.

---

## 7. Fine-tuning & data augmentation notes

The biggest quality gains will come from **task-specific fine-tuning**, not from picking a bigger model.

1. **Collect in-domain parallel data.** Even 5k–20k sentence pairs of transcripts ↔ corrected transcripts or translations beats a zero-shot 70B model for ASR cleanup.
2. **LoRA NLLB on your data.** Use `facebook/nllb-200-distilled-1.3B` or `nllb-200-3.3B` with PEFT/LoRA. Train only the adapter (~10–50 MB) and keep the base model frozen.
3. **Use the LLM to generate synthetic data.** Prompt `Qwen2.5-7B` or `Aya-101` with high-quality source sentences and ask for translations. Filter with `LaBSE` similarity and `COMET-QE`.
4. **Tajik script normalization first.** Always pipe Tajik through `TajikNLP` or a custom dictionary before translation/cleanup; Persian models will not handle Cyrillic out of the box.
5. **Kyrgyz/Uzbek transfer from Kazakh.** If you collect Kazakh data, consider continued pre-training or LoRA on `KAZ-LLM-8B` for Kyrgyz/Uzbek cleanup tasks.

---

## 8. Operational caveats

- **Licenses:** NLLB and Aya Expanse are **CC-BY-NC** (non-commercial). **Aya-101 is Apache 2.0.** If Tiltap is commercial, prefer `Aya-101`, `Qwen2.5` (Apache 2.0) and `MADLAD-400` (Apache 2.0), or fine-tune your own adapter on top of an Apache base.
- **Context length:** NLLB was trained with ≤512 token inputs. Split long transcripts into sentences or semantic chunks before translation.
- **Hallucination guardrails:** LLM cleanup can “improve” text by adding information. Always instruct the model to **preserve names, numbers, and meaning**; consider a rule-based sanity check after the LLM.
- **GPU colocation:** If the same A4500 also runs Whisper/CT2, load the LLM only when needed, or run it on a separate worker/container to avoid OOM.

---

## 9. Decision matrix

| If your priority is… | Use… |
|----------------------|------|
| Best open translation for uz/ky/tg | `facebook/nllb-200-3.3B` (fine-tune if you have data) |
| Fastest translation on limited VRAM | `facebook/nllb-200-distilled-600M` or CTranslate2 INT8 NLLB-1.3B |
| Best cleanup/QA model that fits 16 GB alongside STT | `Qwen/Qwen2.5-7B-Instruct-AWQ` |
| Best explicit ky/tg/uz cleanup coverage | `CohereForAI/aya-101` 4-bit / CTranslate2 INT8 |
| Commercially usable stack | `MADLAD-400-3b-mt` + `Qwen2.5-7B-Instruct` |
| Tajik-specific normalization | `TajikNLP` + NLLB `tgk_Cyrl` |
| Kyrgyz/Uzbek transfer boost | Optional fine-tuned `KAZ-LLM-8B` adapter |

---

## 10. References

- Meta AI. *No Language Left Behind: Scaling Human-Centered Machine Translation.* NLLB-200 model cards: [`nllb-200-3.3B`](https://huggingface.co/facebook/nllb-200-3.3B), [`nllb-200-distilled-1.3B`](https://huggingface.co/facebook/nllb-200-distilled-1.3B), [`nllb-200-distilled-600M`](https://huggingface.co/facebook/nllb-200-distilled-600M).
- Kudugunta et al. *MADLAD-400: A Multilingual And Document-Level Large Audited Dataset.* Models: [`google/madlad400-3b-mt`](https://huggingface.co/google/madlad400-3b-mt).
- Qwen team. *Qwen2.5 Technical Report.* [`Qwen/Qwen2.5-7B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct).
- Üstün et al. *Aya Model: An Instruction Finetuned Open-Access Multilingual Language Model.* [`CohereForAI/aya-101`](https://huggingface.co/CohereForAI/aya-101).
- Cohere For AI. *Aya Expanse* model card. [`CohereForAI/aya-expanse-8b`](https://huggingface.co/CohereForAI/aya-expanse-8b).
- ISSAI NU. *KAZ-LLM.* [`issai/Llama-3.1-KazLLM-1.0-8B`](https://huggingface.co/issai/Llama-3.1-KazLLM-1.0-8B).
- Arabov et al. *TajikNLP: An Open-Source Toolkit for Comprehensive Text Processing of Tajik.*
- LoResMT 2026 shared-task papers: Russian-Kyrgyz winning system (Novokshanov et al.); multi-pair Turkic paper (fine-tuned NLLB-600M + zero-shot LLM results).
- Tiltap STT cleanup report: [OpenWeight_LLM_for_STT_Cleanup_A4500.md](OpenWeight_LLM_for_STT_Cleanup_A4500.md).
