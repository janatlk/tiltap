"""Language-aware post-processing layer for STT output.

Goals:
- Score every segment and mark obvious garbage/hallucinations as [неразборчиво].
- Apply conservative grammar/case cleanup per language.
- For Tajik: additionally normalize Persian/Arabic script leaks and named entities.
- Never change meaning, never guess words, preserve the source language.

This module deliberately does NOT touch the STT model, ffmpeg, or VAD.
"""

import json
import os
import re
import math
import sys
import time
from typing import Dict, List, Optional, Tuple
from collections import Counter

# ---------------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------------
GARBAGE_THRESHOLD = float(os.environ.get("TILTAB_GARBAGE_THRESHOLD", "0.4"))
FUZZY_MATCH_THRESHOLD = float(os.environ.get("TILTAB_NE_FUZZY_THRESHOLD", "0.80"))
MAX_NE_DISTANCE_CHARS = int(os.environ.get("TILTAB_NE_MAX_DISTANCE", "4"))

# Marker used for unintelligible speech. Same marker for every language so the
# UI/backend can replace it with a localized label if desired.
UNINTELLIGIBLE = "[неразборчиво]"


# ---------------------------------------------------------------------------
# Language metadata
# ---------------------------------------------------------------------------
LANGUAGE_NAMES = {
    "tg": "тоҷикӣ",
    "ru": "русский",
    "ky": "кыргызча",
    "uz": "o'zbekcha",
    "en": "English",
}

SCRIPT_FAMILIES = {
    "tg": "cyrillic",
    "ru": "cyrillic",
    "ky": "cyrillic",
    "uz": "latin",
    "en": "latin",
}


def _language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code, code)


# ---------------------------------------------------------------------------
# Generic utilities
# ---------------------------------------------------------------------------
def _latin_ratio(text: str) -> float:
    words = text.split()
    if not words:
        return 0.0
    latin = sum(1 for w in words if re.fullmatch(r"[a-zA-Z]+[.,!?;:\)]?", w))
    return latin / len(words)


def _cyrillic_ratio(text: str) -> float:
    if not text:
        return 0.0
    return len(re.findall(r"[\u0400-\u04FF\u0500-\u052F]", text)) / len(text)


def _arabic_ratio(text: str) -> float:
    arabic_chars = re.findall(
        r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]", text
    )
    if not text:
        return 0.0
    return len(arabic_chars) / len(text)


def _repetition_ratio(text: str) -> float:
    words = text.split()
    n = len(words)
    if n < 2:
        return 0.0

    max_run = 1
    cur = 1
    for i in range(1, n):
        if words[i] == words[i - 1]:
            cur += 1
            max_run = max(max_run, cur)
        else:
            cur = 1
    run_ratio = max_run / n

    phrase_max = 1
    for L in (2, 3):
        if n < L * 2:
            continue
        counts = Counter(tuple(words[i : i + L]) for i in range(n - L + 1))
        local_max = max(counts.values(), default=1)
        if local_max > phrase_max:
            phrase_max = local_max
    phrase_ratio = 0.0
    for L in (2, 3):
        if n < L * 2:
            continue
        counts = Counter(tuple(words[i : i + L]) for i in range(n - L + 1))
        local_max = max(counts.values(), default=1)
        if local_max > 1:
            phrase_ratio = max(phrase_ratio, (local_max * L) / n)

    return max(run_ratio, phrase_ratio)


def _non_linguistic_ratio(text: str) -> float:
    words = text.split()
    if not words:
        return 0.0
    non = sum(1 for w in words if not any(c.isalpha() for c in w))
    return non / len(words)


def _char_entropy(text: str) -> float:
    if not text:
        return 0.0
    counts = Counter(text)
    total = len(text)
    return -sum((c / total) * math.log2(c / total) for c in counts.values())


