import { logger } from "../utils/logger";
import { config } from "../config";
import type { InlineKeyboardButton } from "../types";
import {
  ensureUser,
  getUserByChatId,
  updateUserPreferences,
  type User,
} from "../db/repos";

const TELEGRAM_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

export const MAX_MESSAGE_LENGTH = 4000;
export const TEXT_FILE_THRESHOLD = 3900;

export const SUPPORTED_LANGUAGES = ["ky", "tg", "uz", "en", "ru"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  ky: "Кыргызча",
  tg: "Тоҷикӣ",
  uz: "O'zbekcha",
  en: "English",
  ru: "Русский",
};

export const LANGUAGE_FLAGS: Record<SupportedLanguage, string> = {
  ky: "🇰🇬",
  tg: "🇹🇯",
  uz: "🇺🇿",
  en: "🇬🇧",
  ru: "🇷🇺",
};

export const INTERFACE_LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  ky: "Кыргызча",
  tg: "Тоҷикӣ",
  uz: "O'zbekcha",
  en: "English",
  ru: "Русский",
};

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------
const TRANSLATIONS: Record<string, Record<SupportedLanguage, string>> = {
  welcome: {
    ky: "👋 <b>TilTap</b>ке кош келиңиз!\n\n🎙 Аудио, видео жана YouTube шилтемелерин расмийлоңуз.\n🌐 Кыргызча, тоҷикӣ, ўзбекча, русча жана англисча иштеиет.\n\nТөмөнкү баскычтарды колдонуңуз же медиа файлды түз эле жибериңиз.",
    tg: "👋 Хуш омадед ба <b>TilTap</b>!\n\n🎙 Ман аудио, видео ва пайвандҳои YouTube-ро транскрипция мекунам.\n🌐 Ба забонҳои қирғизӣ, тоҷикӣ, ӯзбекӣ, русӣ ва англисӣ.\n\nАз тугмаҳои зерин истифода баред ё мустақиман файл фиристед.",
    uz: "👋 <b>TilTap</b>ga xush kelibsiz!\n\n🎙 Men audio, video va YouTube havolalarini transkripsiya qilaman.\n🌐 Qirg'iz, tojik, o'zbek, rus va ingliz tillarida.\n\nQuyidagi tugmalardan foydalaning yoki media faylni to'g'ridan-to'g'ri yuboring.",
    en: "👋 Welcome to <b>TilTap</b>!\n\n🎙 I transcribe audio, video, and YouTube links.\n🌐 In Kyrgyz, Tajik, Uzbek, Russian, and English.\n\nUse the buttons below or send media directly.",
    ru: "👋 Добро пожаловать в <b>TilTap</b>!\n\n🎙 Я распознаю аудио, видео и ссылки YouTube.\n🌐 На кыргызском, таджикском, узбекском, русском и английском.\n\nИспользуйте кнопки ниже или отправьте файл напрямую.",
  },
  help: {
    ky: "<b>🆘 Жардам</b>\n\n<b>Файл жиберүү:</b> аудио, видео, үн каттуу же документ жибериңиз. Бот тилди сурайт, андан кийин иштей баштайт.\n\n<b>YouTube:</b> «🔗 YouTube шилтемеси» баскычын басыңыз же шилтемени түз эле жибериңиз.\n\n<b>Тил орнотуулар:</b> «⚙️ Орнотуулар» менен интерфейстин тилин жана которуу үчүн демейки тилди тандаңыз.\n\n<b>Командаалар:</b>\n/start — негизги меню\n/help — бул жардам\n/settings — тил орнотуулар\n/test — такырыкты текшерүү\n/stop — активдүү процессти токтотуу",
    tg: "<b>🆘 Кӯмак</b>\n\n<b>Фиристодани файл:</b> аудио, видео ё файл фиристед. Бот забонро пурсонда, сипас корро оғоз мекунад.\n\n<b>YouTube:</b> тугмаи «🔗 Пайванди YouTube»-ро пахш кунед ё пайвандро мустақиман фиристед.\n\n<b>Танзимоти забон:</b> тавассути «⚙️ Танзимот» забони интерфейс ва забони пешфарзи тарҷумаро интихоб кунед.\n\n<b>Дастурҳо:</b>\n/start — менюи асосӣ\n/help — ин кӯмак\n/settings — танзимоти забон\n/test — санҷиши дақиқӣ\n/stop — қатъ кардани раванди фаъол",
    uz: "<b>🆘 Yordam</b>\n\n<b>Fayl yuborish:</b> audio, video yoki hujjat yuboring. Bot tilni so'raydi, keyin ishlaydi.\n\n<b>YouTube:</b> «🔗 YouTube havolasi» tugmasini bosing yoki havolani to'g'ridan-to'g'ri yuboring.\n\n<b>Til sozlamalari:</b> «⚙️ Sozlamalar» orqali interfeys tilini va tarjima uchun standart tilni tanlang.\n\n<b>Buyruqlar:</b>\n/start — asosiy menyu\n/help — bu yordam\n/settings — til sozlamalari\n/test — aniqlik testi\n/stop — faol jarayonni to'xtatish",
    en: "<b>🆘 Help</b>\n\n<b>Send a file:</b> send audio, video, voice, or a document. The bot will ask for the language, then start working.\n\n<b>YouTube:</b> tap «🔗 YouTube link» or send a link directly.\n\n<b>Language settings:</b> use «⚙️ Settings» to choose the interface language and default translation language.\n\n<b>Commands:</b>\n/start — main menu\n/help — this help\n/settings — language settings\n/test — accuracy test\n/stop — stop active process",
    ru: "<b>🆘 Помощь</b>\n\n<b>Отправьте файл:</b> аудио, видео, голосовое или документ. Бот спросит язык, затем начнёт работу.\n\n<b>YouTube:</b> нажмите «🔗 Ссылка YouTube» или отправьте ссылку напрямую.\n\n<b>Настройки языка:</b> через «⚙️ Настройки» выберите язык интерфейса и язык перевода по умолчанию.\n\n<b>Команды:</b>\n/start — главное меню\n/help — эта помощь\n/settings — настройки языка\n/test — тест точности\n/stop — остановить активный процесс",
  },
  chooseInterfaceLanguage: {
    ky: "🌍 Интерфейстин тилин тандаңыз:",
    tg: "🌍 Забони интерфейсро интихоб кунед:",
    uz: "🌍 Interfeys tilini tanlang:",
    en: "🌍 Choose interface language:",
    ru: "🌍 Выберите язык интерфейса:",
  },
  chooseSourceLanguage: {
    ky: "🎙️ Распознаоо тилин тандаңыз:",
    tg: "🎙️ Забони транскрипцияро интихоб кунед:",
    uz: "🎙️ Transkripsiya tilini tanlang:",
    en: "🎙️ Choose transcription language:",
    ru: "🎙️ Выберите язык распознавания:",
  },
  chooseTargetLanguage: {
    ky: "🌐 Кайсы тилге которолосуңуз? (же «Которбоой» тандаңыз)",
    tg: "🌐 Ба кадом забон тарҷума кунем? (ё «Бе тарҷума»-ро интихоб кунед)",
    uz: "🌐 Qaysi tilga tarjima qilay? (yoki «Tarjimasiz» ni tanlang)",
    en: "🌐 Which language should I translate to? (or choose No translation)",
    ru: "🌐 На какой язык перевести? (или выберите Без перевода)",
  },
  sendYoutubeLink: {
    ky: "🔗 YouTube шилтемесин жибериңиз:",
    tg: "🔗 Пайванди YouTube-ро фиристед:",
    uz: "🔗 YouTube havolasini yuboring:",
    en: "🔗 Send me a YouTube link:",
    ru: "🔗 Отправьте ссылку на YouTube:",
  },
  transcribing: {
    ky: "⏳ Распознаоо жатат...",
    tg: "⏳ Транскрипция мешавад...",
    uz: "⏳ Transkripsiya qilinmoqda...",
    en: "⏳ Transcribing...",
    ru: "⏳ Распознаю...",
  },
  transcriptionComplete: {
    ky: "✅ Распознаоо аяктады!",
    tg: "✅ Транскрипция анҷом ёфт!",
    uz: "✅ Transkripsiya tugadi!",
    en: "✅ Transcription complete!",
    ru: "✅ Распознавание завершено!",
  },
  translating: {
    ky: "⏳ Которулуп жатат...",
    tg: "⏳ Тарҷума мешавад...",
    uz: "⏳ Tarjima qilinmoqda...",
    en: "⏳ Translating...",
    ru: "⏳ Перевожу...",
  },
  improvingText: {
    ky: "✨ Текстти тазалап жатам...",
    tg: "✨ Тоза кардани матн...",
    uz: "✨ Matnni tozalash...",
    en: "✨ Improving text quality...",
    ru: "✨ Улучшаю качество текста...",
  },
  sessionExpired: {
    ky: "⚠️ Сессия аяктады. Файлды кайра жибериңиз.",
    tg: "⚠️ Сессия ба охир расид. Лутфан файлро дубора фиристед.",
    uz: "⚠️ Sessiya tugadi. Iltimos, faylni qayta yuboring.",
    en: "⚠️ Session expired. Please send the media again.",
    ru: "⚠️ Сессия истекла. Пожалуйста, отправьте файл заново.",
  },
  stageStarting: {
    ky: "Баштап жатам...",
    tg: "Оғоз карда истодаем...",
    uz: "Boshlanmoqda...",
    en: "Starting...",
    ru: "Начинаю...",
  },
  stageDownload: {
    ky: "YouTube'дан жүктөп жатам...",
    tg: "Аз YouTube боргирӣ мекунам...",
    uz: "YouTube'dan yuklanmoqda...",
    en: "Downloading from YouTube...",
    ru: "Скачиваю с YouTube...",
  },
  stageTranscribe: {
    ky: "Распознаоо жатам...",
    tg: "Транскрипция мекунам...",
    uz: "Transkripsiya qilinmoqda...",
    en: "Transcribing...",
    ru: "Распознаю...",
  },
  stageDone: {
    ky: "Даяр!",
    tg: "Тайёр!",
    uz: "Tayyor!",
    en: "Done!",
    ru: "Готово!",
  },
  testHeader: {
    ky: "🧪 TilTap такырыкты текшерүү",
    tg: "🧪 Санҷиши дақиқии TilTap",
    uz: "🧪 TilTap aniqlik testi",
    en: "🧪 TilTap Accuracy Test",
    ru: "🧪 Тест точности TilTap",
  },
  testPreparing: {
    ky: "Тестти даярдап жатам...",
    tg: "Омода кардани санҷиш...",
    uz: "Test tayyorlanmoqda...",
    en: "Preparing test...",
    ru: "Подготовка теста...",
  },
  testDownloading: {
    ky: "YouTube'дан аудио жүктөп жатам...",
    tg: "Аз YouTube аудио боргирӣ мекунам...",
    uz: "YouTube'dan audio yuklanmoqda...",
    en: "Downloading audio from YouTube...",
    ru: "Загрузка аудио с YouTube...",
  },
  testRecognizing: {
    ky: "Сүйлөмдү распознаоо жатам...",
    tg: "Транскрипцияи сухан...",
    uz: "Nutqni transkripsiya qilish...",
    en: "Recognizing speech...",
    ru: "Распознавание речи...",
  },
  testScoring: {
    ky: "Такырыкты эсептөө...",
    tg: "Ҳисобкунии дақиқӣ...",
    uz: "Aniqlikni hisoblash...",
    en: "Calculating accuracy...",
    ru: "Подсчет точности...",
  },
  testCompleted: {
    ky: "✅ Тест аяктады",
    tg: "✅ Санҷиш анҷом ёфт",
    uz: "✅ Test tugadi",
    en: "✅ Test completed",
    ru: "✅ Тест завершен",
  },
  recognizedText: {
    ky: "📝 Распознанный текст",
    tg: "📝 Матни садокашонишуда",
    uz: "📝 Tanilgan matn",
    en: "📝 Recognized text",
    ru: "📝 Распознанный текст",
  },
  referenceText: {
    ky: "📖 Эталондуу текст",
    tg: "📖 Матни эталонӣ",
    uz: "📖 Etalon matn",
    en: "📖 Reference text",
    ru: "📖 Эталонный текст",
  },
  wantTranslate: {
    ky: "Текстти которгүңүз келеби? Тилди тандаңыз:",
    tg: "Мехоҳед матнро тарҷума кунед? Забонро интихоб кунед:",
    uz: "Matnni tarjima qilmoqchimisiz? Tilni tanlang:",
    en: "Would you like to translate the text? Choose a language:",
    ru: "Хотите перевести текст? Выберите язык:",
  },
  noSpeech: {
    ky: "🤷 Бул файлда сүйлөм табылган жок.",
    tg: "🤷 Дар ин файл сухан ёфт нашуд.",
    uz: "🤷 Ushbu faylda nutq topilmadi.",
    en: "🤷 No speech detected in this file.",
    ru: "🤷 В этом файле не удалось распознать речь.",
  },
  transcriptionFailed: {
    ky: "❌ Распознаоо ишке ашкан жок: {error}",
    tg: "❌ Транскрипция иҷро нашуд: {error}",
    uz: "❌ Transkripsiya amalga oshmadi: {error}",
    en: "❌ Transcription failed: {error}",
    ru: "❌ Распознавание не удалось: {error}",
  },
  processingStopped: {
    ky: "🛑 Процесс токтотулду.",
    tg: "🛑 Процесс қатъ карда шуд.",
    uz: "🛑 Jarayon to'xtatildi.",
    en: "🛑 Processing stopped.",
    ru: "🛑 Обработка остановлена.",
  },
  chooseTestLanguage: {
    ky: "🧪 Кайсы тилде текшеребиз?",
    tg: "🧪 Ба кадом забон санҷиш гузаронем?",
    uz: "🧪 Qaysi tilda sinaymiz?",
    en: "🧪 Which language should we test?",
    ru: "🧪 На каком языке проверим?",
  },
  noTranslation: {
    ky: "❌ Которбоой",
    tg: "❌ Бе тарҷума",
    uz: "❌ Tarjimasiz",
    en: "❌ No translation",
    ru: "❌ Без перевода",
  },
  testAllLanguages: {
    ky: "🔁 Бардык тилдер",
    tg: "🔁 Ҳамаи забонҳо",
    uz: "🔁 Barcha tillar",
    en: "🔁 All languages",
    ru: "🔁 Все языки",
  },
  translationComplete: {
    ky: "✅ Которуу аяктады!",
    tg: "✅ Тарҷума анҷом ёфт!",
    uz: "✅ Tarjima tugadi!",
    en: "✅ Translation complete!",
    ru: "✅ Перевод готов!",
  },
  nothingToStop: {
    ky: "ℹ️ Токтотуу үчүн активдүү процесс жок.",
    tg: "ℹ️ Процесси фаъол барои қатъ кардан нест.",
    uz: "ℹ️ To'xtatish uchun faol jarayon yo'q.",
    en: "ℹ️ No active process to stop.",
    ru: "ℹ️ Нет активного процесса для остановки.",
  },
  mainMenuHint: {
    ky: "Төмөнкү баскычтарды колдонуңуз:",
    tg: "Аз тугмаҳои зерин истифода баред:",
    uz: "Quyidagi tugmalardan foydalaning:",
    en: "Use the buttons below:",
    ru: "Используйте кнопки ниже:",
  },
  confirmStart: {
    ky: "🎙️ Тил: {source} → {target}\n\nРаспознаоо башталсынбы?",
    tg: "🎙️ Забон: {source} → {target}\n\nОёғози транскрипция кунем?",
    uz: "🎙️ Til: {source} → {target}\n\nTranskripsiyani boshlaysizmi?",
    en: "🎙️ Language: {source} → {target}\n\nStart transcription?",
    ru: "🎙️ Язык: {source} → {target}\n\nНачать распознавание?",
  },
  confirmStartNoTranslation: {
    ky: "🎙️ Тил: {source} (которуу жок)\n\nРаспознаоо башталсынбы?",
    tg: "🎙️ Забон: {source} (бе тарҷума)\n\nОёғози транскрипция кунем?",
    uz: "🎙️ Til: {source} (tarjimasiz)\n\nTranskripsiyani boshlaysizmi?",
    en: "🎙️ Language: {source} (no translation)\n\nStart transcription?",
    ru: "🎙️ Язык: {source} (без перевода)\n\nНачать распознавание?",
  },
  youtubePreview: {
    ky: "📺 <b>{title}</b>\n<i>YouTube видеосу</i>\n\nТилди тандаңыз жана иштей баштаңыз.",
    tg: "📺 <b>{title}</b>\n<i>Видеои YouTube</i>\n\nЗабонро интихоб кунед ва оғоз кунед.",
    uz: "📺 <b>{title}</b>\n<i>YouTube videosi</i>\n\nTilni tanlang va ishni boshlang.",
    en: "📺 <b>{title}</b>\n<i>YouTube video</i>\n\nChoose language and start.",
    ru: "📺 <b>{title}</b>\n<i>Видео YouTube</i>\n\nВыберите язык и начните.",
  },
  invalidYoutube: {
    ky: "❌ Бул туура YouTube шилтемеси эмес. Кайра жибериңиз.",
    tg: "❌ Ин пайванди дурусти YouTube нест. Дубора фиристед.",
    uz: "❌ Bu to'g'ri YouTube havolasi emas. Qayta yuboring.",
    en: "❌ This is not a valid YouTube link. Please send it again.",
    ru: "❌ Это неправильная ссылка на YouTube. Отправьте ещё раз.",
  },
  settingsMenu: {
    ky: "⚙️ Орнотуулар\n\nКайсы параметрди өзгөрткүңүз келет?",
    tg: "⚙️ Танзимот\n\nКадом параметрро тағйир медиҳед?",
    uz: "⚙️ Sozlamalar\n\nQaysi parametrni o'zgartirmoqchisiz?",
    en: "⚙️ Settings\n\nWhich parameter would you like to change?",
    ru: "⚙️ Настройки\n\nКакой параметр хотите изменить?",
  },
  sourceLanguageSet: {
    ky: "✅ Распознаоо тили сакталды: {lang}",
    tg: "✅ Забони транскрипция сабт шуд: {lang}",
    uz: "✅ Transkripsiya tili saqlandi: {lang}",
    en: "✅ Transcription language saved: {lang}",
    ru: "✅ Язык распознавания сохранён: {lang}",
  },
  targetLanguageSet: {
    ky: "✅ Которуу тили сакталды: {lang}",
    tg: "✅ Забони тарҷума сабт шуд: {lang}",
    uz: "✅ Tarjima tili saqlandi: {lang}",
    en: "✅ Translation language saved: {lang}",
    ru: "✅ Язык перевода сохранён: {lang}",
  },
  interfaceLanguageSet: {
    ky: "✅ Интерфейстин тили сакталды: {lang}",
    tg: "✅ Забони интерфейс сабт шуд: {lang}",
    uz: "✅ Interfeys tili saqlandi: {lang}",
    en: "✅ Interface language saved: {lang}",
    ru: "✅ Язык интерфейса сохранён: {lang}",
  },
  unsupportedFileType: {
    ky: "❌ Бул файл түрү колдойбойт. Аудио же видео жибериңиз.",
    tg: "❌ Ин навъи файл дастгирӣ намешавад. Аудио ё видео фиристед.",
    uz: "❌ Bu fayl turi qo'llab-quvvatlanmaydi. Audio yoki video yuboring.",
    en: "❌ Unsupported file type. Please send audio or video.",
    ru: "❌ Неподдерживаемый тип файла. Отправьте аудио или видео.",
  },
  fileTooLarge: {
    ky: "❌ Файл өтө чоң ({size} МБ). Максимум 25 МБ.",
    tg: "❌ Файл хеле калон аст ({size} МБ). Ҳадди аксар 25 МБ.",
    uz: "❌ Fayl juda katta ({size} MB). Maksimum 25 MB.",
    en: "❌ File is too large ({size} MB). Max allowed is 25 MB.",
    ru: "❌ Файл слишком большой ({size} МБ). Максимум 25 МБ.",
  },
  back: {
    ky: "🔙 Артка",
    tg: "🔙 Бозгашт",
    uz: "🔙 Orqaga",
    en: "🔙 Back",
    ru: "🔙 Назад",
  },
  start: {
    ky: "▶️ Баштоо",
    tg: "▶️ Оғоз кардан",
    uz: "▶️ Boshlash",
    en: "▶️ Start",
    ru: "▶️ Начать",
  },
  changeLanguage: {
    ky: "🌐 Тилди өзгөртүү",
    tg: "🌐 Тағйири забон",
    uz: "🌐 Tilni o'zgartirish",
    en: "🌐 Change language",
    ru: "🌐 Изменить язык",
  },
  autoDetect: {
    ky: "🌍 Авто аныктоо",
    tg: "🌍 Авто муайянкунӣ",
    uz: "🌍 Avto aniqlash",
    en: "🌍 Auto detect",
    ru: "🌍 Автоопределение",
  },
  multilingual: {
    ky: "🌍 Auto / Көп тилдүү",
    tg: "🌍 Auto / Бисёрзабона",
    uz: "🌍 Auto / Ko'p tilli",
    en: "🌍 Auto / Multilingual",
    ru: "🌍 Auto / Мультиязычный",
  },
  settingsSourceLanguage: {
    ky: "🎙️ Распознаоо тили",
    tg: "🎙️ Забони транскрипция",
    uz: "🎙️ Transkripsiya tili",
    en: "🎙️ Transcription language",
    ru: "🎙️ Язык распознавания",
  },
  settingsTargetLanguage: {
    ky: "🌐 Которуу тили",
    tg: "🌐 Забони тарҷума",
    uz: "🌐 Tarjima tili",
    en: "🌐 Translation language",
    ru: "🌐 Язык перевода",
  },
  helpButton: {
    ky: "❓ Жардам",
    tg: "❓ Кӯмак",
    uz: "❓ Yordam",
    en: "❓ Help",
    ru: "❓ Помощь",
  },
  settingsInterfaceLanguage: {
    ky: "🌍 Интерфейс тили",
    tg: "🌍 Забони интерфейс",
    uz: "🌍 Interfeys tili",
    en: "🌍 Interface language",
    ru: "🌍 Язык интерфейса",
  },
  noDefaultTarget: {
    ky: "❌ Которуу жок",
    tg: "❌ Бе тарҷума",
    uz: "❌ Tarjimasiz",
    en: "❌ No translation",
    ru: "❌ Без перевода",
  },
};

