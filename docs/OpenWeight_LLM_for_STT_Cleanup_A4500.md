# Отчёт: выбор open-weight LLM для пост-обработки (cleanup) STT на RunPod GPU (RTX A4500 16 ГБ)

**Цель:** выбрать одну лучшую открытую генеративную модель для исправления ошибок распознавания речи (hallucinations, repetitions, script leakage, переключения языка) для **узбекского (uz)**, **кыргызского (ky)** и **таджикского (tg)** языков. Модель должна работать на том же серверном GPU, что и существующий Tiltap GPU worker, либо на отдельном аналогичном RunPod endpoint.

**Аппаратная платформа:** NVIDIA RTX A4500, **16 ГБ VRAM**, серверный бессерверный worker на RunPod.

**Дата:** 2026-07-07.

> **TL;DR — единственная рекомендация**
> - **Лучшая модель для наших языков:** `CohereForAI/aya-101` (13B, encoder-decoder T5, Apache 2.0). Она единственная среди доступных open-weight моделей, которая была явно instruction-tuned на кыргызском, таджикском и узбекском.
> - **Рекомендуемый формат развёртывания:** отдельный RunPod serverless endpoint с моделью в 4-битной квантизации BitsAndBytes (или конвертированной в CTranslate2 INT8, если хватает VRAM). Это даёт ~7.5–8 ГБ VRAM и не мешает STT-worker.
> - **Если cleanup обязательно должен жить на том же A4500 вместе с Whisper/CT2:** используйте `Qwen/Qwen2.5-7B-Instruct-AWQ` (~4.5 ГБ VRAM, Apache 2.0). Покрытие наших языков хуже, зато остаётся запас для Whisper, VAD и KV-cache.
> - **Не рекомендуются:** Aya Expanse 8B (CC-BY-NC, всего 23 языка, нет ky/tg/uz), Llama 3.1/3.2 (нет наших языков), Qwen3.5-27B (не влезает в 16 ГБ с запасом).

---

## 1. Что именно должен делать cleanup-модуль

После локального STT (`transcribe_hybrid.py` / GPU worker) текст часто содержит:

| Тип ошибки | Пример (ky) | Пример (tg) | Пример (uz) |
|------------|-------------|-------------|-------------|
| Повторы / зацикливание | `бул бул бул киши ...` | `ин ин ин инчунин ...` | `bu bu bu kishi ...` |
| Галлюцинации / шум | `[музыка]`, `ахх`, `эмм` | `[аплодисменты]`, арабские вкрапления | `[music]`, латинские слова |
| Утечка скрипта | кириллица в латинице, латиница в кириллице | арабская письменность вместо таджикской кириллицы | латиница в кириллице |
| Ошибки от Whisper byte-tokens | `Ð±Ñ<93>Ð»` вместо `бул` | — | — |
| Код-свитчинг | вкрапления русских/английских слов | переключение на персидскую/русскую лексику | русские/английские вставки |
| Пропуск / вставка знаков препинания | длинная непрерывная строка | отсутствие точек | отсутствие точек |

Cleanup — **это не перевод**. Модель должна:
1. Удалить явный мусор и повторы.
2. Исправить скриптовые утечки (например, арабская письменность → таджикская кириллица).
3. Сохранить имена собственные, числа, факты и смысл.
4. Не добавлять информацию, которой не было в транскрипции.
5. Вернуть текст на том же языке, на котором говорил спикер.

Поэтому инструкция (prompt) и температурный режим важнее размера модели.

---

## 2. Аппаратные ограничения

| Конфигурация | Примерный VRAM | Оценка |
|--------------|----------------|--------|
| Whisper-large-v3-turbo CT2 int8 | ~2.5–3.5 ГБ | уже используется на GPU worker |
| kyrgyz-whisper-small CT2 int8 | ~2–3 ГБ | используется для ky |
| rubai-ct2-int8 (uz) | ~1.5–2 ГБ | используется для uz |
| Silero VAD + оверхед CUDA | ~0.5–1 ГБ | постоянно |
| **Свободно под LLM на том же worker** | **~6–8 ГБ** | верхняя граница без риска OOM |
| **Свободно на отдельном endpoint A4500** | **~13–14 ГБ** | можно загружать 13B модели с запасом |

**Вывод:** если LLM cleanup размещается внутри существующего STT-worker, выбор ограничен моделями до ~7–8B параметров в 4-битной квантизации. Если разворачивать отдельный endpoint, можно поднять 13B модель в 4-bit.

---

## 3. Требования к языковому покрытию

