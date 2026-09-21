#!/usr/bin/env python3
"""Хранитель cookies YouTube: держит живую сессию в настоящем Chrome и
раз в несколько часов выгружает из неё свежие cookies для yt-dlp.

Зачем. Выгруженный вручную файл cookies — снимок: через месяц Google меняет
сессию, и снимок перестаёт действовать. Живой браузер получает новые cookies
незаметно. Поэтому держим на сервере профиль Chrome с входом в аккаунт и
регулярно открываем в нём YouTube — сессия продлевается, а мы забираем её.

Вход в аккаунт делает человек: страница админки показывает окно этого Chrome
(Xvfb + x11vnc + noVNC), пароль вводится там. Сервис паролей не видит.

Отдельный процесс под своим пользователем (ytkeeper), порт 127.0.0.1:8030.
Прод читает результат через символьную ссылку data/youtube_cookies.txt ->
/var/lib/ytkeeper/youtube_cookies.txt. Кобальт не трогаем: две программы,
каждая по-своему продлевающая одну сессию, губят её для обеих.
"""
import json
import os
import shutil
import signal
import subprocess
import threading
import time

import requests
from fastapi import FastAPI, HTTPException, Request

PROD = os.environ.get("KEEPER_PROD_URL", "http://127.0.0.1:3000")
HOME = os.environ.get("KEEPER_HOME", "/var/lib/ytkeeper")
PROFILE = os.path.join(HOME, "chrome-profile")
OUTPUT = os.path.join(HOME, "youtube_cookies.txt")
STATE = os.path.join(HOME, "state.json")
CHROME = os.environ.get("KEEPER_CHROME", "/usr/bin/google-chrome")
PROXY = os.environ.get("KEEPER_PROXY", "socks5://127.0.0.1:40000")
YTDLP_HELPER = os.environ.get("KEEPER_YTDLP_HELPER", "/opt/tiltap/youtube_ytdlp.py")
CHECK_URL = os.environ.get("KEEPER_CHECK_URL", "https://www.youtube.com/watch?v=jNQXAC9IVRw")
REFRESH_HOURS = float(os.environ.get("KEEPER_REFRESH_HOURS", "6"))
SESSION_MAX_MIN = int(os.environ.get("KEEPER_SESSION_MAX_MIN", "30"))
DISPLAY = ":99"

os.makedirs(HOME, exist_ok=True)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
lock = threading.Lock()          # профиль Chrome в каждый момент у кого-то одного
session = {"procs": [], "started": 0.0}


# --- Состояние ---------------------------------------------------------------

def load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(**fields) -> dict:
    state = load_state()
    state.update(fields)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, STATE)
    return state


# --- Доступ ------------------------------------------------------------------

_auth_cache: dict = {}


def is_admin(cookie: str) -> bool:
    if not cookie:
        return False
    if _auth_cache.get(cookie, 0) > time.time():
        return True
    try:
        data = requests.get(PROD + "/api/dataset/session", headers={"Cookie": cookie}, timeout=10).json()
    except Exception:
        return False
    ok = bool(data.get("authenticated")) and (data.get("annotator") or {}).get("role") == "super_admin"
    if ok:
        _auth_cache[cookie] = time.time() + 60
    return ok


def require_admin(request: Request) -> None:
    if not is_admin(request.headers.get("cookie", "")):
        raise HTTPException(401, "unauthorized")


# --- Chrome ------------------------------------------------------------------

def chrome_args(extra: list) -> list:
    return [
        CHROME, f"--user-data-dir={PROFILE}", "--password-store=basic",
        "--no-first-run", "--no-default-browser-check", "--disable-sync",
        f"--proxy-server={PROXY}", "--lang=ru-RU", *extra,
    ]


def stop(proc: subprocess.Popen, grace: float = 15) -> None:
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)   # Chrome по SIGTERM дописывает cookies на диск
    try:
        proc.wait(grace)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(5)


def session_active() -> bool:
    return any(p.poll() is None for p in session["procs"])