export function t(key: keyof typeof TRANSLATIONS, lang: SupportedLanguage, vars?: Record<string, string>): string {
  let text = TRANSLATIONS[key]?.[lang] ?? TRANSLATIONS[key]?.["en"] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// User preferences
// ---------------------------------------------------------------------------
export interface UserPreferences {
  interfaceLanguage: SupportedLanguage;
  sourceLanguage: SupportedLanguage | "auto" | "multi";
  targetLanguage: SupportedLanguage | "none";
}

function normalizeInterfaceLanguage(lang: string | null | undefined): SupportedLanguage {
  if (lang && SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) {
    return lang as SupportedLanguage;
  }
  return "ru";
}

function normalizeSourceLanguage(lang: string | null | undefined): SupportedLanguage | "auto" | "multi" {
  if (lang === "multi" || lang === "auto") return lang;
  if (lang && SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) return lang as SupportedLanguage;
  return "auto";
}

function normalizeTargetLanguage(lang: string | null | undefined): SupportedLanguage | "none" {
  if (lang === "none") return "none";
  if (lang && SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) return lang as SupportedLanguage;
  return "none";
}

export function mapTelegramLanguageCode(code: string | undefined): SupportedLanguage {
  if (!code) return "ru";
  const map: Record<string, SupportedLanguage> = {
    ky: "ky",
    tg: "tg",
    uz: "uz",
    en: "en",
    ru: "ru",
    "ru-RU": "ru",
    "en-US": "en",
    "en-GB": "en",
    "ky-KG": "ky",
    "tg-TJ": "tg",
    "uz-UZ": "uz",
    "uz-Cyrl": "uz",
  };
  return map[code] ?? "ru";
}

export async function ensureUserProfile(
  chatId: number,
  telegramLanguageCode?: string
): Promise<UserPreferences> {
  const existing = await getUserByChatId(chatId);
  if (existing) {
    return {
      interfaceLanguage: normalizeInterfaceLanguage(existing.interface_language),
      sourceLanguage: normalizeSourceLanguage(existing.preferred_language),
      targetLanguage: normalizeTargetLanguage(existing.target_language),
    };
  }
  const detected = mapTelegramLanguageCode(telegramLanguageCode);
  const target = detected === "ru" ? "en" : "ru";
  await ensureUser(chatId, {
    interface_language: detected,
    preferred_language: "auto",
    target_language: target,
  });
  logger.info("New user profile created", { chatId, detectedLang: detected });
  return {
    interfaceLanguage: detected,
    sourceLanguage: "auto",
    targetLanguage: target,
  };
}

export async function getUserPreferences(chatId: number): Promise<UserPreferences> {
  const user = await getUserByChatId(chatId);
  return {
    interfaceLanguage: normalizeInterfaceLanguage(user?.interface_language),
    sourceLanguage: normalizeSourceLanguage(user?.preferred_language),
    targetLanguage: normalizeTargetLanguage(user?.target_language),
  };
}

export async function setUserInterfaceLanguage(chatId: number, lang: SupportedLanguage): Promise<void> {
  await updateUserPreferences(chatId, { interface_language: lang });
  logger.info("Interface language updated", { chatId, lang });
}

export async function setUserSourceLanguage(chatId: number, lang: SupportedLanguage | "auto" | "multi"): Promise<void> {
  await updateUserPreferences(chatId, { preferred_language: lang });
  logger.info("Source language updated", { chatId, lang });
}

export async function setUserTargetLanguage(chatId: number, lang: SupportedLanguage | "none"): Promise<void> {
  await updateUserPreferences(chatId, { target_language: lang });
  logger.info("Target language updated", { chatId, lang });
}

// Legacy helpers kept for compatibility
export async function getUserLanguage(chatId: number): Promise<string | undefined> {
  const prefs = await getUserPreferences(chatId);
  return prefs.sourceLanguage;
}

export async function setUserLanguage(chatId: number, lang: string): Promise<void> {
  await setUserSourceLanguage(chatId, lang as SupportedLanguage | "auto" | "multi");
}

export async function getInterfaceLanguage(chatId: number): Promise<SupportedLanguage> {
  const prefs = await getUserPreferences(chatId);
  return prefs.interfaceLanguage;
}

export async function setInterfaceLanguage(chatId: number, lang: SupportedLanguage): Promise<void> {
  await setUserInterfaceLanguage(chatId, lang);
}

// ---------------------------------------------------------------------------
// Pending actions with TTL
// ---------------------------------------------------------------------------
export interface PendingMedia {
  type: "media";
  buffer: Buffer;
  filename: string;
  messageId: number;
  dbMessageId: number;
  sourceLanguage?: SupportedLanguage | "auto" | "multi";
  targetLanguage?: SupportedLanguage | "none";
  createdAt: number;
}

export interface PendingYouTube {
  type: "youtube";
  url: string;
  title?: string;
  sourceLanguage?: SupportedLanguage | "auto" | "multi";
  targetLanguage?: SupportedLanguage | "none";
  createdAt: number;
}

export type PendingAction = PendingMedia | PendingYouTube;
type PendingActionWithId = (PendingMedia | PendingYouTube) & { actionId: string };

const pendingActions = new Map<number, PendingActionWithId>();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanExpiredPendingActions(): void {
  const now = Date.now();
  for (const [chatId, action] of pendingActions.entries()) {
    if (now - action.createdAt > PENDING_TTL_MS) {
      pendingActions.delete(chatId);
    }
  }
}

export function getPendingAction(chatId: number): PendingActionWithId | undefined {
  cleanExpiredPendingActions();
  return pendingActions.get(chatId);
}

export function setPendingAction(chatId: number, action: PendingAction): string {
  cleanExpiredPendingActions();
  const actionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingActions.set(chatId, { ...action, actionId } as PendingActionWithId);
  return actionId;
}

export function updatePendingAction(chatId: number, updates: Partial<PendingAction>): void {
  const existing = pendingActions.get(chatId);
  if (existing) {
    pendingActions.set(chatId, { ...existing, ...updates } as PendingActionWithId);
  }
}

export function clearPendingAction(chatId: number): void {
  pendingActions.delete(chatId);
}

// ---------------------------------------------------------------------------
// Active processes
// ---------------------------------------------------------------------------
export interface ActiveProcess {
  pid: number;
  startTime: number;
  statusMessageId?: number;
  type: "media" | "youtube" | "test";
}

const activeProcesses = new Map<number, ActiveProcess>();

export function getActiveProcess(chatId: number): ActiveProcess | undefined {
  return activeProcesses.get(chatId);
}

export function setActiveProcess(chatId: number, process: ActiveProcess): void {
  activeProcesses.set(chatId, process);
}

export function clearActiveProcess(chatId: number): void {
  activeProcesses.delete(chatId);
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------
export async function sendTextMessage(
  chatId: number,
  text: string,
  options?: {
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
    replyToMessageId?: number;
  }
): Promise<number> {
  let firstMessageId = 0;
  const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "HTML",
    };

    if (i === chunks.length - 1 && options?.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }

    if (i === 0 && options?.replyToMessageId) {
      body.reply_to_message_id = options.replyToMessageId;
    }

    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Telegram sendMessage failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    if (i === 0 && data.result?.message_id) {
      firstMessageId = data.result.message_id;
    }

    logger.debug("Sent message chunk to Telegram", { chatId, chunkIndex: i, totalChunks: chunks.length });
  }

  return firstMessageId;
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";
  const paragraphs = text.split("\n\n");

  for (const para of paragraphs) {
    if ((current + para + "\n\n").length <= maxLength) {
      current += para + "\n\n";
    } else {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      if (para.length > maxLength) {
        const lines = para.split("\n");
        for (const line of lines) {
          if ((current + line + "\n").length <= maxLength) {
            current += line + "\n";
          } else {
            if (current) {
              chunks.push(current.trim());
              current = "";
            }
            if (line.length > maxLength) {
              const words = line.split(" ");
              for (const word of words) {
                if ((current + word + " ").length <= maxLength) {
                  current += word + " ";
                } else {
                  if (current) {
                    chunks.push(current.trim());
                    current = "";
                  }
                  current = word + " ";
                }
              }
            } else {
              current = line + "\n";
            }
          }
        }
      } else {
        current = para + "\n\n";
      }
    }
  }

  if (current) {
    chunks.push(current.trim());
  }

  return chunks;
}