| Язык | Скрипт | Семья | Особенности, важные для cleanup |
|------|--------|-------|---------------------------------|
| **Кыргызский (ky)** | кириллица | тюркская | Агглютинативный, гармония гласных, много русских заимствований. Whisper иногда путает кыргызский с казахским/турецким или выдаёт турецкие/казахские формы. |
| **Таджикский (tg)** | кириллица | иранская (персидская) | Близок к дари/фарси, но на кириллице. Частая утечка арабской/персидской письменности. Есть специфические таджикские нормы (эзофе, `ро`/`кӣ`/`ӣ`). |
| **Узбекский (uz)** | кириллица / латиница | тюркская | В Tiltap используется кириллический выход Rubai-модели. Модель должна сохранять кириллицу и не «переводить» узбекские слова в казахские/кыргызские. |
| Русский (ru), английский (en) | кириллица / латиница | — | Встречаются в код-свитчинге; cleanup не должен удалять осмысленные вставки. |

Ключевой критерий: модель должна **быть знакома с morphosyntax и script norms** целевых языков, иначе она начнёт «исправлять» кыргызские слова под казахские/турецкие или писать таджикские слова арабицей.

---

## 4. Рассмотренные кандидаты

### 4.1 `CohereForAI/aya-101` (13B, T5) — основная рекомендация

| Параметр | Значение |
|----------|----------|
| Архитектура | encoder-decoder T5 (mT5-XXL) |
| Параметры | 13B |
| Лицензия | **Apache 2.0** |
| Языки | **101 язык**, включая **ky, tg, uz** (явно в списке тренировочных) |
| Инструкционный fine-tuning | Да (xP3x, Aya Collection, синтетика) |
| Квантизация | BitsAndBytes 4-bit (~7.5–8 ГБ VRAM) или CTranslate2 INT8 (~13 ГБ) |

**Почему лучший выбор для cleanup:**
- Единственная массово мультиязычная open-weight модель, которая действительно видела кыргызский, таджикский и узбекский во время instruction tuning.
- Encoder-decoder T5 удобен для «text-to-text transformation»: задача cleanup формулируется как «исправь ошибки в тексте» — естественный формат для T5.
- Apache 2.0 разрешает коммерческое использование.

**Недостатки:**
- 13B требует 4-bit на A4500.
- Не такой быстрый, как Qwen2.5-7B-AWQ.
- Меньше экосистемных тулов, чем у decoder-only моделей (нельзя просто `vllm serve`), но CTranslate2 и transformers поддерживают T5.

### 4.2 `Qwen/Qwen2.5-7B-Instruct-AWQ` — резерв для колокации

| Параметр | Значение |
|----------|----------|
| Архитектура | decoder-only GPT |
| Параметры | 7B |
| Лицензия | Apache 2.0 |
| Языки | 29+ (ru, en, zh, ar, tr, fa и др.); **uz/ky/tg не заявлены** |
| VRAM AWQ INT4 | ~4.5 ГБ |

**Плюсы:**
- Очень компактный, быстрый, отлично работает с vLLM/llama.cpp.
- Сильная инструкционная дисциплина, JSON mode, длинный контекст.
- Идеально вписывается в VRAM-бюджет существующего STT-worker.

**Минусы:**
- Не видел наши языки явно; качество cleanup будет зависеть от transfer learning.
- Может «переводить» или «исправлять» кыргызские/узбекские слова в более знакомые турецкие/казахские формы.

### 4.3 `Qwen/Qwen3.5-9B-Instruct-AWQ` — альтернатива Qwen2.5

| Параметр | Значение |
|----------|----------|
| Параметры | 9B |
| Лицензия | Apache 2.0 |
| Языки | 201 язык/диалект (вероятно, включает uz/ky/tg) |
| VRAM AWQ INT4 | ~5.5–6 ГБ |

**Плюсы:** более свежая, более мультиязычная, чем Qwen2.5; влезает в тот же VRAM-бюджет.

**Минусы:** пока меньше продакшен-отчётов; 9B всё ещё меньше, чем Aya-101, и явного заявления о трёх языках нет.

### 4.4 `CohereForAI/aya-expanse-8b` — **не подходит**

- Поддерживает только **23 языка** (ar, zh, cs, nl, en, fr, de, el, he, hi, id, it, ja, ko, fa, pl, pt, ro, ru, es, tr, uk, vi).
- **Кыргызский, таджикский, узбекский отсутствуют.**
- Лицензия **CC-BY-NC** (некоммерческая).

### 4.5 `meta-llama/Llama-3.1-8B-Instruct` / `Llama-3.2-3B` — **не подходят**