def normalize_repeated_punctuation(text: str) -> str:
    """Collapse repeated punctuation and clean up whitespace."""
    text = re.sub(r"\.{2,}", ".", text)
    text = re.sub(r"\?{2,}", "?", text)
    text = re.sub(r"!{2,}", "!", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Language-specific wordlists for scoring
# ---------------------------------------------------------------------------
_COMMON_WORDS = {
    "ru": {
        "привет", "здравствуйте", "да", "нет", "доброе", "утро", "день", "вечер",
        "как", "дела", "поживаешь", "поживаете", "ты", "вы", "спасибо", "пожалуйста",
        "я", "ты", "он", "она", "мы", "вы", "они", "это", "тот", "так", "что",
        "и", "а", "но", "или", "если", "когда", "где", "куда", "откуда", "зачем",
        "очень", "хорошо", "плохо", "большой", "маленький", "новый", "старый",
        "хороший", "плохой", "был", "есть", "будет", "сделал", "сказал", "говорил",
    },
    "ky": {
        "салам", "ооба", "жок", "рахмат", "кутмандуу", "таң", "кеч", "кандайсыз",
        "жакшы", "эмне", "жаңылык", "болду", "сиз", "мен", "ал", "бул", "жана",
        "үчүн", "болуп", "кылды", "деди", "айтты", "бар", "жок", "келди", "кетти",
    },
    "uz": {
        "salom", "ha", "yo'q", "rahmat", "tong", "kech", "yaxshimisiz", "yaxshi",
        "siz", "men", "u", "bu", "va", "yoki", "uchun", "qildi", "dedi", "aytdi",
        "bor", "yo'q", "keldi", "ketti", "nima", "qanday", "qayerda", "qachon",
    },
    "en": {
        "hello", "hi", "yes", "no", "good", "morning", "afternoon", "evening",
        "how", "are", "you", "what", "is", "it", "this", "that", "and", "or",
        "but", "if", "when", "where", "why", "who", "which", "the", "a", "an",
        "i", "you", "he", "she", "we", "they", "was", "were", "am", "been",
    },
}

# Tajik common words are defined later together with the Tajik-specific modules.


def _dictionary_bonus(text: str, language: str) -> float:
    words = [w.strip(".,!?;:\"'()[]") for w in text.lower().split()]
    if not words:
        return 0.0
    wordlist = _COMMON_WORDS.get(language, set())
    if not wordlist:
        return 0.0
    hits = sum(1 for w in words if w in wordlist)
    return min(0.2, 0.05 * hits / len(words))


# ---------------------------------------------------------------------------
# Generic segment scoring
# ---------------------------------------------------------------------------
def score_segment(text: str, language: str) -> float:
    """Return 0.0 (garbage) ... 1.0 (clean) for the given language."""
    text = text.strip()
    if not text or text == UNINTELLIGIBLE:
        return 0.0

    script = SCRIPT_FAMILIES.get(language, "")
    lat = _latin_ratio(text)
    cyr = _cyrillic_ratio(text)
    ara = _arabic_ratio(text)
    rep = _repetition_ratio(text)
    non = _non_linguistic_ratio(text)

    raw_entropy = _char_entropy(text)
    uniq = len(set(text))
    max_entropy = math.log2(uniq) if uniq > 1 else 1.0
    norm_entropy = raw_entropy / max_entropy if max_entropy > 0 else 0.0

    score = 1.0
    score -= 0.60 * rep
    score -= 0.35 * non
    score += 0.20 * norm_entropy
    score += _dictionary_bonus(text, language)

    if script == "cyrillic":
        # Latin words in a Cyrillic language are suspicious, unless the language
        # is Tajik (where some code-switching with Russian/English happens).
        lat_penalty = 0.5 if language == "tg" else 0.85
        score -= lat_penalty * lat
        # Arabic script is expected only for Tajik loanwords.
        if language == "tg":
            score -= 0.35 * ara
        else:
            score -= 0.70 * ara
    elif script == "latin":
        score -= 0.85 * cyr
        score -= 0.70 * ara
    else:
        score -= 0.50 * max(lat, cyr, ara)

    # explicit penalties for obvious noise
    if lat > 0.5 or rep > 0.4:
        score -= 0.3

    return max(0.0, min(1.0, score))


def is_garbage(text: str, language: str, threshold: float = GARBAGE_THRESHOLD) -> bool:
    """True if segment looks like noise/hallucination for the target language."""
    text = text.strip()
    if not text or text == UNINTELLIGIBLE:
        return True

    # explicit patterns first
    if re.search(r"Straßen|\b[НH]{2,}[?pwrvmk]+\b", text, re.IGNORECASE):
        return True
    if _repetition_ratio(text) > 0.45:
        return True

    script = SCRIPT_FAMILIES.get(language, "")
    if script == "cyrillic":
        if language != "tg" and _latin_ratio(text) > 0.5:
            return True
        if language != "tg" and _arabic_ratio(text) > 0.3:
            return True
    elif script == "latin":
        if _cyrillic_ratio(text) > 0.3 or _arabic_ratio(text) > 0.3:
            return True

    return score_segment(text, language) < threshold


# ---------------------------------------------------------------------------
# Tajik-specific dictionaries and helpers
# ---------------------------------------------------------------------------
DEFAULT_TAJIK_ENTITIES = {
    # Family names
    "Ахмедов": ["Аҳмедов", "Ахмадов"],
    "Ахмедова": ["Аҳмедова", "Ахмадова"],
    "Иброҳимов": ["Иброҳимова", "Иброҳим", "Иброҳимовы", "Иброҳимовыи"],
    "Каримов": ["Каримова"],
    "Раҳимов": ["Раҳимова"],
    # Male names
    "Баҳодур": ["Баходур", "Баҳодир", "Баходир", "Баҳовдур"],
    "Дамир": ["Дамиркарим", "Дамирҷон"],
    "Зулхо": ["Зулхоҳ", "Зулҳо", "Зулҳоҳ"],
    "Абдуфаттоҳ": ["Абдуфатаҳ", "Абдуфаттох"],
    "Қурбонгул": ["Қурбон"],
    "Фарзон": ["Фарзона", "Фарзонбахш"],
    "Муҳаммад": ["Муҳаммадӣ", "Маҳмад", "Маҳмадӣ", "Мухаммади"],
    "Раҳим": ["Рахим"],
    "Рустам": ["Рустамҷон"],
    "Шариф": ["Шарифҷон"],
    "Ҳамид": ["Ҳамидҷон"],
    # Female names
    "Маҳбуба": ["Махбуба"],
    "Нозанин": ["Нозирин", "Нозимахон"],
    "Шаҳло": ["Шахло"],
    "Фирӯза": ["Фирузa"],
    "Гулноз": ["Гулнор"],
    "Гулру": [],
    "Гулчеҳра": [],
    "Зебо": [],
    "Заррина": [],
    "Нигора": [],
    "Саодат": [],
    # Tajik places
    "Конибодом": ["Кони-бодом", "Кунбедон", "Кунабадан", "Кунй"],
    "Санҷидзор": ["Санжитсар", "Синҷизор", "Санҷазор", "Санҷазорӣ"],
    "Суғд": ["Суғдиё"],
    "Дастикам": ["Дасти Кам", "дасткам"],
    "Душанбе": [],
    "Хуҷанд": ["Ходжент"],
    "Бохтар": ["Қӯрғонтеппа", "Кургантюбе"],
    "Кӯлоб": ["Куляб"],
    "Ҳисор": ["Гиссар"],
    "Истаравшан": ["Ура-Тюбе"],
    "Истиқлол": [],
    "Турсунзода": [],
    "Панҷакент": [],
    "Спитамен": [],
    "Ҷаббор Расулов": [],
    "Мастчоҳ": [],
    "Ашт": [],
    "Шаҳритус": ["Шаартуз"],
    "Данғара": [],
    "Фархор": [],
    "Муъминобод": [],
    "Балҷувон": [],
    "Роштқалъа": [],
    "Ванҷ": [],
    "Ишкошим": [],
    "Дарвоз": [],
    "Рашт": [],
    "Тоборак": [],
    "Зарнисор": [],
    "Айнӣ": [],
    "Ғарм": [],
    "Ваҳдат": [],
    "Ёвон": [],
    # Countries / regions
    "Тоҷикистон": [],
    "Русия": ["Россия"],
    "Қирғизистон": ["Киргизистон", "Кыргызстан"],
    "Ӯзбекистон": ["Узбекистон"],
    "Қазоқистон": ["Казахстан"],
    "Туркия": [],
    "Эрон": [],
    "Афғонистон": [],
    "Покистон": [],
    "Хитой": ["Чин"],
    "Ҳиндустон": [],
    "Амрико": ["Америка"],
    # Media / orgs
    "Радиои Озоди": ["Радио Озоди"],
    "Азия-Плюс": ["Азия Плюс"],
    "Ховар": [],
    "Ҷаҳоннамо": [],
    "САДО": [],
    "ИММ": [],
    "ББК": [],
}

DEFAULT_TAJIK_WORDS = {
    "ва", "дар", "ки", "ба", "аз", "кӣ", "барои", "бошад", "нест",
    "ин", "он", "як", "ду", "се", "чор", "панҷ", "шаш", "ҳафт", "ҳашт", "нӯҳ", "даҳ",
    "кардан", "кунед", "кунем", "кард", "кунад", "кунанд", "мекунад", "мекунанд",
    "гуфт", "гуфтанд", "мегӯяд", "мегӯянд", "гап", "сухан",
    "муаллим", "мактаб", "китоб", "дарахт", "об", "хона", "кӯча", "шаҳр", "деҳа",
    "модар", "падар", "фарзанд", "бародар", "апа", "одар",
    "кӯшта", "қатл", "ҷиноят", "ҳодиса", "вақеа",
}

LATIN_TO_CYRILLIC_HOMOGLYPHS = str.maketrans({
    "a": "а", "A": "А",
    "b": "б", "B": "Б",
    "c": "с", "C": "С",
    "e": "е", "E": "Е",
    "f": "ф", "F": "Ф",
    "h": "ҳ", "H": "Ҳ",
    "i": "и", "I": "И",
    "k": "к", "K": "К",
    "m": "м", "M": "М",
    "n": "н", "N": "Н",
    "o": "о", "O": "О",
    "p": "р", "P": "Р",
    "r": "г",
    "t": "т", "T": "Т",
    "u": "у", "U": "У",
    "x": "х", "X": "Х",
    "y": "у", "Y": "У",
})

ARABIC_TO_CYRILLIC = str.maketrans({
    "ا": "а", "آ": "о", "أ": "а", "إ": "и",
    "ب": "б", "پ": "п", "ت": "т", "ث": "с",
    "ج": "ҷ", "چ": "ч", "ح": "ҳ", "خ": "х",
    "د": "д", "ذ": "з", "ر": "р", "ز": "з",
    "ژ": "ж", "س": "с", "ش": "ш", "ص": "с",
    "ض": "з", "ط": "т", "ظ": "з", "ع": "а",
    "غ": "ғ", "ف": "ф", "ق": "қ", "ک": "к",
    "ك": "к", "گ": "г", "ل": "л", "م": "м",
    "н": "н", "\u0646": "н", "و": "в", "ه": "ҳ", "ة": "а",
    "ی": "и", "ي": "и", "ى": "и", "ئ": "и",
    "ء": "", "ٔ": "", "ً": "", "ٌ": "", "ٍ": "",
    "َ": "", "ُ": "", "ِ": "", "ّ": "", "ْ": "",
    "ٰ": "", "ٓ": "", "ٖ": "", "ٗ": "", "ٕ": "",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
})

ARABIC_CHAR_RE = re.compile(
    r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+"
)


def transliterate_arabic_words(text: str) -> str:
    """Replace Arabic/Persian-script words with a Tajik Cyrillic approximation."""
    return ARABIC_CHAR_RE.sub(lambda m: m.group(0).translate(ARABIC_TO_CYRILLIC), text)


def fix_mixed_script_typos(text: str) -> str:
    """Replace Latin look-alike chars inside Cyrillic words (e.g. 'муfассал' -> 'муфассал')."""
    def fix_word(word: str) -> str:
        if not word:
            return word
        has_cyrillic = bool(re.search(r"[\u0400-\u04FF\u0500-\u052F]", word))
        has_latin = bool(re.search(r"[a-zA-Z]", word))
        if has_cyrillic and has_latin:
            return word.translate(LATIN_TO_CYRILLIC_HOMOGLYPHS)
        return word
    return " ".join(fix_word(w) for w in text.split())


def _load_tajik_entities() -> Dict[str, List[str]]:
    path = os.environ.get("TILTAB_ENTITIES_PATH", "data/tajik_entities.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return {ent: [] for ent in data}
            if isinstance(data, dict):
                if "entities" in data:
                    return {ent: [] for ent in data.get("entities", [])}
                return {str(k): (v if isinstance(v, list) else [str(v)]) for k, v in data.items()}
        except Exception as e:
            print(f"[postprocess] failed to load entities from {path}: {e}", file=sys.stderr)
    return DEFAULT_TAJIK_ENTITIES


class NamedEntityFixer:
    # Very common function words that should never be replaced by a named entity.
    STOPWORDS = {
        "дар", "ва", "аз", "ба", "барои", "бо", "без", "то", "баъд", "пеш", "пас",
        "кӣ", "ки", "к", "чи", "чӣ", "ё", "агар", "аммо", "вале", "зеро", "чун",
        "хеле", "на", "не", "нест", "ҳам", "фақат", "танҳо", "ҳама", "ҳар", "баъзе",
        "чанд", "чунон", "чунин", "ҳамчун", "бояд", "метавонад", "тавонист", "тавонад",
        "шояд", "чаро", "куҷо", "кай", "чигуна", "чунин", "чунон",
        "ман", "ту", "ӯ", "вай", "мо", "шумо", "онҳо", "инҳо", "ҳамин", "ҳамон",
        "ҳаминҳо", "ҳамонҳо", "як", "ду", "се", "чор", "панҷ", "шаш", "ҳафт", "ҳашт",
        "нӯҳ", "даҳ", "ин", "он",
        "кардан", "кард", "карда", "кардаст", "кардаанд", "кардаӣ", "кардам", "кардаем",
        "кардаед", "кардаанд", "кунад", "кунанд", "кунед", "кунем", "кунӣ", "кунам",
        "мекунад", "мекунанд", "мекунем", "мекунед", "мекунам", "мекунӣ",
        "шудан", "шуд", "шуданд", "шуда", "шудаст", "шудаанд", "шавад", "шаванд", "шавӣ",
        "омадан", "омад", "омада", "омадаст", "омадаанд", "меояд", "меоянд",
        "рафтан", "рафт", "рафта", "рафтаст", "рафтаанд",
        "гуфтан", "гуфт", "гуфтанд", "гуфта", "мегӯяд", "мегӯянд", "мегӯям", "мегӯӣ",
        "дидан", "дид", "дида", "дидан", "бинад", "бинанд", "бинам", "бинӣ",
        "додан", "дод", "дода", "диҳад", "диҳанд", "диҳам", "диҳӣ", "доданд",
        "доштан", "дошт", "дошта", "доштаст", "дорад", "доранд", "дорам", "дорӣ",
        "будан", "буд", "буданд", "буда", "будаст", "будаанд", "бошад", "бошанд",
        "аст", "ҳаст", "ҳастанд", "истодан", "истода", "истодааст", "нишастан", "нишаста",
        "гирифтан", "гирифт", "гирифта", "гиряд", "гиранд", "гирӣ", "гирам",
        "куштан", "кушта", "кушташуда", "мурд", "муда",
        "медонам", "намедонам", "медонад", "медонанд", "медонед", "медонем", "медонӣ",
        "мефаҳмам", "мефаҳмад", "мефаҳманд", "фаҳмид", "фаҳмидам", "фаҳмида",
        "ҳайрон", "ҳайронам", "ҳайронанд", "ҳайрон шуд", "ҳайрон шуда",
        "гусса", "гап", "сухан", "нафас", "овоз", "садо",
        "калон", "хурд", "нав", "кӯҳна", "хуб", "бад", "зиёд", "кам", "пур", "тоза",
        "боло", "поён", "дарун", "берун", "пеш", "пас", "наздик", "дур", "ҳозир",
        "имрӯз", "дирӯз", "фардо", "ҳоло", "шаб", "рӯз", "сол", "моҳ", "ҳафта", "соат",
        "дақиқа", "сония", "субҳ", "шом", "бегоҳ", "писҳи", "пагоҳ", "имсол", "парсол",
        "тоҷик", "тоҷикон", "тоҷикҳо", "киргиз", "киргизҳо", "қирғиз", "қирғизҳо",
        "узбек", "узбекҳо", "қазоқ", "қазоқҳо", "рус", "русҳо", "мусулмон", "мусулмонон",
        "хонавода", "хонаводахо", "оила", "оилаҳо", "мактаб", "китоб", "деҳа", "шаҳр",
        "кӯча", "хона", "модар", "падар", "фарзанд", "бародар", "апа", "одар", "куштор",
        "ҷиноят", "ҳодиса", "вақеа", "хабар", "мақомот", "сокин", "сокинон", "пайванд",
        "мудир", "муовин", "муаллим", "талаба", "талабилм", "талабилмун", "таҳқиқ",
        "ҳам", "фақат", "танҳо", "баъзе", "чанд", "як", "ҳама", "ҳар", "ҳеч", "ҳеҷ",
        "боз", "аллоҳ", "худо", "ҳаҷ", "умра", "қурбон", "рамазон", "айд",
    }

    def __init__(self, entities: Optional[Dict[str, List[str]]] = None):
        self.entities = entities or _load_tajik_entities()
        self.canonical = set(self.entities.keys())
        self.variant_to_canonical: Dict[str, str] = {}
        for canonical, variants in self.entities.items():
            for variant in variants:
                self.variant_to_canonical[variant.lower()] = canonical

        self.search_pool = sorted(
            set(self.canonical) | {v.lower() for v in self.variant_to_canonical.keys()},
            key=len,
            reverse=True,
        )
        self.phrase_variants = sorted(
            [
                (v.lower(), canonical, v)
                for canonical, variants in self.entities.items()
                for v in variants
                if " " in v
            ],
            key=lambda x: len(x[0]),
            reverse=True,
        )

        try:
            from rapidfuzz import fuzz, process
            self._fuzz = fuzz
            self._process = process
        except ImportError:
            self._fuzz = None
            self._process = None

    def _similarity(self, a: str, b: str) -> float:
        if self._fuzz:
            return self._fuzz.ratio(a, b) / 100.0
        import difflib
        return difflib.SequenceMatcher(None, a, b).ratio()

    def _preserve_case(self, original: str, replacement: str) -> str:
        prefix = re.match(r"^[^\w\u0400-\u04FF]+", original)
        suffix = re.search(r"[^\w\u0400-\u04FF]+$", original)
        prefix = prefix.group(0) if prefix else ""
        suffix = suffix.group(0) if suffix else ""
        if original.lower().endswith("ро") and not replacement.lower().endswith("ро"):
            suffix = "ро" + suffix
        return prefix + replacement + suffix

    def fix_word(self, word: str) -> str:
        stripped = word.strip(".,!?;:\"'()[]")
        if not stripped or len(stripped) < 3:
            return word
        lower = stripped.lower()
        if lower in self.STOPWORDS or (lower.endswith("ро") and lower[:-2] in self.STOPWORDS):
            return word
        if lower in self.variant_to_canonical:
            return self._preserve_case(word, self.variant_to_canonical[lower])
        if lower in {c.lower() for c in self.canonical}:
            return word
        best = None
        best_score = 0.0
        for candidate in self.search_pool:
            candidate_lower = candidate.lower()
            if candidate_lower == lower:
                continue
            dist = abs(len(candidate) - len(stripped))
            if dist > MAX_NE_DISTANCE_CHARS:
                continue
            if len(stripped) <= 4 and dist > 1:
                continue
            score = self._similarity(stripped, candidate)
            if score > best_score:
                best_score = score
                best = candidate
        if best and best_score >= FUZZY_MATCH_THRESHOLD:
            replacement = self.variant_to_canonical.get(best.lower(), best)
            return self._preserve_case(word, replacement)
        return word

    def _phrase_fix(self, text: str) -> str:
        if not self.phrase_variants:
            return text
        lower_text = text.lower()
        out: List[str] = []
        i = 0
        n = len(text)
        while i < n:
            matched = False
            for lv, canonical, _ in self.phrase_variants:
                if lower_text.startswith(lv, i):
                    prev_ok = i == 0 or not re.match(r"[\w\u0400-\u04FF]", text[i - 1])
                    next_idx = i + len(lv)
                    next_ok = next_idx >= n or not re.match(r"[\w\u0400-\u04FF]", text[next_idx])
                    if prev_ok and next_ok:
                        out.append(canonical)
                        i = next_idx
                        matched = True
                        break
            if not matched:
                out.append(text[i])
                i += 1
        return "".join(out)

    def fix(self, text: str) -> str:
        if not text or text == UNINTELLIGIBLE:
            return text
        text = self._phrase_fix(text)
        return " ".join(self.fix_word(w) for w in text.split())


# ---------------------------------------------------------------------------
# LLM-based cleanup
# ---------------------------------------------------------------------------
class LLMTextCleaner:
    """Clean/normalize STT text via available LLM provider with fallback."""

    PROVIDERS = [
        ("openai", "OPENAI_API_KEY"),
        ("gemini", "GEMINI_API_KEY"),
        ("groq", "GROQ_API_KEY"),
    ]

    def __init__(self):
        self.provider, self.key = self._pick_provider()
        self.model = os.environ.get("TILTAB_CLEANUP_MODEL") or self._default_model(self.provider)
        self.cache: Dict[str, str] = {}

    def _pick_provider(self) -> Tuple[str, str]:
        forced = os.environ.get("TILTAB_CLEANUP_PROVIDER", "").strip().lower()
        if forced == "none":
            return "none", ""
        if forced:
            for provider, env_key in self.PROVIDERS:
                if provider == forced:
                    key = os.environ.get(env_key, "").strip()
                    if key:
                        return provider, key
        for provider, env_key in self.PROVIDERS:
            key = os.environ.get(env_key, "").strip()
            if key:
                return provider, key
        return "", ""

    @staticmethod
    def _default_model(provider: str) -> str:
        defaults = {
            "openai": "gpt-4o-mini",
            "gemini": "gemini-2.5-flash",
            "groq": "llama-3.3-70b-versatile",
        }
        return defaults.get(provider, "")

    def available(self) -> bool:
        return bool(self.provider and self.provider != "none" and self.key and self.model)

    def _system_prompt(self, language: str) -> str:
        name = _language_name(language)

        if language == "tg":
            return (
                "Ты — строгий нормализатор таджикской кириллицы для расшифровки речи. "
                "Твоя задача — привести любой текст к чистому таджикскому языку (кириллица), "
                "исправить падежи/спряжения и убрать мусор.\n\n"
                "Абсолютные правила:\n"
                "1. Язык выхода — обязательно тоҷикӣ на кириллице. Латинские или арабские вставки, "
                "а также русские/английские слова, переведи на таджикский, если это общие фразы "
                "(например, 'good, thanks' → 'хуб, ташаккур').\n"
                "2. Если текст уже на таджикской кириллице, исправь только явные грамматические ошибки (падеж, спряжение).\n"
                "3. Переводи арабско-персидские написания в таджикскую кириллицу.\n"
                "4. НЕ меняй смысл, НЕ перефразируй, НЕ додумывай слова.\n"
                "5. НЕ меняй имена собственные, фамилии, топонимы.\n"
                "6. Если фрагмент неразборчив или явный мусор, замени его на [неразборчиво].\n"
                "7. Верни только очищенный текст, без пояснений."
            )

        if language == "ru":
            return (
                "Ты — консервативный редактор расшифровки русской речи. "
                "Исправь только грамматические ошибки, падежи и спряжения.\n\n"
                "Абсолютные правила:\n"
                "1. НЕ меняй смысл сказанного.\n"
                "2. НЕ перефразируй и НЕ додумывай слова.\n"
                "3. НЕ меняй имена собственные, фамилии, топонимы.\n"
                "4. Если фрагмент неразборчив или явный мусор, замени его на [неразборчиво].\n"
                "5. Язык выхода — русский (кириллица).\n"
                "6. Верни только исправленный текст, без пояснений."
            )

        if language == "ky":
            return (
                "Сен кыргыз тилиндеги сүйлөмдү түзөтүп жатасың. Бир гана грамматикалык каталарды, "
                "жөндөмдү жана чакты түзөт.\n\n"
                "Мүмкүн эмес эрежелер:\n"
                "1. Айтылган маанини өзгөртпө.\n"
                "2. Сөздөрдү өзүңдүкүнчө толуктап же алмаштырба.\n"
                "3. Өздүк ысымдарды, жер-суу аттарын өзгөртпө.\n"
                "4. Эгер үзүндү түшүнүксүз болсо же таштанды болсо, [неразборчиво] деп кой.\n"
                "5. Чыгуу тили — кыргызча (кириллица).\n"
                "6. Түзөтүлгөн текстти гана кайтар, түшүндүрмөсүз."
            )

        if language == "uz":
            return (
                "Siz o'zbek tilidagi nutq matnini tahrirlayapsiz. Faqat grammatik xatolarni, "
                "kelishik va shaklni tuzating.\n\n"
                "Qat'iy qoidalar:\n"
                "1. Aytilgan ma'noni o'zgartirmang.\n"
                "2. So'zlarni o'zingizdan qo'shmang yoki almashtirmang.\n"
                "3. Shaxsiy ismlar, joy nomlarini o'zgartirmang.\n"
                "4. Agar parcha tushunarsiz yoki axlat bo'lsa, [неразборчиво] deb qo'ying.\n"
                "5. Chiquvchi til — o'zbekcha (lotin alifbosi).\n"
                "6. Faqat tuzatilgan matnni qaytaring, izohsiz."
            )

        if language == "en":
            return (
                "You are a conservative editor of English speech transcripts. "
                "Fix only grammar, tense, and minor spelling errors.\n\n"
                "Absolute rules:\n"
                "1. Do NOT change the meaning.\n"
                "2. Do NOT rephrase or guess words.\n"
                "3. Do NOT change proper names or places.\n"
                "4. If a fragment is unintelligible or garbage, replace it with [неразборчиво].\n"
                "5. Output language: English.\n"
                "6. Return only the corrected text, no explanations."
            )

        # Generic fallback
        return (
            f"You are a conservative editor of speech transcripts in {_language_name(language)}. "
            "Fix only grammar, case, and minor spelling errors.\n\n"
            "Absolute rules:\n"
            "1. Do NOT change the meaning.\n"
            "2. Do NOT rephrase or guess words.\n"
            "3. Do NOT change proper names or places.\n"
            "4. If a fragment is unintelligible or garbage, replace it with [неразборчиво].\n"
            f"5. Output language: {_language_name(language)}.\n"
            "6. Return only the corrected text, no explanations."
        )

    @staticmethod
    def _request_with_retry(method, *args, max_retries=3, **kwargs):
        import requests
        last_err = None
        for attempt in range(max_retries):
            try:
                resp = method(*args, **kwargs)
                resp.raise_for_status()
                return resp
            except requests.exceptions.HTTPError as e:
                last_err = e
                status = e.response.status_code if e.response else 0
                if status in (429, 500, 502, 503, 504) and attempt < max_retries - 1:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise
            except Exception:
                raise
        raise last_err

    def _call_provider(self, provider: str, key: str, model: str, text: str, language: str) -> Optional[str]:
        if provider in ("groq", "openai"):
            return self._call_groq_openai(provider, key, model, text, language)
        if provider == "gemini":
            return self._call_gemini(key, model, text, language)
        return None

    def _call_groq_openai(self, provider: str, key: str, model: str, text: str, language: str) -> Optional[str]:
        import requests

        url = {
            "groq": "https://api.groq.com/openai/v1/chat/completions",
            "openai": "https://api.openai.com/v1/chat/completions",
        }[provider]

        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": self._system_prompt(language)},
                {"role": "user", "content": text},
            ],
        }
        try:
            resp = self._request_with_retry(requests.post, url, headers=headers, json=payload, timeout=120)
            data = resp.json()
            return data["choices"][0]["message"]["content"].strip()
        except Exception as e:
            print(f"[postprocess] {provider} cleanup failed: {e}", file=sys.stderr)
            return None

    def _call_gemini(self, key: str, model: str, text: str, language: str) -> Optional[str]:
        import requests

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            f"?key={key}"
        )
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": self._system_prompt(language) + "\n\nТекст:\n" + text}
                    ]
                }
            ],
            "generationConfig": {"temperature": 0.1},
        }
        try:
            resp = self._request_with_retry(requests.post, url, json=payload, timeout=120)
            data = resp.json()
            return data["candidates"][0]["content"]["parts"][0]["text"].strip()
        except Exception as e:
            print(f"[postprocess] gemini cleanup failed: {e}", file=sys.stderr)
            return None

    def _provider_chain(self) -> List[Tuple[str, str, str]]:
        chain: List[Tuple[str, str, str]] = []
        forced = os.environ.get("TILTAB_CLEANUP_PROVIDER", "").strip().lower()
        if self.provider and self.provider != "none" and self.key:
            chain.append((self.provider, self.key, self.model))
        for provider, env_key in self.PROVIDERS:
            key = os.environ.get(env_key, "").strip()
            if not key:
                continue
            model = os.environ.get("TILTAB_CLEANUP_MODEL") or self._default_model(provider)
            if (provider, key, model) not in chain:
                chain.append((provider, key, model))
        return chain

    @staticmethod
    def _is_safe_edit(original: str, cleaned: str, language: str) -> bool:
        if not cleaned:
            return False
        import difflib

        orig_words = original.split()
        clean_words = cleaned.split()
        if not orig_words:
            return False

        # Arabic/Persian input in Tajik is allowed to be rewritten more freely.
        if language == "tg" and _arabic_ratio(original) > 0.5:
            return abs(len(clean_words) - len(orig_words)) / max(len(orig_words), 1) <= 0.5

        ratio = difflib.SequenceMatcher(None, orig_words, clean_words).ratio()
        if ratio < 0.60:
            return False
        len_diff = abs(len(clean_words) - len(orig_words)) / max(len(orig_words), 1)
        if len_diff > 0.30:
            return False
        return True

    def clean(self, text: str, language: str) -> str:
        text = text.strip()
        if not text or text == UNINTELLIGIBLE:
            return text
        cache_key = f"{language}:{text}"
        if cache_key in self.cache:
            return self.cache[cache_key]
        if not self.available():
            return text

        result = None
        for provider, key, model in self._provider_chain():
            candidate = self._call_provider(provider, key, model, text, language)
            if candidate and self._is_safe_edit(text, candidate, language):
                result = candidate
                break
            if candidate:
                print(
                    f"[postprocess] {provider} edit too aggressive, trying fallback",
                    file=sys.stderr,
                )

        cleaned = result if result else text
        self.cache[cache_key] = cleaned
        return cleaned


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------
_cleaner: Optional[LLMTextCleaner] = None
_tajik_fixer: Optional[NamedEntityFixer] = None