export async function sendDocument(
  chatId: number,
  documentBuffer: Buffer,
  filename: string,
  caption?: string,
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] }
): Promise<number> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([new Uint8Array(documentBuffer)]), filename);
  if (caption) {
    form.append("caption", caption);
  }
  if (replyMarkup) {
    form.append("reply_markup", JSON.stringify(replyMarkup));
  }

  const res = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: "POST",
    body: form as unknown as any,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram sendDocument failed: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
  logger.debug("Sent document to Telegram", { chatId, filename });
  return data.result?.message_id ?? 0;
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  options?: { replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] } }
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  };
  if (options?.replyMarkup) {
    body.reply_markup = options.replyMarkup;
  }

  const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 400 && errText.includes("message is not modified")) {
      return;
    }
    throw new Error(`Telegram editMessageText failed: ${res.status} ${errText}`);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };

  if (text) {
    body.text = text;
    body.show_alert = false;
  }

  const res = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram answerCallbackQuery failed: ${res.status} ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------
export function createMainKeyboard(lang: SupportedLanguage): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [{ text: "🔗 YouTube", callback_data: "action:youtube" }],
      [
        { text: t("settingsInterfaceLanguage", lang), callback_data: "action:settings:interface" },
        { text: t("settingsSourceLanguage", lang), callback_data: "action:settings:source" },
      ],
      [
        { text: t("settingsTargetLanguage", lang), callback_data: "action:settings:target" },
        { text: t("helpButton", lang), callback_data: "action:help" },
      ],
      [
        { text: "🧪 Test", callback_data: "action:test" },
        { text: "🛑 Stop", callback_data: "action:stop" },
      ],
    ],
  };
}