- Официально поддерживают ~8 языков, наши три отсутствуют.
- Без domain-specific fine-tuning качество cleanup для ky/tg/uz будет низким.

### 4.6 `Qwen/Qwen3.5-27B-Instruct-AWQ` / Q4_K_M GGUF — **не подходит для A4500**

- 27B в AWQ/Q4 занимает ~15–17 ГБ VRAM.
- На A4500 16 ГБ не остаётся места под KV-cache и STT-модели; риск OOM и долгих cold start.
- Если когда-нибудь перейдёте на 24+ ГБ GPU — стоит пересмотреть.

### 4.7 NLLB / MADLAD — не для cleanup

- NLLB и MADLAD — модели машинного перевода, а не генеративные LLM.
- Их можно использовать для перевода, но не для исправления STT-ошибок на том же языке.

---

## 5. Сравнительная таблица

| Модель | Параметры | Языки | Лицензия | VRAM (рекомендуемый формат) | Подходит для cleanup ky/tg/uz | Подходит для колокации со STT |
|--------|-----------|-------|----------|------------------------------|-------------------------------|-------------------------------|
| **Aya-101** | 13B | 101, **включая ky/tg/uz** | Apache 2.0 | ~7.5–8 ГБ (BitsAndBytes 4-bit) | ✅ Лучший выбор | ⚠️ только на отдельном endpoint |
| **Qwen2.5-7B-Instruct-AWQ** | 7B | 29+, не заявлены | Apache 2.0 | ~4.5 ГБ | ⚠️ transfer learning | ✅ |
| **Qwen3.5-9B-Instruct-AWQ** | 9B | 201+, вероятно | Apache 2.0 | ~5.5–6 ГБ | ⚠️ transfer learning | ✅ |
| **Qwen2.5-14B-Instruct-AWQ** | 14B | 29+ | Apache 2.0 | ~9 ГБ | ⚠️ transfer learning | ❌ тесно |
| **Aya Expanse 8B** | 8B | 23, нет ky/tg/uz | CC-BY-NC | ~5 ГБ | ❌ | — |
| **Llama 3.1/3.2** | 8B/3B | ~8, нет ky/tg/uz | Llama 3.1 license | ~5 ГБ | ❌ | — |
| **Qwen3.5-27B** | 27B | 201+ | Apache 2.0 | ~16 ГБ Q4 | ⚠️ | ❌ |

---

## 6. Архитектурная рекомендация

### Рекомендуемый вариант: отдельный RunPod endpoint для cleanup

```
Telegram/Web → Backend (Hetzner)
       ↓
GPU STT endpoint (tiltap-gpu-stt) → raw transcript
       ↓
GPU Cleanup endpoint (tiltap-gpu-cleanup) → cleaned text
       ↓
Translation service (опционально) → target language
       ↓
User
```

**Почему отдельный endpoint:**
1. **VRAM:** STT и LLM не делят одну и ту же память — можно использовать Aya-101 4-bit с запасом.
2. **Масштабирование:** можно независимо менять `workersMax`, таймауты и образы.
3. **Cold start:** LLM грузится только тогда, когда нужен cleanup, не замедляя STT.
4. **Отказоустойчивость:** если cleanup падает, STT всё равно возвращает raw transcript.

### Альтернативный вариант: встроить cleanup в существующий GPU worker

Если хочется избежать второго endpoint, выбирайте **Qwen2.5-7B-Instruct-AWQ** и загружайте её внутри `handler.py` по требованию (lazy load). После STT вызывайте cleanup для каждого chunk/сегмента. Риск: OOM при длинных аудио, когда Whisper уже занимает много VRAM.

---

## 7. Пример развёртывания Aya-101 на RunPod serverless

### 7.1 Dockerfile

```dockerfile
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/models/hf_cache

RUN apt-get update && apt-get install -y \
    python3-pip python3-dev git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Модель будет закеширована при первом старте или скачана заранее в Network Volume
COPY handler.py .

CMD ["python3", "-u", "handler.py"]
```

### 7.2 requirements.txt

```text
torch>=2.3.0
transformers>=4.40.0
accelerate>=0.30.0
bitsandbytes>=0.43.0
sentencepiece>=0.2.0
protobuf>=3.20.0
runpod>=1.6.0
```

### 7.3 handler.py (упрощённый прототип)