def start_session(fresh: bool) -> None:
    if session_active():
        return
    if not lock.acquire(timeout=120):
        raise HTTPException(409, "busy")
    try:
        if fresh and os.path.isdir(PROFILE):
            shutil.rmtree(PROFILE)
        env = dict(os.environ, DISPLAY=DISPLAY)
        xvfb = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1280x860x24", "-nolisten", "tcp"])
        time.sleep(1.5)
        chrome = subprocess.Popen(
            chrome_args(["--start-maximized", "--window-size=1280,860",
                         "https://accounts.google.com/ServiceLogin?continue=https://www.youtube.com/"]),
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        vnc = subprocess.Popen(["x11vnc", "-display", DISPLAY, "-rfbport", "5901", "-localhost",
                                "-nopw", "-forever", "-shared", "-quiet"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ws = subprocess.Popen(["websockify", "127.0.0.1:6080", "127.0.0.1:5901"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Порядок важен при остановке: сначала Chrome (дописать cookies), экран последним.
        session["procs"] = [chrome, ws, vnc, xvfb]
        session["started"] = time.time()
    except Exception:
        for p in session["procs"]:
            stop(p, 3)
        session["procs"] = []
        lock.release()
        raise


def end_session() -> None:
    if not session["procs"]:
        return
    for p in session["procs"]:
        stop(p)
    session["procs"] = []
    lock.release()


def warm_up() -> None:
    """Открыть YouTube в профиле без экрана, чтобы Google продлил сессию."""
    proc = subprocess.Popen(chrome_args(["--headless=new", "--window-size=1280,860", "https://www.youtube.com/"]),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(45)
    stop(proc)


# --- Выгрузка и проверка -----------------------------------------------------

def export_cookies(path: str) -> int:
    from yt_dlp.cookies import extract_cookies_from_browser
    jar = extract_cookies_from_browser("chrome", PROFILE, keyring="BASICTEXT")
    keep = [c for c in jar if c.domain.endswith(("youtube.com", "google.com"))]
    jar.clear()
    for c in keep:
        jar.set_cookie(c)
    jar.save(path, ignore_discard=True, ignore_expires=True)
    os.chmod(path, 0o600)
    return len(keep)


def check_cookies(path: str) -> tuple:
    env = dict(os.environ, TILTAB_YTDLP_COOKIES=path)
    try:
        r = subprocess.run(["python3", YTDLP_HELPER, "--check-cookies", CHECK_URL],
                           capture_output=True, text=True, timeout=240, env=env)
        data = json.loads(r.stdout.strip().splitlines()[-1])
        return data.get("status", "unknown"), data.get("detail", "")
    except Exception as exc:
        return "unknown", str(exc)[:200]


def account_of(path: str) -> str:
    """Какой аккаунт вошёл: Google отдаёт список аккаунтов сессии по её cookies."""
    try:
        r = subprocess.run(["curl", "-s", "-m", "30", "--socks5-hostname", PROXY.split("://", 1)[1], "-b", path,
                            "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard"],
                           capture_output=True, text=True, timeout=40)
        data = json.loads(r.stdout)
        accounts = data[1] if isinstance(data, list) and len(data) > 1 else []
        return accounts[0][3] if accounts else ""
    except Exception:
        return ""


def refresh(warm: bool = True) -> dict:
    """Продлить сессию, выгрузить cookies, проверить и только тогда отдать проду."""
    if not os.path.isdir(PROFILE):
        return save_state(lastRefresh=time.time(), lastResult="no_profile", lastDetail="Вход в аккаунт не выполнен")
    if warm:
        warm_up()
    tmp = OUTPUT + ".new"
    try:
        count = export_cookies(tmp)
    except Exception as exc:
        return save_state(lastRefresh=time.time(), lastResult="export_failed", lastDetail=str(exc)[:300])
    status, detail = check_cookies(tmp)
    account = account_of(tmp)
    if status == "valid":
        os.replace(tmp, OUTPUT)
        return save_state(lastRefresh=time.time(), lastResult="ok", lastDetail=f"{count} cookies",
                          lastValidAt=time.time(), account=account or load_state().get("account", ""))
    os.remove(tmp)
    # Старый файл не трогаем: если проверка споткнулась о сеть, он ещё рабочий.
    return save_state(lastRefresh=time.time(), lastResult=status, lastDetail=detail, account=account)


def refresh_locked(warm: bool = True) -> dict:
    if not lock.acquire(blocking=False):
        return save_state(lastDetail="Пропущено: профиль занят (открыт вход)")
    try:
        return refresh(warm)
    finally:
        lock.release()


def scheduler() -> None:
    time.sleep(120)
    while True:
        if session_active() and time.time() - session["started"] > SESSION_MAX_MIN * 60:
            end_session()   # забытое окно входа не держит профиль вечно
        if time.time() - load_state().get("lastRefresh", 0) > REFRESH_HOURS * 3600 and not session_active():
            refresh_locked()
        time.sleep(60)


# --- API ---------------------------------------------------------------------

@app.get("/auth")
def auth(request: Request):
    """Для nginx auth_request: пускать ли к окну браузера."""
    require_admin(request)
    return {"ok": True}


@app.get("/status")
def status(request: Request):
    require_admin(request)
    state = load_state()
    return {
        **state,
        "profile": os.path.isdir(PROFILE),
        "sessionActive": session_active(),
        "sessionStarted": session["started"] if session_active() else None,
        "sessionMaxMinutes": SESSION_MAX_MIN,
        "refreshHours": REFRESH_HOURS,
        "outputExists": os.path.isfile(OUTPUT),
        "now": time.time(),
    }


@app.post("/session/start")
async def post_session_start(request: Request):
    require_admin(request)
    body = await request.json()
    start_session(bool(body.get("fresh")))
    return {"ok": True}


@app.post("/session/finish")
def post_session_finish(request: Request):
    require_admin(request)
    if not session_active():
        raise HTTPException(409, "no_session")
    end_session()
    return refresh_locked(warm=False)


@app.post("/session/cancel")
def post_session_cancel(request: Request):
    require_admin(request)
    end_session()
    return {"ok": True}


@app.post("/refresh")
def post_refresh(request: Request):
    require_admin(request)
    if session_active():
        raise HTTPException(409, "session_active")
    return refresh_locked()


@app.post("/logout")
def post_logout(request: Request):
    require_admin(request)
    end_session()
    with lock:
        shutil.rmtree(PROFILE, ignore_errors=True)
    return save_state(account="", lastResult="logged_out", lastDetail="Профиль удалён")


@app.on_event("startup")
def on_startup():
    threading.Thread(target=scheduler, daemon=True).start()