export function createSettingsMenuKeyboard(lang: SupportedLanguage): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [{ text: t("settingsInterfaceLanguage", lang), callback_data: "action:settings:interface" }],
      [{ text: t("settingsSourceLanguage", lang), callback_data: "action:settings:source" }],
      [{ text: t("settingsTargetLanguage", lang), callback_data: "action:settings:target" }],
      [{ text: t("back", lang), callback_data: "action:main" }],
    ],
  };
}

export function createInterfaceLanguageKeyboard(backAction = "action:main"): { inline_keyboard: InlineKeyboardButton[][] } {
  const buttons = SUPPORTED_LANGUAGES.map((lang) => ({
    text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
    callback_data: `ui_lang:${lang}`,
  }));
  return {
    inline_keyboard: [buttons.slice(0, 3), buttons.slice(3, 5), [{ text: "🔙 Back", callback_data: backAction }]],
  };
}

export function createSourceLanguageKeyboard(
  action: "default" | `confirm:${string}`,
  backAction = "action:main"
): { inline_keyboard: InlineKeyboardButton[][] } {
  const languages: (SupportedLanguage | "auto")[] = ["auto", ...SUPPORTED_LANGUAGES];
  const buttons = languages.map((lang) => ({
    text: lang === "auto" ? "🌍 Auto detect" : `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
    callback_data: lang === "auto" ? `source:auto:${action}` : `source:${lang}:${action}`,
  }));
  return {
    inline_keyboard: [buttons.slice(0, 3), buttons.slice(3, 6), [{ text: "🔙 Back", callback_data: backAction }]],
  };
}

export function createTargetLanguageKeyboard(
  action: "default" | `confirm:${string}`,
  backAction = "action:main"
): { inline_keyboard: InlineKeyboardButton[][] } {
  const buttons = SUPPORTED_LANGUAGES.map((lang) => ({
    text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
    callback_data: `target:${lang}:${action}`,
  }));
  return {
    inline_keyboard: [
      buttons.slice(0, 3),
      buttons.slice(3, 5),
      [
        { text: "❌ No translation", callback_data: `target:none:${action}` },
      ],
      [{ text: "🔙 Back", callback_data: backAction }],
    ],
  };
}

export function createConfirmationKeyboard(actionId: string, lang: SupportedLanguage): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [{ text: t("start", lang), callback_data: `confirm:start:${actionId}` }],
      [
        { text: t("changeLanguage", lang), callback_data: `confirm:lang:${actionId}` },
        { text: t("back", lang), callback_data: `confirm:cancel:${actionId}` },
      ],
    ],
  };
}

export function createTestLanguageKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
  const buttons = SUPPORTED_LANGUAGES.map((lang) => ({
    text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
    callback_data: `test_lang:${lang}`,
  }));
  return {
    inline_keyboard: [
      buttons.slice(0, 3),
      buttons.slice(3, 5),
      [{ text: "🔁 All languages", callback_data: "test_lang:all" }],
    ],
  };
}

export function createTranslationKeyboard(transcriptionId: number): { inline_keyboard: InlineKeyboardButton[][] } {
  const buttons = SUPPORTED_LANGUAGES.map((lang) => ({
    text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
    callback_data: `translate:${lang}:${transcriptionId}`,
  }));
  return {
    inline_keyboard: [buttons.slice(0, 3), buttons.slice(3, 5)],
  };
}

export function createStopKeyboard(lang: SupportedLanguage, processId: string): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [[{ text: "🛑 Stop", callback_data: `stop:${processId}` }]],
  };
}

export function createQuickActionsKeyboard(lang: SupportedLanguage): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [{ text: "🔗 YouTube", callback_data: "action:youtube" }],
      [{ text: t("back", lang), callback_data: "action:main" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// HTML sanitization
// ---------------------------------------------------------------------------
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
