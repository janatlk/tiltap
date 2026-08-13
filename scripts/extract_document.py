#!/usr/bin/env python3
"""Извлечение переводимого текста из документа.

Возвращает JSON с "единицами перевода" и всем, что нужно, чтобы собрать файл
обратно. Разделение на единицы важнее, чем кажется: у таблицы или субтитров
переводить надо только содержимое ячеек и реплик, а разделители, номера и
тайм-коды обязаны остаться нетронутыми — иначе файл перестанет быть файлом.

Форматы, где структура значит не меньше текста (csv, tsv, srt, vtt), собираются
обратно в свой формат. Остальные отдаются простым текстом: вернуть .docx с
исходной вёрсткой — отдельная большая работа, и обещать её здесь нечестно.

Вывод:
  {"format": "docx", "structured": false, "units": ["..."], "meta": {...},
   "chars": 1234, "warning": "..."}
"""

import argparse
import csv
import io
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

# Текст в OOXML лежит в этих элементах; пространство имён у каждого формата своё.
OOXML_TEXT_TAGS = {
    "docx": "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t",
    "pptx": "{http://schemas.openxmlformats.org/drawingml/2006/main}t",
}
ODF_TEXT_NS = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"


def read_text_file(path: str) -> str:
    """Читает текстовый файл, определяя кодировку.

    Файлы из наших краёв часто в Windows-1251, и прочитанные как UTF-8 они
    превращаются в "Ïðèâåò" — перевести это невозможно, а выглядит как поломка
    перевода, а не чтения.
    """
    raw = open(path, "rb").read()
    try:
        from charset_normalizer import from_bytes

        best = from_bytes(raw).best()
        if best:
            return str(best)
    except Exception:  # noqa: BLE001
        pass
    for encoding in ("utf-8", "cp1251", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Структурные форматы: собираются обратно в себя же
# ---------------------------------------------------------------------------

def extract_csv(path: str, delimiter: str) -> dict:
    text = read_text_file(path)
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    units, positions = [], []
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            value = cell.strip()
            # Числа, даты и пустые ячейки переводить нечего, а модель может их
            # ещё и испортить.
            if value and not re.fullmatch(r"[\d\s.,:%+\-/()]+", value):
                units.append(cell)
                positions.append([r, c])
    return {
        "structured": True,
        "units": units,
        "meta": {"rows": rows, "positions": positions, "delimiter": delimiter},
    }


def extract_srt(path: str) -> dict:
    text = read_text_file(path).replace("\r\n", "\n")
    blocks = re.split(r"\n\s*\n", text.strip())
    units, meta_blocks = [], []
    for block in blocks:
        lines = block.split("\n")
        # Номер, тайм-код, затем реплика. Первые две строки трогать нельзя.
        head, body = [], []
        for line in lines:
            if not body and (re.fullmatch(r"\d+", line.strip()) or "-->" in line):
                head.append(line)
            else:
                body.append(line)
        if body:
            units.append("\n".join(body))
        meta_blocks.append({"head": head, "has_body": bool(body)})
    return {"structured": True, "units": units, "meta": {"blocks": meta_blocks, "kind": "srt"}}


def extract_vtt(path: str) -> dict:
    result = extract_srt(path)
    result["meta"]["kind"] = "vtt"
    return result


# ---------------------------------------------------------------------------
# Документы: отдаются текстом
# ---------------------------------------------------------------------------

def extract_ooxml(path: str, kind: str) -> dict:
    """docx и pptx: текст лежит в XML внутри zip, распаковка нужна вся."""
    tag = OOXML_TEXT_TAGS[kind]
    wanted = "word/" if kind == "docx" else "ppt/slides/"
    pieces = []
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if n.startswith(wanted) and n.endswith(".xml")]
        # Колонтитулы и сноски — тоже текст документа. Наивный извлекатель их
        # пропускает, и человек получает документ с непереведёнными кусками.
        for name in sorted(names):
            try:
                root = ET.fromstring(z.read(name))
            except ET.ParseError:
                continue
            for node in root.iter(tag):
                if node.text:
                    pieces.append(node.text)
            pieces.append("\n")
    text = re.sub(r"\n{3,}", "\n\n", "".join(pieces)).strip()
    return {"structured": False, "units": [text] if text else [], "meta": {}}