def _get_cleaner() -> LLMTextCleaner:
    global _cleaner
    if _cleaner is None:
        _cleaner = LLMTextCleaner()
    return _cleaner


def _get_tajik_fixer() -> NamedEntityFixer:
    global _tajik_fixer
    if _tajik_fixer is None:
        _tajik_fixer = NamedEntityFixer()
    return _tajik_fixer


def _contains_arabic(text: str) -> bool:
    return bool(
        re.search(
            r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]",
            text,
        )
    )


def _needs_llm_cleanup(text: str, score: float, language: str) -> bool:
    """Only spend LLM credits when the segment is clearly dirty or grammar may be off."""
    if language == "tg":
        # Tajik gets priority processing: always run through the LLM so that
        # Persian/Arabic script leaks, Latin/Russian insertions, and grammar
        # issues are normalized to clean Tajik Cyrillic.
        return True
    # For other languages, run LLM cleanup conservatively on low-scoring or short text.
    return score < 0.75 or _non_linguistic_ratio(text) > 0.1


def _apply_tajik_rules(text: str) -> str:
    """Tajik-specific rule-based cleanup before/after LLM."""
    text = transliterate_arabic_words(text)
    text = fix_mixed_script_typos(text)
    fixer = _get_tajik_fixer()
    text = fixer.fix(text)
    return text


