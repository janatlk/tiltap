#!/usr/bin/env python3
"""Лаборатория субтитров: видео по ссылке или файлом -> расшифровка -> перевод
-> правка -> субтитры, вшитые в видео.

Отдельный процесс, намеренно отделённый от прода:

  * свой порт (127.0.0.1:8020), своя папка с данными, свой systemd-юнит с
    урезанными процессором и памятью — упадёт или зависнет только он;
  * к проду обращается лишь через его публичный HTTP API, как обычный
    посетитель сайта: /api/web/transcribe и /api/web/translate. Код прода не
    меняется, и работа лаборатории проходит через ту же очередь, что и чужая;
  * видео качает и хранит сам. Прод получает только звуковую дорожку в пару
    мегабайт, потому что распознаванию картинка не нужна.

Доступ — только супер-админу: сессию проверяем у прода по тем же cookie.
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

PROD = os.environ.get("LAB_PROD_URL", "http://127.0.0.1:3000")
COBALT = os.environ.get("LAB_COBALT_URL", "http://127.0.0.1:9010/")
DATA = os.environ.get("LAB_DATA_DIR", "/opt/tiltap-lab/jobs")
YTDLP = os.environ.get("LAB_YTDLP_BIN", "yt-dlp")
YTDLP_PROXY = os.environ.get("LAB_YTDLP_PROXY", "socks5://127.0.0.1:40000")
YT_COOKIES = os.environ.get("LAB_YT_COOKIES", "/opt/tiltap/data/youtube_cookies.txt")
FONT = os.environ.get("LAB_FONT", "DejaVu Sans")  # покрывает ө ү ң ҳ ҷ ӯ
FFMPEG_THREADS = os.environ.get("LAB_FFMPEG_THREADS", "3")

MAX_BYTES = int(os.environ.get("LAB_MAX_MB", "500")) * 1024 * 1024
MAX_SECONDS = int(os.environ.get("LAB_MAX_MINUTES", "30")) * 60
KEEP_HOURS = int(os.environ.get("LAB_KEEP_HOURS", "48"))
# Одна длинная реплика на экране не читается: режем на титры не длиннее этого.
CUE_MAX_CHARS = 84
CUE_MAX_SECONDS = 6.0

LANGS = {"auto", "ky", "tg", "uz", "ru", "en"}
TARGETS = {"ky", "tg", "uz", "uz_cyrl", "ru", "en"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_EXT = {".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac"}

os.makedirs(DATA, exist_ok=True)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# Тяжёлая работа (скачивание, ffmpeg) идёт строго по одной: лаборатория не
# должна отъедать у прода больше одного "пользователя".
work_lock = threading.Lock()
state_lock = threading.Lock()


# --- Хранилище заданий -------------------------------------------------------

def job_dir(job_id: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(404, "not_found")
    return os.path.join(DATA, job_id)


def load(job_id: str) -> dict:
    path = os.path.join(job_dir(job_id), "job.json")
    if not os.path.isfile(path):
        raise HTTPException(404, "not_found")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(job: dict) -> None:
    d = job_dir(job["id"])
    tmp = os.path.join(d, "job.json.tmp")
    with state_lock:
        job["updatedAt"] = time.time()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False)
        os.replace(tmp, os.path.join(d, "job.json"))


def update(job: dict, **fields) -> None:
    job.update(fields)
    save(job)


def new_job(kind: str, source_lang: str, target_lang: str, **extra) -> dict:
    job_id = uuid.uuid4().hex
    os.makedirs(os.path.join(DATA, job_id))
    job = {
        "id": job_id, "kind": kind, "sourceLang": source_lang, "targetLang": target_lang,
        "status": "queued", "stage": "В очереди", "percent": 0, "error": None,
        "cues": [], "hasVideo": True, "output": False, "createdAt": time.time(), **extra,
    }
    save(job)
    return job


def cleanup_old() -> None:
    cutoff = time.time() - KEEP_HOURS * 3600
    for name in os.listdir(DATA):
        path = os.path.join(DATA, name)
        if os.path.isdir(path) and os.path.getmtime(path) < cutoff:
            shutil.rmtree(path, ignore_errors=True)


def fail_interrupted() -> None:
    """После перезапуска ничего "идущего" уже не идёт — честно так и пишем."""
    for name in os.listdir(DATA):
        try:
            job = load(name)
        except Exception:
            continue
        if job["status"] in ("queued", "downloading", "transcribing", "translating", "rendering"):
            update(job, status="failed", error="Прервано перезапуском лаборатории")


# --- Доступ ------------------------------------------------------------------

_session_cache: dict = {}


def require_admin(request: Request) -> None:
    cookie = request.headers.get("cookie", "")
    if not cookie:
        raise HTTPException(401, "unauthorized")
    cached = _session_cache.get(cookie)
    if cached and cached > time.time():
        return
    try:
        r = requests.get(PROD + "/api/dataset/session", headers={"Cookie": cookie}, timeout=10)
        data = r.json()
    except Exception:
        raise HTTPException(503, "prod_unreachable")
    if not data.get("authenticated") or (data.get("annotator") or {}).get("role") != "super_admin":
        raise HTTPException(401, "unauthorized")
    _session_cache[cookie] = time.time() + 60


# --- Шаги конвейера ------------------------------------------------------------

def run(cmd: list, timeout: int = 3600) -> subprocess.CompletedProcess:
    # nice поверх ограничений юнита: при споре за процессор уступаем проду.
    return subprocess.run(["nice", "-n", "15"] + cmd, capture_output=True, text=True, timeout=timeout)


def probe(path: str) -> dict:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
             "-of", "json", path], timeout=60)
    if r.returncode != 0:
        raise RuntimeError("Не удалось прочитать файл: это не аудио и не видео?")
    info = json.loads(r.stdout)
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and s.get("width")), None)
    return {
        "duration": float(info.get("format", {}).get("duration") or 0),
        "hasVideo": video is not None,
        "hasAudio": any(s.get("codec_type") == "audio" for s in streams),
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
    }


def stream_to_file(resp: requests.Response, path: str, job: dict) -> int:
    total = int(resp.headers.get("content-length") or 0)
    got = 0
    last = 0.0
    with open(path, "wb") as f:
        for chunk in resp.iter_content(1024 * 256):
            got += len(chunk)
            if got > MAX_BYTES:
                raise RuntimeError(f"Видео больше {MAX_BYTES // 1024 // 1024} МБ")
            f.write(chunk)
            if time.time() - last > 1.5:
                last = time.time()
                mb = got / 1024 / 1024
                pct = int(got * 100 / total) if total else 0
                update(job, stage=f"Скачиваю видео: {mb:.0f} МБ", percent=min(pct, 99))
    return got


def download_cobalt(url: str, out: str, job: dict) -> None:
    r = requests.post(COBALT, json={"url": url, "downloadMode": "auto", "videoQuality": "720"},
                      headers={"Accept": "application/json"}, timeout=90)
    data = r.json()
    if data.get("status") == "picker":
        items = [i for i in data.get("picker", []) if i.get("type") == "video"]
        if not items:
            raise RuntimeError("По ссылке нет видео")
        media_url = items[0]["url"]
    elif data.get("status") in ("tunnel", "redirect"):
        media_url = data["url"]
    else:
        raise RuntimeError("cobalt: " + str((data.get("error") or {}).get("code") or data))
    # Кобальт отдаёт внешний адрес туннеля; сами мы стоим рядом с ним.
    media_url = re.sub(r"^https?://[^/]+:9011/", COBALT, media_url)
    with requests.get(media_url, stream=True, timeout=(30, 300)) as resp:
        resp.raise_for_status()
        if stream_to_file(resp, out, job) < 1024:
            raise RuntimeError("cobalt отдал пустой файл")


def download_ytdlp(url: str, workdir: str, job: dict) -> str:
    template = os.path.join(workdir, "ytdlp.%(ext)s")
    cmd = [YTDLP, "--no-warnings", "--no-playlist", "--remote-components", "ejs:github",
           "--js-runtimes", "node:/usr/bin/node",
           "-f", "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b", "--merge-output-format", "mp4",
           "--max-filesize", str(MAX_BYTES), "-o", template]
    if YTDLP_PROXY:
        cmd += ["--proxy", YTDLP_PROXY]
    cookies_copy = None
    if ("youtube.com" in url or "youtu.be" in url) and os.path.isfile(YT_COOKIES):
        # Копия: yt-dlp переписывает файл cookies, а мастер-сессию держит кобальт.
        cookies_copy = os.path.join(workdir, "cookies.txt")
        shutil.copyfile(YT_COOKIES, cookies_copy)
        cmd += ["--cookies", cookies_copy]
    update(job, stage="Скачиваю видео (запасной способ)", percent=0)
    r = run(cmd + [url], timeout=1800)
    if cookies_copy:
        os.remove(cookies_copy)
    files = [f for f in os.listdir(workdir) if f.startswith("ytdlp.") and not f.endswith(".part")]
    if r.returncode != 0 or not files:
        tail = (r.stderr or "").strip().splitlines()[-1:] or ["неизвестная ошибка"]
        raise RuntimeError("yt-dlp: " + tail[0][:300])
    return os.path.join(workdir, files[0])


def extract_audio(src: str, out: str) -> None:
    r = run(["ffmpeg", "-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "libopus", "-b:a", "24k", out], timeout=1800)
    if r.returncode != 0:
        raise RuntimeError("Не удалось извлечь звук: " + r.stderr[-300:])


def transcribe_via_prod(audio: str, source_lang: str, job: dict) -> list:
    with open(audio, "rb") as f:
        r = requests.post(PROD + "/api/web/transcribe",
                          files={"file": ("audio.ogg", f, "audio/ogg")},
                          data={"sourceLang": source_lang, "targetLang": "none"}, timeout=120)
    if r.status_code != 202:
        raise RuntimeError(f"Прод не принял звук: {r.status_code} {r.text[:200]}")
    prod_job = r.json()["jobId"]
    update(job, prodJobId=prod_job)
    deadline = time.time() + 3 * 3600
    while time.time() < deadline:
        time.sleep(3)
        s = requests.get(f"{PROD}/api/web/jobs/{prod_job}", timeout=30).json()
        progress = s.get("progress") or {}
        label = str(progress.get("label") or "")
        if label.startswith("queued:"):
            label = f"В очереди прода: {label.split(':', 1)[1]}"
        update(job, stage="Распознаю речь" + (f": {label}" if label else ""),
               percent=int(progress.get("percent") or 0))
        if s.get("status") == "completed":
            result = s.get("result") or {}
            if result.get("language"):
                job["detectedLang"] = result["language"]
            return result.get("segments") or []
        if s.get("status") == "failed":
            raise RuntimeError("Распознавание не удалось: " + str(s.get("error")))
    raise RuntimeError("Распознавание не уложилось в 3 часа")


def split_segment(seg: dict) -> list:
    """Длинную реплику делим на титры по словам, время — пропорционально длине."""
    text = " ".join(str(seg.get("text") or "").split())
    start, end = float(seg.get("start") or 0), float(seg.get("end") or 0)
    if not text or end <= start:
        return []
    parts = max(1, int(-(-len(text) // CUE_MAX_CHARS)), int(-(-(end - start) // CUE_MAX_SECONDS)))
    if parts == 1:
        return [{"start": start, "end": end, "text": text}]
    words = text.split(" ")
    target = len(text) / parts
    chunks, cur = [], []
    for w in words:
        cur.append(w)
        if len(" ".join(cur)) >= target and len(chunks) < parts - 1:
            chunks.append(" ".join(cur))
            cur = []
    if cur:
        chunks.append(" ".join(cur))
    cues, t = [], start
    for c in chunks:
        dur = (end - start) * len(c) / len(text)
        cues.append({"start": round(t, 3), "end": round(t + dur, 3), "text": c})
        t += dur
    cues[-1]["end"] = end
    return cues


def translate_via_prod(texts: list, source_lang: str, target_lang: str) -> list:
    def call(text: str) -> str:
        r = requests.post(PROD + "/api/web/translate", json={
            "text": text, "sourceLang": source_lang or "auto", "targetLang": target_lang, "sourceType": "web",
        }, timeout=600)
        if r.status_code != 200:
            raise RuntimeError(f"Перевод не удался: {r.status_code} {r.text[:200]}")
        return r.json().get("translatedText") or ""

    # Одним текстом переводится связнее, чем репликами по отдельности. Реплики
    # разделяем пустой строкой: переводчик прода обязан сохранять абзацы. Если
    # число абзацев не сошлось, соответствие потеряно — тогда по одной.
    joined = call("\n\n".join(texts))
    parts = [p.strip() for p in re.split(r"\n\s*\n", joined.strip()) if p.strip()]
    if len(parts) == len(texts):
        return parts
    return [call(t) if t.strip() else "" for t in texts]


def ass_time(t: float) -> str:
    cs = int(round(max(t, 0) * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def ass_escape(text: str) -> str:
    # Невидимый разделитель после обратной черты не даёт libass принять текст
    # за команду вроде \N, а фигурная скобка открывала бы блок тегов.
    text = text.replace("\\", "\\⁠").replace("{", "(").replace("}", ")")
    return text.replace("\r", "").replace("\n", "\\N")


def write_ass(cues: list, path: str, mode: str, width: int, height: int) -> None:
    size = max(18, round(height * 0.052))
    small = max(14, round(size * 0.8))
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Main,{FONT},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,"
        f"{max(2, size // 12)},1,2,{width // 20},{width // 20},{round(height * 0.06)},1",
        f"Style: Orig,{FONT},{small},&H00D8D8D8,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,"
        f"{max(2, small // 12)},1,8,{width // 20},{width // 20},{round(height * 0.05)},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for c in cues:
        main = c.get("translation") if mode in ("translation", "both") else c.get("text")
        if mode == "translation" and not (main or "").strip():
            main = c.get("text")
        if (main or "").strip():
            lines.append(f"Dialogue: 0,{ass_time(c['start'])},{ass_time(c['end'])},Main,,0,0,0,,{ass_escape(main.strip())}")
        if mode == "both" and (c.get("text") or "").strip():
            lines.append(f"Dialogue: 0,{ass_time(c['start'])},{ass_time(c['end'])},Orig,,0,0,0,,{ass_escape(c['text'].strip())}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def render(job: dict) -> None:
    d = job_dir(job["id"])
    src = os.path.join(d, job["sourceFile"])
    ass = os.path.join(d, "subs.ass")
    tmp = os.path.join(d, "output.tmp.mp4")
    out = os.path.join(d, "output.mp4")
    w, h = (job.get("width") or 1280), (job.get("height") or 720)
    # Нечётные размеры libx264 не принимает; заодно не раздуваем выше 1080p.
    if h > 1080:
        w, h = round(w * 1080 / h), 1080
    w, h = w - w % 2, h - h % 2
    write_ass(job["cues"], ass, job.get("renderMode", "translation"), w, h)

    if job["hasVideo"]:
        inputs = ["-i", src]
        vf = f"scale={w}:{h},ass={ass}"
        maps = ["-map", "0:v:0", "-map", "0:a:0?"]
    else:
        # Для голого звука рисуем тёмный фон: субтитрам нужна картинка.
        inputs = ["-f", "lavfi", "-i", f"color=c=0x15171c:s={w}x{h}:r=25", "-i", src]
        vf = f"ass={ass}"
        maps = ["-map", "0:v:0", "-map", "1:a:0", "-shortest"]
    cmd = ["nice", "-n", "15", "ffmpeg", "-y", "-v", "error", "-progress", "pipe:1", "-nostats", *inputs,
           "-vf", vf, *maps, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
           "-threads", FFMPEG_THREADS, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp]
    duration = float(job.get("duration") or 0)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    last = 0.0
    for line in proc.stdout:
        if line.startswith("out_time_us=") and duration > 0 and time.time() - last > 1.5:
            last = time.time()
            try:
                done = int(line.split("=", 1)[1]) / 1e6
            except ValueError:
                continue
            update(job, stage="Накладываю субтитры", percent=min(99, int(done * 100 / duration)))
    err = proc.stderr.read()
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg: " + err[-400:])
    os.replace(tmp, out)


# --- Фоновые задания -----------------------------------------------------------

def background(fn, job_id: str) -> None:
    def runner():
        job = load(job_id)
        with work_lock:
            try:
                fn(job)
            except Exception as exc:  # noqa: BLE001 — любой сбой должен дойти до страницы
                update(job, status="failed", error=str(exc)[:500])
    threading.Thread(target=runner, daemon=True).start()


def pipeline(job: dict) -> None:
    d = job_dir(job["id"])
    if job["kind"] == "link":
        update(job, status="downloading", stage="Скачиваю видео", percent=0)
        target = os.path.join(d, "source.mp4")
        try:
            download_cobalt(job["url"], target, job)
            src = target
        except Exception as exc:
            job["downloadNote"] = f"cobalt не справился ({str(exc)[:150]}), пробую yt-dlp"
            if os.path.exists(target):
                os.remove(target)
            src = download_ytdlp(job["url"], d, job)
        job["sourceFile"] = os.path.basename(src)

    info = probe(os.path.join(d, job["sourceFile"]))
    if not info["hasAudio"]:
        raise RuntimeError("В файле нет звуковой дорожки")
    if info["duration"] > MAX_SECONDS:
        raise RuntimeError(f"Длительность больше {MAX_SECONDS // 60} минут — пока не берём")
    job.update(duration=info["duration"], hasVideo=info["hasVideo"], width=info["width"], height=info["height"])

    update(job, status="transcribing", stage="Готовлю звук", percent=0)
    audio = os.path.join(d, "audio.ogg")
    extract_audio(os.path.join(d, job["sourceFile"]), audio)
    segments = transcribe_via_prod(audio, job["sourceLang"], job)
    cues = [c for s in segments for c in split_segment(s)]
    if not cues:
        raise RuntimeError("Речь не распознана")
    for c in cues:
        c["translation"] = ""
    update(job, cues=cues)

    if job.get("targetLang"):
        translate_cues(job)
    update(job, status="ready", stage="Готово к правке", percent=100)


def translate_cues(job: dict) -> None:
    update(job, status="translating", stage="Перевожу", percent=0)
    source = job.get("detectedLang") or job["sourceLang"]
    texts = [c["text"] for c in job["cues"]]
    translated = translate_via_prod(texts, source if source in LANGS else "auto", job["targetLang"])
    for c, t in zip(job["cues"], translated):
        c["translation"] = t
    save(job)


def retranslate(job: dict) -> None:
    translate_cues(job)
    update(job, status="ready", stage="Готово к правке", percent=100)


def do_render(job: dict) -> None:
    update(job, status="rendering", stage="Накладываю субтитры", percent=0, output=False)
    render(job)
    update(job, status="done", stage="Видео готово", percent=100, output=True)


# --- API -----------------------------------------------------------------------

def public(job: dict) -> dict:
    return {k: v for k, v in job.items() if k not in ("sourceFile",)}


def check_langs(source_lang: str, target_lang: str) -> str:
    if source_lang not in LANGS:
        raise HTTPException(400, "bad_source_lang")
    target = "" if target_lang in ("", "none") else target_lang
    if target and target not in TARGETS:
        raise HTTPException(400, "bad_target_lang")
    return target


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/jobs")
def list_jobs(request: Request):
    require_admin(request)
    cleanup_old()
    jobs = []
    for name in os.listdir(DATA):
        try:
            j = load(name)
        except Exception:
            continue
        jobs.append({k: j.get(k) for k in ("id", "kind", "url", "filename", "status", "createdAt", "output")})
    jobs.sort(key=lambda j: j["createdAt"], reverse=True)
    return {"jobs": jobs[:30]}


@app.post("/jobs/link")
async def create_link(request: Request):
    require_admin(request)
    body = await request.json()
    url = str(body.get("url") or "").strip()
    if not re.match(r"^https?://", url):
        raise HTTPException(400, "bad_url")
    target = check_langs(str(body.get("sourceLang") or "auto"), str(body.get("targetLang") or ""))
    job = new_job("link", str(body.get("sourceLang") or "auto"), target, url=url)
    background(pipeline, job["id"])
    return public(job)


@app.post("/jobs/upload")
def create_upload(request: Request, file: UploadFile = File(...), sourceLang: str = Form("auto"),
                  targetLang: str = Form("")):
    require_admin(request)
    target = check_langs(sourceLang, targetLang)
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in VIDEO_EXT | AUDIO_EXT:
        raise HTTPException(400, "unsupported_file")
    job = new_job("upload", sourceLang, target, filename=file.filename)
    path = os.path.join(job_dir(job["id"]), "source" + ext)
    size = 0
    with open(path, "wb") as out:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                out.close()
                shutil.rmtree(job_dir(job["id"]), ignore_errors=True)
                raise HTTPException(413, "too_large")
            out.write(chunk)
    update(job, sourceFile=os.path.basename(path))
    background(pipeline, job["id"])
    return public(job)


@app.get("/jobs/{job_id}")
def get_job(job_id: str, request: Request):
    require_admin(request)
    return public(load(job_id))


BUSY = ("queued", "downloading", "transcribing", "translating", "rendering")


@app.put("/jobs/{job_id}/cues")
async def put_cues(job_id: str, request: Request):
    require_admin(request)
    job = load(job_id)
    if job["status"] in BUSY:
        raise HTTPException(409, "busy")
    body = await request.json()
    cues = body.get("cues")
    if not isinstance(cues, list) or len(cues) != len(job["cues"]):
        raise HTTPException(400, "bad_cues")
    for old, new in zip(job["cues"], cues):
        old["text"] = str(new.get("text") or "")[:500]
        old["translation"] = str(new.get("translation") or "")[:500]
    save(job)
    return {"ok": True}


@app.post("/jobs/{job_id}/translate")
async def post_translate(job_id: str, request: Request):
    require_admin(request)
    job = load(job_id)
    if job["status"] in BUSY or not job["cues"]:
        raise HTTPException(409, "busy")
    body = await request.json()
    target = check_langs("auto", str(body.get("targetLang") or ""))
    if not target:
        raise HTTPException(400, "bad_target_lang")
    update(job, targetLang=target)
    background(retranslate, job_id)
    return public(job)


@app.post("/jobs/{job_id}/render")
async def post_render(job_id: str, request: Request):
    require_admin(request)
    job = load(job_id)
    if job["status"] in BUSY or not job["cues"]:
        raise HTTPException(409, "busy")
    body = await request.json()
    mode = str(body.get("mode") or "translation")
    if mode not in ("translation", "original", "both"):
        raise HTTPException(400, "bad_mode")
    update(job, renderMode=mode)
    background(do_render, job_id)
    return public(job)


@app.get("/jobs/{job_id}/output.mp4")
def get_output(job_id: str, request: Request):
    require_admin(request)
    path = os.path.join(job_dir(job_id), "output.mp4")
    if not os.path.isfile(path):
        raise HTTPException(404, "not_ready")
    return FileResponse(path, media_type="video/mp4", filename=f"tiltap-subtitles-{job_id[:8]}.mp4")


@app.get("/jobs/{job_id}/subs.srt")
def get_srt(job_id: str, request: Request, mode: str = "translation"):
    require_admin(request)
    job = load(job_id)

    def t(x: float) -> str:
        ms = int(round(x * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"

    blocks = []
    for i, c in enumerate(job["cues"], 1):
        text = (c.get("translation") if mode == "translation" else c.get("text")) or c.get("text") or ""
        blocks.append(f"{i}\n{t(c['start'])} --> {t(c['end'])}\n{text.strip()}\n")
    return JSONResponse({"srt": "\n".join(blocks)})


@app.on_event("startup")
def on_startup():
    fail_interrupted()
    cleanup_old()
