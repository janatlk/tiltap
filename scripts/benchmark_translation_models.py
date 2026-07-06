#!/usr/bin/env python3
"""Benchmark Kyrgyz -> Tajik translation across multiple cheap LLM providers.

Usage:
    # From YouTube URL
    python scripts/benchmark_translation_models.py \
        --youtube-url "https://www.youtube.com/watch?v=VIDEO_ID" \
        --output-dir logs/translation_benchmark

    # From existing audio file
    python scripts/benchmark_translation_models.py \
        --audio-file /tmp/my_video.wav \
        --output-dir logs/translation_benchmark

    # From existing transcript (skip STT)
    python scripts/benchmark_translation_models.py \
        --transcript-file logs/translation_benchmark/transcript.txt \
        --output-dir logs/translation_benchmark

Required environment variables:
    GROQ_API_KEY      - for Llama 3.3 70B baseline
    DEEPSEEK_API_KEY  - for DeepSeek-V3 (deepseek-chat)
    GEMINI_API_KEY    - for Gemini 1.5 Flash
    OPENAI_API_KEY    - optional, used for the LLM judge (can also use Groq judge)
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# ---------------------------------------------------------------------------
# Provider configs (cheap / fixed-price models only)
# ---------------------------------------------------------------------------

PROVIDERS = {
    "groq-llama": {
        "name": "Groq Llama 3.3 70B",
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "model": "llama-3.3-70b-versatile",
        "env_key": "GROQ_API_KEY",
        # Groq is free-tier friendly; real paid price is ~$0.59/M input, $0.79/M output
        "price": {"input": 0.0, "output": 0.0},
    },
    "deepseek": {
        "name": "DeepSeek-V3 (deepseek-chat)",
        "url": "https://api.deepseek.com/chat/completions",
        "model": "deepseek-chat",
        "env_key": "DEEPSEEK_API_KEY",
        "price": {"input": 0.14, "output": 0.28},
    },
    "gemini-flash": {
        "name": "Gemini 2.5 Flash",
        "url": None,  # special handling via Gemini API
        "model": "gemini-2.5-flash",
        "env_key": "GEMINI_API_KEY",
        "price": {"input": 0.15, "output": 0.60},
    },
    "openai-gpt4o-mini": {
        "name": "OpenAI GPT-4o mini",
        "url": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-4o-mini",
        "env_key": "OPENAI_API_KEY",
        "price": {"input": 0.15, "output": 0.60},
    },
    # OpenRouter free-tier models
    "openrouter-llama-3.3-70b": {
        "name": "OpenRouter Llama 3.3 70B (free)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "meta-llama/llama-3.3-70b-instruct:free",
        "env_key": "OPENROUTER_API_KEY",
        "price": {"input": 0.0, "output": 0.0},
        "extra_headers": {"HTTP-Referer": "https://tiltab.example.com", "X-Title": "TiltabBenchmark"},
    },
    "openrouter-hermes-405b": {
        "name": "OpenRouter Hermes 3 405B (free)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "nousresearch/hermes-3-llama-3.1-405b:free",
        "env_key": "OPENROUTER_API_KEY",
        "price": {"input": 0.0, "output": 0.0},
        "extra_headers": {"HTTP-Referer": "https://tiltab.example.com", "X-Title": "TiltabBenchmark"},
    },
    "openrouter-qwen3-next-80b": {
        "name": "OpenRouter Qwen3-Next 80B (free)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "qwen/qwen3-next-80b-a3b-instruct:free",
        "env_key": "OPENROUTER_API_KEY",
        "price": {"input": 0.0, "output": 0.0},
        "extra_headers": {"HTTP-Referer": "https://tiltab.example.com", "X-Title": "TiltabBenchmark"},
    },
    "openrouter-gemma-4-31b": {
        "name": "OpenRouter Gemma 4 31B (free)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "google/gemma-4-31b-it:free",
        "env_key": "OPENROUTER_API_KEY",
        "price": {"input": 0.0, "output": 0.0},
        "extra_headers": {"HTTP-Referer": "https://tiltab.example.com", "X-Title": "TiltabBenchmark"},
    },
    "openrouter-nemotron-120b": {
        "name": "OpenRouter Nemotron 3 Super 120B (free)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "nvidia/nemotron-3-super-120b-a12b:free",
        "env_key": "OPENROUTER_API_KEY",
        "price": {"input": 0.0, "output": 0.0},
        "extra_headers": {"HTTP-Referer": "https://tiltab.example.com", "X-Title": "TiltabBenchmark"},
    },
    "openrouter-gpt-oss-120b": {
        "name": "OpenRouter GPT-OSS 120B (free)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "openai/gpt-oss-120b:free",
        "env_key": "OPENROUTER_API_KEY",
        "price": {"input": 0.0, "output": 0.0},
        "extra_headers": {"HTTP-Referer": "https://tiltab.example.com", "X-Title": "TiltabBenchmark"},
    },
    "openrouter-free": {
        "name": "OpenRouter Free router",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "openrouter/free",
        "env_key": "OPENROUTER_API_KEY",
        "price": {"input": 0.0, "output": 0.0},
        "extra_headers": {"HTTP-Referer": "https://tiltab.example.com", "X-Title": "TiltabBenchmark"},
    },
}

JUDGE_PROVIDER = {
    "name": "OpenAI GPT-4o mini (judge)",
    "url": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4o-mini",
    "env_key": "OPENAI_API_KEY",
}

FFMPEG_PATH = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
PYTHON = sys.executable

LANGUAGE_NAMES = {
    "ky": "Kyrgyz",
    "uz": "Uzbek",
    "uz_cyrl": "Uzbek Cyrillic",
    "tg": "Tajik",
    "ru": "Russian",
    "en": "English",
    "auto": "Auto-detected",
}


# ---------------------------------------------------------------------------
# Translation prompt (mirrors src/services/translationService.ts)
# ---------------------------------------------------------------------------

def build_system_prompt(target_name: str, source_name: str | None) -> str:
    source_hint = f"from {source_name} into {target_name}" if source_name else f"into {target_name}"
    return (
        "You are a highly disciplined translator. Your sole task is to translate the SOURCE text "
        + source_hint
        + ".\n\n"
        + "The SOURCE text will be provided in the next user message inside <SOURCE></SOURCE> tags. "
        + "Follow these rules precisely:\n\n"
        + "1. Complete translation: translate every sentence and every word. Do not omit anything. "
        + "Do not leave any fragments in the source language.\n"
        + "2. Sentence-level fidelity: preserve the sentence structure of the source. "
        + "Do not merge two source sentences into one. Do not split one source sentence into several "
        + "unless the grammar of "
        + target_name
        + " absolutely requires it.\n"
        + "3. No additions or inferences: do not add explanations, headings, summaries, commentary, "
        + "or background information. Do not infer facts, emotions, judgements, or causes that are not "
        + "explicitly present in the source.\n"
        + "4. Preserve names and proper nouns: keep names of people, places, organizations, books, "
        + "brands, and abbreviations accurate. Use the established "
        + target_name
        + " form when one exists. "
        + "If no established form exists, transliterate consistently. Do not invent, shorten, "
        + "normalize, or replace names.\n"
        + "5. Consistent terminology: choose one target-language equivalent for each recurring term "
        + "and use it throughout the text. Do not switch synonyms arbitrarily.\n"
        + "6. Preserve tone and register: translate interviews as interviews, spoken style as spoken, "
        + "formal text as formal. Do not make the text more ideological, more emotional, or more literary "
        + "than the source.\n"
        + "7. Preserve repetitions: if the source repeats a phrase or question, keep the repetition. "
        + "Do not delete duplicates unless they are obvious speech-disfluency artifacts.\n"
        + "8. Numbers and dates: keep them exact and in the same order as the source.\n"
        + "9. Ambiguous or unclear words: translate literally rather than guessing or smoothing over.\n"
        + "10. Ideological neutrality: do not intensify, soften, or reframe meaning.\n\n"
        + "Output only the translation. No markdown, no XML tags, no code fences, no explanations."
    )


def build_messages(text: str, source_name: str, target_name: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": build_system_prompt(target_name, source_name)},
        {
            "role": "user",
            "content": f"<SOURCE>\n{text}\n</SOURCE>\n\nTranslate the SOURCE text exactly according to the rules above.",
        },
    ]


# ---------------------------------------------------------------------------
# Generic OpenAI-compatible chat completion
# ---------------------------------------------------------------------------

def chat_complete_openai(
    url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    max_tokens: int = 4096,
    temperature: float = 0.0,
    timeout: int = 180,
    extra_headers: dict[str, str] | None = None,
    retries: int = 2,
) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "TiltabBenchmark/1.0",
    }
    if extra_headers:
        headers.update(extra_headers)

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            last_error = e
            if e.code in (429, 503) and attempt < retries:
                wait = 2 ** attempt
                print(f"  -> {e.code} from provider, retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP Error {e.code}: {body[:200]}") from e
    raise last_error or RuntimeError("All retries failed")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data


def chat_complete_gemini(
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    max_tokens: int = 4096,
    temperature: float = 0.0,
    timeout: int = 180,
) -> dict[str, Any]:
    """Call Gemini REST API (OpenAI compatibility is still limited, use native endpoint)."""
    # Convert OpenAI-style messages to Gemini contents.
    system_parts = []
    contents = []
    for m in messages:
        if m["role"] == "system":
            system_parts.append({"text": m["content"]})
        else:
            contents.append({"role": "user", "parts": [{"text": m["content"]}]})

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        f"?key={api_key}"
    )
    body: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
        },
    }
    if system_parts:
        body["systemInstruction"] = {"parts": system_parts}

    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "TiltabBenchmark/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8"))

    # Normalize to OpenAI-like shape for downstream code.
    candidates = data.get("candidates", [])
    text_out = ""
    if candidates:
        parts = candidates[0].get("content", {}).get("parts", [])
        text_out = "\n".join(p.get("text", "") for p in parts)

    usage = data.get("usageMetadata", {})
    prompt_tokens = usage.get("promptTokenCount", 0)
    completion_tokens = usage.get("candidatesTokenCount", 0)
    return {
        "choices": [{"message": {"content": text_out}}],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
        "model": model,
    }


def translate_with_provider(
    provider_key: str, text: str, max_tokens: int = 4096, source_name: str = "Kyrgyz"
) -> dict[str, Any]:
    cfg = PROVIDERS[provider_key]
    api_key = os.environ.get(cfg["env_key"])
    if not api_key:
        raise RuntimeError(f"Missing {cfg['env_key']} for {cfg['name']}")

    messages = build_messages(text, source_name=source_name, target_name="Tajik")
    start = time.time()
    if provider_key == "gemini-flash":
        data = chat_complete_gemini(api_key, cfg["model"], messages, max_tokens=max_tokens)
    else:
        data = chat_complete_openai(
            cfg["url"],
            api_key,
            cfg["model"],
            messages,
            max_tokens=max_tokens,
            extra_headers=cfg.get("extra_headers"),
        )
    duration = time.time() - start

    content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    usage = data.get("usage", {})
    prompt_tok = usage.get("prompt_tokens", 0)
    completion_tok = usage.get("completion_tokens", 0)

    # Simple cost estimate.
    price = cfg["price"]
    cost_usd = (prompt_tok * price["input"] + completion_tok * price["output"]) / 1_000_000

    truncated = bool(max_tokens and completion_tok >= max_tokens)

    return {
        "provider": cfg["name"],
        "model": cfg["model"],
        "translation": content,
        "prompt_tokens": prompt_tok,
        "completion_tokens": completion_tok,
        "cost_usd": cost_usd,
        "time_s": round(duration, 2),
        "truncated": truncated,
    }


# ---------------------------------------------------------------------------
# Quality guard (mirror of translationService.detectTranslationIssues)
# ---------------------------------------------------------------------------

def detect_translation_issues(text: str) -> dict[str, Any]:
    flags = []
    trimmed = text.strip()
    if not trimmed:
        return {"is_suspicious": True, "flags": ["empty"]}

    words = re.split(r"\s+", trimmed.lower())
    words = [w for w in words if w]
    counts: dict[str, int] = {}
    for w in words:
        normalized = re.sub(r"^[^\w]+|[^\w]+$", "", w, flags=re.UNICODE)
        if not normalized:
            continue
        counts[normalized] = counts.get(normalized, 0) + 1

    if counts:
        top_word, top_count = max(counts.items(), key=lambda x: x[1])
        if top_count >= 5 and top_count / len(words) > 0.35:
            flags.append(f"repetition:{top_word}")

    tail_match = re.search(r"(\S{2,})(?:\s+\1){8,}\s*$", trimmed, re.IGNORECASE)
    if tail_match:
        flags.append(f"repeated-tail:{tail_match.group(1).lower()}")

    return {"is_suspicious": bool(flags), "flags": flags}


# ---------------------------------------------------------------------------
# LLM judge
# ---------------------------------------------------------------------------

def judge_translation(
    source_text: str,
    translation: str,
    judge_api_key: str,
    source_lang_name: str = "Kyrgyz",
    target_lang_name: str = "Tajik",
) -> dict[str, Any]:
    prompt = (
        f"You are an expert bilingual evaluator for {source_lang_name}-to-{target_lang_name} translation.\n"
        f"Evaluate the following translation of a {source_lang_name} text into {target_lang_name}.\n\n"
        f"Source {source_lang_name} text:\n<SOURCE>\n"
        + source_text
        + "\n</SOURCE>\n\n"
        + f"Candidate {target_lang_name} translation:\n<TARGET>\n"
        + translation
        + "\n</TARGET>\n\n"
        + "Score the translation from 0 to 100 on:\n"
        + "1. Accuracy (0-100): How well does it preserve the meaning of the source?\n"
        + f"2. Fluency (0-100): Is the {target_lang_name} grammatically correct and natural?\n"
        + "3. Completeness (0-100): Does it include all source content without omissions or hallucinations?\n\n"
        + "Return ONLY a JSON object in this exact format (no markdown, no explanation):\n"
        + '{"accuracy": <int>, "fluency": <int>, "completeness": <int>, "overall": <int>, "comments": "<brief critique>"}'
    )
    data = chat_complete_openai(
        JUDGE_PROVIDER["url"],
        judge_api_key,
        JUDGE_PROVIDER["model"],
        [{"role": "user", "content": prompt}],
        max_tokens=512,
        temperature=0.0,
    )
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    # Strip possible markdown fences.
    content = re.sub(r"^```json\s*|\s*```$", "", content, flags=re.MULTILINE).strip()
    try:
        scores = json.loads(content)
    except json.JSONDecodeError:
        scores = {"raw": content, "error": "judge JSON parse failed"}
    scores["judge_model"] = JUDGE_PROVIDER["model"]
    return scores


def pairwise_compare(
    source_text: str,
    translation_a: str,
    translation_b: str,
    judge_api_key: str,
    source_lang_name: str = "Kyrgyz",
    target_lang_name: str = "Tajik",
) -> dict[str, Any]:
    prompt = (
        f"You are an expert bilingual evaluator for {source_lang_name}-to-{target_lang_name} translation.\n"
        f"Compare two {target_lang_name} translations (A and B) of the same {source_lang_name} text.\n\n"
        f"Source {source_lang_name} text:\n<SOURCE>\n"
        + source_text
        + "\n</SOURCE>\n\n"
        + f"Translation A:\n<TARGET_A>\n"
        + translation_a
        + "\n</TARGET_A>\n\n"
        + f"Translation B:\n<TARGET_B>\n"
        + translation_b
        + "\n</TARGET_B>\n\n"
        + "Which translation is better overall considering accuracy, fluency, and completeness?\n"
        + 'Return ONLY JSON in this exact format: {"winner": "A|B|tie", "reason": "<one-sentence reason>"}'
    )
    data = chat_complete_openai(
        JUDGE_PROVIDER["url"],
        judge_api_key,
        JUDGE_PROVIDER["model"],
        [{"role": "user", "content": prompt}],
        max_tokens=256,
        temperature=0.0,
    )
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    content = re.sub(r"^```json\s*|\s*```$", "", content, flags=re.MULTILINE).strip()
    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        result = {"raw": content, "error": "pairwise JSON parse failed"}
    result["judge_model"] = JUDGE_PROVIDER["model"]
    return result


# ---------------------------------------------------------------------------
# Audio / STT helpers
# ---------------------------------------------------------------------------

def run_download_youtube(url: str, output_wav: str) -> None:
    script = os.path.join(ROOT, "download_youtube.py")
    cmd = [PYTHON, script, url, FFMPEG_PATH, output_wav]
    print(f"Downloading audio from YouTube: {url}")
    subprocess.run(cmd, check=True, stdout=sys.stdout, stderr=sys.stderr)


def run_transcribe(audio_path: str, language: str = "ky") -> dict[str, Any]:
    script = os.path.join(ROOT, "transcribe_hybrid.py")
    cmd = [PYTHON, script, audio_path, FFMPEG_PATH, language]
    print(f"Transcribing with local STT (language={language})...")
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Transcription failed: {proc.stderr[:2000]}")

    # Filter progress lines and take the last JSON line.
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip().startswith("{")]
    if not lines:
        raise RuntimeError("Transcription produced no JSON output")
    return json.loads(lines[-1])


def limit_transcript(text: str, max_chars: int | None, strategy: str = "head") -> str:
    if not max_chars or len(text) <= max_chars:
        return text
    if strategy == "head":
        return text[:max_chars].rsplit(".", 1)[0] + "."
    if strategy == "middle":
        start = len(text) // 2 - max_chars // 2
        return text[start : start + max_chars]
    return text[:max_chars]


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

def render_markdown(report: dict[str, Any]) -> str:
    source_lang_name = LANGUAGE_NAMES.get(report.get("source_lang", "ky"), report.get("source_lang", "ky"))
    target_lang_name = LANGUAGE_NAMES.get(report.get("target_lang", "tg"), report.get("target_lang", "tg"))
    lines = [
        f"# {source_lang_name} -> {target_lang_name} Translation Model Benchmark",
        "",
        f"**Source:** {report.get('source', 'unknown')}",
        f"**Language pair:** {source_lang_name} -> {target_lang_name}",
        f"**Max input chars:** {report.get('max_input_chars', 'full')}",
        f"**Judge:** {report.get('judge_model', 'none')}",
        "",
        f"## Source transcript ({source_lang_name})",
        "",
        "```",
        report.get("source_text", ""),
        "```",
        "",
        "## Results summary",
        "",
        "| Provider | Model | Time (s) | Cost ($) | Tokens (in/out) | Truncated | Quality flags |",
        "|----------|-------|----------|----------|-----------------|-----------|---------------|",
    ]
    for r in report.get("results", []):
        if "error" in r:
            lines.append(
                f"| {r['provider']} | {r['model']} | - | - | - | - | error: {r['error'][:60]} |"
            )
            continue
        flags = ", ".join(r.get("quality", {}).get("flags", [])) or "ok"
        lines.append(
            f"| {r['provider']} | {r['model']} | {r['time_s']} | {r['cost_usd']:.4f} | "
            f"{r['prompt_tokens']}/{r['completion_tokens']} | {r['truncated']} | {flags} |"
        )

    lines += ["", "## Scores (LLM judge)", "", "| Provider | Accuracy | Fluency | Completeness | Overall | Comments |", "|----------|----------|---------|--------------|---------|----------|"]
    for r in report.get("results", []):
        if "error" in r:
            lines.append(f"| {r['provider']} | - | - | - | - | {r['error'][:60]} |")
            continue
        scores = r.get("judge_scores", {})
        lines.append(
            f"| {r['provider']} | {scores.get('accuracy', 'N/A')} | {scores.get('fluency', 'N/A')} | "
            f"{scores.get('completeness', 'N/A')} | {scores.get('overall', 'N/A')} | {scores.get('comments', '')[:80]} |"
        )

    pairwise = report.get("pairwise", {})
    if pairwise:
        lines += ["", f"## Pairwise comparison vs {target_lang_name} baseline", ""]
        for key, val in pairwise.items():
            lines.append(f"- **{key}**: winner={val.get('winner', '?')}, reason={val.get('reason', '')}")

    lines += ["", "## Full translations", ""]
    for r in report.get("results", []):
        lines += [f"### {r['provider']} ({r['model']})", "", "```"]
        if "error" in r:
            lines += [f"ERROR: {r['error']}"]
        else:
            lines += [r["translation"]]
        lines += ["```", ""]

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Benchmark Ky->Tg translation models")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--youtube-url", help="YouTube URL to download and transcribe")
    group.add_argument("--audio-file", help="Existing audio file path")
    group.add_argument("--transcript-file", help="Existing Kyrgyz transcript text file")
    parser.add_argument("--stt-language", default="auto", help="STT language passed to transcribe_hybrid.py (default: auto)")
    parser.add_argument("--source-lang", default="ky", help="Source language code (ky, uz, ru, en)")
    parser.add_argument("--target-lang", default="tg", help="Target language code (default: tg)")
    parser.add_argument("--output-dir", default="logs/translation_benchmark", help="Output directory")
    parser.add_argument("--max-input-chars", type=int, default=None, help="Limit source text length")
    parser.add_argument("--max-tokens", type=int, default=4096, help="max_tokens for each translation")
    parser.add_argument(
        "--providers",
        default="groq-llama,deepseek,gemini-flash",
        help="Comma-separated provider keys to test",
    )
    parser.add_argument(
        "--judge-provider",
        default="groq-llama",
        choices=["openai-gpt4o-mini", "groq-llama"],
        help="Provider to use as LLM judge",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # -----------------------------------------------------------------------
    # 1. Obtain source text
    # -----------------------------------------------------------------------
    if args.transcript_file:
        raw = Path(args.transcript_file).read_text(encoding="utf-8").strip()
        # Accept either plain text or a JSON transcript produced by transcribe_hybrid.py.
        if raw.startswith("{"):
            transcript = json.loads(raw)
            source_text = transcript.get("text", "")
        else:
            source_text = raw
        source_desc = f"transcript:{args.transcript_file}"
    else:
        if args.youtube_url:
            audio_path = str(output_dir / "source_audio.wav")
            run_download_youtube(args.youtube_url, audio_path)
        else:
            audio_path = args.audio_file

        transcript_path = output_dir / "transcript.json"
        transcript = run_transcribe(audio_path, language=args.stt_language)
        if args.stt_language == "ky" and not transcript.get("text", "").strip():
            print("Kyrgyz Vosk produced empty transcript; falling back to Whisper auto-detect...")
            transcript = run_transcribe(audio_path, language="auto")
        transcript_path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
        source_text = transcript.get("text", "")
        source_desc = f"youtube:{args.youtube_url}" if args.youtube_url else f"audio:{audio_path}"

    if not source_text.strip():
        raise RuntimeError("Source transcript is empty")

    source_text = limit_transcript(source_text, args.max_input_chars)
    print(f"Source text length: {len(source_text)} chars")

    source_lang_name = LANGUAGE_NAMES.get(args.source_lang, args.source_lang)
    target_lang_name = LANGUAGE_NAMES.get(args.target_lang, args.target_lang)

    # -----------------------------------------------------------------------
    # 2. Configure judge
    # -----------------------------------------------------------------------
    global JUDGE_PROVIDER
    if args.judge_provider == "groq-llama":
        JUDGE_PROVIDER = {
            "name": "Groq Llama 3.3 70B (judge)",
            "url": "https://api.groq.com/openai/v1/chat/completions",
            "model": "llama-3.3-70b-versatile",
            "env_key": "GROQ_API_KEY",
        }

    judge_key = os.environ.get(JUDGE_PROVIDER["env_key"])
    if not judge_key:
        print(f"Warning: {JUDGE_PROVIDER['env_key']} not set, skipping LLM judge scoring", file=sys.stderr)

    # -----------------------------------------------------------------------
    # 3. Run translations
    # -----------------------------------------------------------------------
    provider_keys = [p.strip() for p in args.providers.split(",") if p.strip()]
    results: list[dict[str, Any]] = []
    for pk in provider_keys:
        if pk not in PROVIDERS:
            print(f"Skipping unknown provider: {pk}", file=sys.stderr)
            continue
        print(f"\nTranslating with {PROVIDERS[pk]['name']} ...")
        try:
            res = translate_with_provider(pk, source_text, max_tokens=args.max_tokens, source_name=source_lang_name)
            res["quality"] = detect_translation_issues(res["translation"])
            if judge_key:
                print("  -> judging ...")
                res["judge_scores"] = judge_translation(
                    source_text, res["translation"], judge_key, source_lang_name, target_lang_name
                )
            results.append(res)
            print(f"  done: {res['time_s']}s, {res['completion_tokens']} tokens, ${res['cost_usd']:.4f}")
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)
            results.append({
                "provider": PROVIDERS[pk]["name"],
                "model": PROVIDERS[pk]["model"],
                "error": str(e),
            })

    # -----------------------------------------------------------------------
    # 4. Pairwise comparisons against Llama baseline
    # -----------------------------------------------------------------------
    pairwise: dict[str, Any] = {}
    if judge_key:
        baseline_result = next((r for r in results if "translation" in r and "error" not in r), None)
        if baseline_result:
            baseline_name = baseline_result["provider"].split("(")[0].strip()
            for r in results:
                if r is baseline_result or "translation" not in r:
                    continue
                key = f"{r['provider']} vs {baseline_name}"
                print(f"\nPairwise: {key}")
                pairwise[key] = pairwise_compare(
                    source_text,
                    r["translation"],
                    baseline_result["translation"],
                    judge_key,
                    source_lang_name,
                    target_lang_name,
                )
                print(f"  winner: {pairwise[key].get('winner')}")

    # -----------------------------------------------------------------------
    # 5. Save report
    # -----------------------------------------------------------------------
    report = {
        "source": source_desc,
        "source_lang": args.source_lang,
        "target_lang": args.target_lang,
        "source_text": source_text,
        "max_input_chars": args.max_input_chars,
        "judge_model": JUDGE_PROVIDER["model"] if judge_key else None,
        "results": results,
        "pairwise": pairwise,
    }
    json_path = output_dir / "benchmark_report.json"
    md_path = output_dir / "benchmark_report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"\nReport saved to:\n  {json_path}\n  {md_path}")
    print("\n" + render_markdown(report))


if __name__ == "__main__":
    main()