```python
import os
import json
import torch
import runpod
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer, BitsAndBytesConfig

MODEL_NAME = os.getenv("CLEANUP_MODEL", "CohereForAI/aya-101")
MAX_INPUT_CHARS = int(os.getenv("CLEANUP_MAX_INPUT_CHARS", "1500"))
MAX_NEW_TOKENS = int(os.getenv("CLEANUP_MAX_NEW_TOKENS", "512"))

# 4-bit quantization keeps VRAM around 7.5–8 GB on A4500
bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,
)

tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForSeq2SeqLM.from_pretrained(
    MODEL_NAME,
    quantization_config=bnb_config,
    device_map="auto",
    torch_dtype=torch.bfloat16,
)


def build_prompt(text: str, lang: str) -> str:
    """Aya-101 is instruction-tuned T5; a plain instruction works best."""
    return (
        f"Correct the automatic speech recognition errors in the following {lang} text. "
        "Remove repetitions, hallucinations, and noise markers. "
        "Fix script leakage (e.g. Arabic/Persian script must become Tajik Cyrillic). "
        "Preserve names, numbers, and meaning. Do not add information. "
        "Return only the corrected text.\n\n"
        f"Raw transcript:\n{text}\n\n"
        "Corrected transcript:"
    )


def clean_text(text: str, lang: str) -> str:
    if not text or not text.strip():
        return text
    prompt = build_prompt(text[:MAX_INPUT_CHARS], lang)
    inputs = tokenizer(
        prompt,
        return_tensors="pt",
        max_length=MAX_INPUT_CHARS + 256,
        truncation=True,
    ).to(model.device)

    outputs = model.generate(
        **inputs,
        max_new_tokens=MAX_NEW_TOKENS,
        do_sample=False,
        num_beams=2,
        early_stopping=True,
    )
    decoded = tokenizer.decode(outputs[0], skip_special_tokens=True)
    # Aya may echo the prefix; strip it defensively
    if "Corrected transcript:" in decoded:
        decoded = decoded.split("Corrected transcript:")[-1]
    return decoded.strip()


def handler(event):
    job_input = event.get("input", {})
    text = job_input.get("text", "")
    lang = job_input.get("lang", "ky")  # ky, tg, uz

    cleaned = clean_text(text, lang)

    return {
        "cleaned": cleaned,
        "lang": lang,
        "model": MODEL_NAME,
    }


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
```

### 7.4 Вызов из Node.js backend

```typescript
const cleanupResponse = await fetch(RUNPOD_CLEANUP_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.RUNPOD_CLEANUP_API_KEY}`,
  },
  body: JSON.stringify({
    input: {
      text: rawTranscript,
      lang: sourceLang, // 'ky' | 'tg' | 'uz'
    },
  }),
});
```

### 7.5 Примечание по CTranslate2 (опционально, если VRAM позволяет)

Если разворачиваете Aya-101 на отдельном A4500 и хотите максимальную скорость, можно сконвертировать её в CTranslate2 INT8:

```bash
ct2-transformers-converter --model CohereForAI/aya-101 \
  --output_dir /models/aya-101-ct2-int8 \
  --quantization int8_float16
```

CTranslate2 для T5 обычно даёт ~13 ГБ VRAM на 13B модели; это допустимо только на отдельном endpoint без Whisper.

---

## 8. Промпт-инженерия для cleanup

### 8.1 Базовый system prompt (для decoder-only Qwen)

```text
You are an STT post-processing assistant. Your task is to clean up automatic speech recognition output.
Rules:
1. Remove repetitions, filler words, and noise markers such as [music], [applause], [unintelligible].
2. Fix script leakage: output must be in the same script as the original language.
3. Preserve proper names, numbers, dates, and factual content exactly.
4. Do not translate, summarize, or add information not present in the transcript.
5. Keep the language of the speaker. Do not switch to Russian, Turkish, or English unless those words were actually spoken.
6. Return ONLY the cleaned text, no explanations.
```

### 8.2 Пример few-shot для кыргызского

```text
Raw: бул бул бул киши эртең келет деп жатат
Cleaned: бул киши эртең келет деп жатат

Raw: [музыка] биз биз мектепке барабыз
Cleaned: биз мектепке барабыз

Raw: Бул ÐºÐ¸ÑˆÐ¸ эмне кылат?
Cleaned: Бул киши эмне кылат?

