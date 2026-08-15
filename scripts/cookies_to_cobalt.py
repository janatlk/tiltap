#!/usr/bin/env python3
"""Перекладывает куки YouTube из формата yt-dlp в формат Cobalt.

Экспорт из браузера делается один раз, в файл Netscape — его понимает yt-dlp.
Cobalt хочет своё: {"youtube": ["name=value; name=value; ..."]}. Раньше это
означало два ручных экспорта, а значит два шанса забыть про второй — и потом
искать, почему один движок жив, а второй просит войти.

Значения не печатаются никуда: это действующая сессия аккаунта.

    python3 scripts/cookies_to_cobalt.py <cookies.txt> <cookies.json>
"""
import io
import json
import os
import shutil
import stat
import sys

# Cobalt подставляет эти куки к запросам к YouTube. Служебные ST-* и метрики
# не нужны: они короткоживущие и только раздувают заголовок.
SKIP_PREFIXES = ("ST-",)


def read_netscape(path):
    cookies = []
    seen = set()
    with io.open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 7:
                continue
            domain, _flag, _path, _secure, _expiry, name, value = parts[:7]
            if "youtube.com" not in domain:
                continue
            if name.startswith(SKIP_PREFIXES):
                continue
            # Последнее значение побеждает: экспорт иногда содержит дубли.
            if name in seen:
                cookies = [c for c in cookies if not c.startswith(name + "=")]
            seen.add(name)
            cookies.append("{}={}".format(name, value))
    return cookies


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    cookies = read_netscape(src)
    if not cookies:
        print("В файле нет куки youtube.com — ничего не записано", file=sys.stderr)
        return 1

    required = {"SID", "__Secure-1PSID", "__Secure-3PSID"}
    present = {c.split("=", 1)[0] for c in cookies}
    missing = required - present
    if missing:
        # Без них Cobalt получит от YouTube "войдите в аккаунт", а мы узнаем об
        # этом только через полчаса из тревоги.
        print("Внимание: не хватает ключевых куки: {}".format(", ".join(sorted(missing))), file=sys.stderr)

    if os.path.exists(dst):
        shutil.copyfile(dst, dst + ".bak")

    payload = {"youtube": ["; ".join(cookies)]}
    with io.open(dst, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2))
    # Cobalt дописывает в этот файл сам, поэтому оставляем его доступным
    # владельцу и группе, но не всему миру.
    os.chmod(dst, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)

    print("Записано куки: {} (файл {})".format(len(cookies), dst))
    return 0


if __name__ == "__main__":
    sys.exit(main())