def extract_xlsx(path: str) -> dict:
    """Таблица Excel. Возвращаем строками, разделёнными табуляцией."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
            for si in root.iter(f"{ns}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{ns}t")))
        lines = []
        ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        for name in sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet")):
            root = ET.fromstring(z.read(name))
            for row in root.iter(f"{ns}row"):
                cells = []
                for cell in row.iter(f"{ns}c"):
                    value = cell.find(f"{ns}v")
                    if value is None or value.text is None:
                        continue
                    if cell.get("t") == "s":
                        idx = int(value.text)
                        cells.append(shared[idx] if idx < len(shared) else "")
                    else:
                        cells.append(value.text)
                if cells:
                    lines.append("\t".join(cells))
    return {"structured": False, "units": ["\n".join(lines)] if lines else [], "meta": {}}


def extract_odt(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("content.xml"))
    paragraphs = []
    for node in root.iter():
        if node.tag in (f"{ODF_TEXT_NS}p", f"{ODF_TEXT_NS}h"):
            paragraphs.append("".join(node.itertext()))
    text = "\n".join(p for p in paragraphs if p.strip())
    return {"structured": False, "units": [text] if text else [], "meta": {}}


def extract_pdf(path: str) -> dict:
    try:
        from pypdf import PdfReader
    except ImportError:
        return {"structured": False, "units": [], "meta": {},
                "warning": "Чтение PDF не установлено на сервере"}
    reader = PdfReader(path)
    pages = [(page.extract_text() or "").strip() for page in reader.pages]
    text = "\n\n".join(p for p in pages if p)
    warning = None
    if not text.strip():
        # Скан: страницы есть, текста в них нет. Нужен OCR, которого у нас нет.
        warning = ("В этом PDF нет текстового слоя — похоже, это скан. "
                   "Распознавание картинок пока не поддерживается.")
    return {"structured": False, "units": [text] if text else [], "meta": {}, "warning": warning}


def extract_html(path: str) -> dict:
    raw = read_text_file(path)
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    text = re.sub(r"(?s)<[^>]+>", " ", raw)
    text = re.sub(r"&nbsp;?", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return {"structured": False, "units": [text] if text else [], "meta": {}}


def extract_rtf(path: str) -> dict:
    raw = read_text_file(path)
    # Грубая чистка управляющих последовательностей. Для сложного RTF будет
    # неидеально, но текст достаёт.
    text = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1251", "replace"), raw)
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", " ", text)
    text = text.replace("{", " ").replace("}", " ")
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return {"structured": False, "units": [text] if text else [], "meta": {}}


def extract_plain(path: str) -> dict:
    text = read_text_file(path).strip()
    return {"structured": False, "units": [text] if text else [], "meta": {}}


EXTRACTORS = {
    ".txt": extract_plain, ".md": extract_plain, ".log": extract_plain,
    ".json": extract_plain, ".xml": extract_plain, ".yml": extract_plain, ".yaml": extract_plain,
    ".csv": lambda p: extract_csv(p, ","),
    ".tsv": lambda p: extract_csv(p, "\t"),
    ".srt": extract_srt,
    ".vtt": extract_vtt,
    ".docx": lambda p: extract_ooxml(p, "docx"),
    ".pptx": lambda p: extract_ooxml(p, "pptx"),
    ".xlsx": extract_xlsx,
    ".odt": extract_odt,
    ".pdf": extract_pdf,
    ".html": extract_html, ".htm": extract_html,
    ".rtf": extract_rtf,
}

# Форматы, которые мы узнаём, но прочитать не можем: сказать об этом прямо
# полезнее, чем молча ответить "неизвестный формат".
KNOWN_UNSUPPORTED = {
    ".doc": "Старый формат Word (.doc). Пересохраните файл как .docx.",
    ".ppt": "Старый формат PowerPoint (.ppt). Пересохраните как .pptx.",
    ".xls": "Старый формат Excel (.xls). Пересохраните как .xlsx.",
    ".pages": "Формат Apple Pages. Экспортируйте в .docx или .pdf.",
    ".epub": "Электронная книга (.epub) пока не поддерживается.",
    ".djvu": "DjVu пока не поддерживается.",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--filename", default="")
    args = parser.parse_args()

    name = args.filename or os.path.basename(args.path)
    ext = os.path.splitext(name)[1].lower()

    if ext in KNOWN_UNSUPPORTED:
        json.dump({"error": KNOWN_UNSUPPORTED[ext], "format": ext.lstrip(".")}, sys.stdout, ensure_ascii=False)
        return 0

    extractor = EXTRACTORS.get(ext)
    if not extractor:
        json.dump({"error": f"Формат {ext or 'без расширения'} не поддерживается",
                   "format": ext.lstrip(".")}, sys.stdout, ensure_ascii=False)
        return 0

    try:
        result = extractor(args.path)
    except Exception as e:  # noqa: BLE001
        json.dump({"error": f"Не удалось прочитать файл: {e}", "format": ext.lstrip(".")},
                  sys.stdout, ensure_ascii=False)
        return 0

    result["format"] = ext.lstrip(".")
    result["chars"] = sum(len(u) for u in result.get("units", []))
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