Raw: {raw}
Cleaned:
```

### 8.3 Температура и параметры генерации

| Параметр | Рекомендуемое значение | Почему |
|----------|------------------------|--------|
| `temperature` | 0.0 | cleanup — детерминистичная задача; сэмплинг вредит. |
| `num_beams` | 1–2 | увеличивает качество без существенного замедления. |
| `max_new_tokens` | 1.2× от длины входа | достаточно, чтобы переписать текст. |
| `repetition_penalty` | 1.0–1.1 | помогает против зацикливания. |

---

## 9. Как оценить качество cleanup

Метрики:

| Метрика | Как считать | Цель |
|---------|-------------|------|
| **CER/WER reduction** | Сравнить raw STT и cleaned text с reference transcript. | Уменьшение CER/WER ≥ 10–20%. |
| **chrF++** | Используется для low-resource языков; менее чувствительна к токенизации. | Рост относительно raw. |
| **Language identity** | Проверить, что cleaned text на том же языке (langdetect/fasttext). | > 95% совпадений. |
| **Script correctness** | Доля символов в правильном скрипте (кириллица для ky/tg/uz). | > 98% кириллицы. |
| **Human side-by-side** | 100–200 сэмплов на каждом языке. | Win-rate cleanup vs raw. |
| **Hallucination rate** | Частота добавленных имен, чисел, фактов. | < 2%. |

Рекомендуемый минимальный тестовый набор:
- 50 фрагментов для каждого языка с типичными STT-ошибками.
- 10% коротких фраз (< 5 слов), 50% средних предложений, 40% длинных реплик.
- Примеры с код-свитчингом и скриптовыми утечками.

---

## 10. Риски и митигация

| Риск | Митигация |
|------|-----------|
| LLM добавляет информацию / меняет смысл | Строгий prompt, low temperature, few-shot, fallback на raw text, если cleaned слишком отличается. |
| LLM переключает язык вывода | Явно указывать язык в prompt; post-check langdetect; fallback. |
| LLM не влезает в VRAM | 4-bit quantization, отдельный endpoint, кап контекста. |
| Долгий cold start | Закешировать модель в Network Volume; bake в Docker-образ; warm pool (workersMin > 0) в RunPod. |
| 4-bit портит качество | Провести A/B с FP16/INT8 на отдельном GPU; если нужно — перейти на отдельный endpoint с INT8. |
| License conflict | Использовать Apache 2.0 модели (Aya-101, Qwen2.5/3.5, MADLAD); избегать CC-BY-NC. |

---

## 11. Итоговая матрица решений

| Приоритет | Рекомендация | Модель | Где разворачивать |
|-----------|--------------|--------|-------------------|
| **Лучшее понимание ky/tg/uz** | Aya-101 4-bit | `CohereForAI/aya-101` | Отдельный RunPod endpoint |
| **Совместное размещение со STT** | Qwen2.5-7B-AWQ | `Qwen/Qwen2.5-7B-Instruct-AWQ` | Внутри STT-worker или отдельный endpoint |
| **Баланс скорость + языковое покрытие** | Qwen3.5-9B-AWQ | `Qwen/Qwen3.5-9B-Instruct-AWQ` | Внутри STT-worker |
| **Максимальное качество в будущем** | Qwen3.5-27B-AWQ / GGUF | `Qwen/Qwen3.5-27B-Instruct` | Только на GPU ≥ 24 ГБ |
| **Не использовать** | Aya Expanse 8B, Llama 3.1/3.2 | — | — |

---

## 12. Следующие шаги

1. **Провести A/B тест на реальных STT-выходах.** Взять 100–200 сэмплов ky/tg/uz, прогнать через Aya-101 4-bit и Qwen2.5-7B-AWQ, сравнить CER/WER/chrF++.
2. **Собрать Dockerfile + handler** для выбранной модели, собрать образ на Hetzner, запушить в Docker Hub.
3. **Создать отдельный RunPod template/endpoint** `tiltap-gpu-cleanup`, привязать образ, настроить `workersMax=1`.
4. **Добавить backend route** `/api/cleanup` (или вызов из `transcriptionService.ts`), который отправляет raw transcript в cleanup endpoint.
5. **Реализовать fallback:** если cleanup endpoint недоступен или ответ пустой/подозрительный — вернуть raw transcript.
6. **Обновить `AGENTS.md`** и `.env.example` переменными `RUNPOD_CLEANUP_URL`, `RUNPOD_CLEANUP_API_KEY`, `TILTAB_CLEANUP_MODEL`.

---

## 13. Исправления по сравнению с предыдущим отчётом

- `CohereForAI/aya-101` лицензируется под **Apache 2.0**, а не CC-BY-NC.
- `Aya Expanse 8B` лицензируется под **CC-BY-NC** и поддерживает только 23 языка; для ky/tg/uz не подходит.
- `Aya-101` — это **T5 encoder-decoder**, поэтому её нельзя просто запустить через `vllm serve`; оптимальные пути: `transformers` + BitsAndBytes 4-bit или CTranslate2 INT8.
- `NLLB` остаётся рекомендуемым переводчиком, но **не подходит** для cleanup на том же языке.