def postprocess_segment(text: str, language: str) -> Tuple[str, float]:
    """Run a single segment through scorer and cleaner. Returns (text, score)."""
    text = text.strip()
    if not text:
        return UNINTELLIGIBLE, 0.0

    # Tajik: rule-based Arabic/Persian conversion first.
    if language == "tg":
        text = transliterate_arabic_words(text)

    score = score_segment(text, language)
    if is_garbage(text, language):
        return UNINTELLIGIBLE, score

    cleaned = text
    # Call LLM for grammar/script cleanup when useful.
    if len(text) >= 3 and _needs_llm_cleanup(text, score, language):
        cleaner = _get_cleaner()
        cleaned = cleaner.clean(text, language)
    if not cleaned:
        return UNINTELLIGIBLE, score

    # Apply language-specific rule-based fixes.
    if language == "tg":
        cleaned = _apply_tajik_rules(cleaned)
    else:
        cleaned = normalize_repeated_punctuation(cleaned)
        cleaned = fix_mixed_script_typos(cleaned)

    return cleaned, score


def postprocess_transcription(result: Dict, language: Optional[str] = None) -> Dict:
    """Apply post-processing to a standard STT result dict.

    Input/output shape: {"text": str, "language": str, "segments": [...]}
    """
    if not isinstance(result, dict) or (not result.get("text") and not result.get("segments")):
        return result

    lang = language or result.get("language", "")
    # Handle language tags like "ru+en", "auto", etc.
    if isinstance(lang, str):
        lang = lang.split("+")[0].split("-")[0].lower()
    if lang not in LANGUAGE_NAMES:
        lang = ""

    new_segments = []
    kept_texts = []
    for seg in result.get("segments", []):
        raw_text = seg.get("text", "")
        cleaned_text, score = postprocess_segment(raw_text, lang)
        new_seg = dict(seg)
        new_seg["text"] = cleaned_text
        new_seg["quality_score"] = round(score, 3)
        new_segments.append(new_seg)
        if cleaned_text != UNINTELLIGIBLE:
            kept_texts.append(cleaned_text)

    full_text = " ".join(kept_texts)

    # Tajik: rule-based cleanup first.
    if lang == "tg":
        full_text = _apply_tajik_rules(full_text)

    # Final LLM pass on the merged text if it still looks dirty.
    if lang and len(full_text) >= 15 and _needs_llm_cleanup(full_text, score_segment(full_text, lang), lang):
        cleaner = _get_cleaner()
        full_text = cleaner.clean(full_text, lang)
        if lang == "tg":
            full_text = _apply_tajik_rules(full_text)
        else:
            full_text = normalize_repeated_punctuation(full_text)
            full_text = fix_mixed_script_typos(full_text)

    return {
        **result,
        "text": full_text,
        "segments": new_segments,
    }
