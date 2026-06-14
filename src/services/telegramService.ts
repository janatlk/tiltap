import { logger } from "../utils/logger";
import { config } from "../config";
import type { InlineKeyboardButton } from "../types";
import {
  getUserLanguage as getUserLanguageDb,
  setUserLanguage as setUserLanguageDb,
  getInterfaceLanguage as getInterfaceLanguageDb,
  setInterfaceLanguage as setInterfaceLanguageDb,
} from "../db/repos";

const TELEGRAM_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

// Telegram text message limit
const MAX_MESSAGE_LENGTH = 4000;

// Supported interface and transcription languages
export const SUPPORTED_LANGUAGES = ["ky", "tg", "uz", "en", "ru"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  ky: "Кыргызча",
  tg: "Тоҷикӣ",
  uz: "O'zbekча",
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

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------
const TRANSLATIONS: Record<string, Record<SupportedLanguage, string>> = {
  welcome: {
    ky: "👋 <b>TilTap</b>ке кош келиңиз!\n\nВидео, аудио жана YouTube шилтемелерин кыргызча, тоҷикӣ, ўзбекча, орусча жана англисча распознап, которуп берем.",
    tg: "👋 Хуш омадед ба <b>TilTap</b>!\n\nМан видео, аудио ва пайвандҳои YouTube-ро ба забонҳои қирғизӣ, тоҷикӣ, ӯзбекӣ, русӣ ва англисӣ транскрипция мекунам.",
    uz: "👋 <b>TilTap</b>ga xush kelibsiz!\n\nMen video, audio va YouTube havolalarini qirg'iz, tojik, o'zbek, rus va ingliz tillarida transkripsiya qilaman.",
    en: "👋 Welcome to <b>TilTap</b>!\n\nI transcribe video, audio, and YouTube links in Kyrgyz, Tajik, Uzbek, Russian, and English.",
    ru: "👋 Добро пожаловать в <b>TilTap</b>!\n\nЯ распознаю видео, аудио и ссылки YouTube на кыргызском, таджикском, узбекском, русском и английском.",
  },
  chooseInterfaceLanguage: {
    ky: "🌍 Интерфейстин тилин тандаңыз:",
    tg: "🌍 Забони интерфейсро интихоб кунед:",
    uz: "🌍 Interfeys tilini tanlang:",
    en: "🌍 Choose interface language:",
    ru: "🌍 Выберите язык интерфейса:",
  },
  chooseTranscriptionLanguage: {
    ky: "🎙️ Бул файл үчүн тилди тандаңыз:",
    tg: "🎙️ Барои ин файл забонро интихоб кунед:",
    uz: "🎙️ Ushbu fayl uchun tilni tanlang:",
    en: "🎙️ Choose language for this file:",
    ru: "🎙️ Выберите язык для этого файла:",
  },
  sendYoutubeLink: {
    ky: "🔗 YouTube шилтемесин жибериңиз:",
    tg: "🔗 Пайванди YouTube-ро фиристед:",
    uz: "🔗 YouTube havolasini yuboring:",
    en: "🔗 Send me a YouTube link:",
    ru: "🔗 Отправьте ссылку на YouTube:",
  },
  transcribing: {
    ky: "⏳ Распознаю... Сабыр кылыңыз.",
    tg: "⏳ Транскрипция мешавад... Илтимос, интизор шавед.",
    uz: "⏳ Transkripsiya qilinmoqda... Iltimos, kuting.",
    en: "⏳ Transcribing... Please wait.",
    ru: "⏳ Распознаю... Пожалуйста, подождите.",
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
    ky: "Тандалган текстти которгүңүз келеби?",
    tg: "Мехоҳед матни садокашонишуда тарҷума кунед?",
    uz: "Tanilgan matnni tarjima qilmoqchimisiz?",
    en: "Would you like to translate the recognized text?",
    ru: "Хотите перевести распознанный текст?",
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
  chooseTargetLanguage: {
    ky: "🌐 Кайсы тилге которолосуңуз?",
    tg: "🌐 Ба кадом забон тарҷума кунем?",
    uz: "🌐 Qaysi tilga tarjima qilay?",
    en: "🌐 Which language should I translate to?",
    ru: "🌐 На какой язык перевести?",
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
};

export function t(key: keyof typeof TRANSLATIONS, lang: SupportedLanguage): string {
  return TRANSLATIONS[key][lang];
}

// ---------------------------------------------------------------------------
// Pending actions / active processes
// ---------------------------------------------------------------------------
export interface PendingMedia {
  type: "media";
  buffer: Buffer;
  filename: string;
  messageId: number;
  dbMessageId: number;
  sourceLanguage?: string;
  targetLanguage?: string;
}

export interface PendingYouTube {
  type: "youtube";
  url?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

export type PendingAction = PendingMedia | PendingYouTube;

export const pendingActions = new Map<number, PendingAction>();

export interface ActiveProcess {
  pid: number;
  startTime: number;
  statusMessageId?: number;
}

export const activeProcesses = new Map<number, ActiveProcess>();

// ---------------------------------------------------------------------------
// User language helpers
// ---------------------------------------------------------------------------
export async function getUserLanguage(chatId: number): Promise<string | undefined> {
  const lang = await getUserLanguageDb(chatId);
  return lang ?? undefined;
}

export async function setUserLanguage(chatId: number, lang: string): Promise<void> {
  await setUserLanguageDb(chatId, lang);
  logger.info("User transcription language set", { chatId, lang });
}

export async function getInterfaceLanguage(chatId: number): Promise<SupportedLanguage> {
  const lang = await getInterfaceLanguageDb(chatId);
  return (SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage) ? lang : "ru") as SupportedLanguage;
}

export async function setInterfaceLanguage(chatId: number, lang: SupportedLanguage): Promise<void> {
  await setInterfaceLanguageDb(chatId, lang);
  logger.info("User interface language set", { chatId, lang });
}

export function getPendingAction(chatId: number): PendingAction | undefined {
  return pendingActions.get(chatId);
}

export function setPendingAction(chatId: number, action: PendingAction): void {
  pendingActions.set(chatId, action);
}

export function clearPendingAction(chatId: number): void {
  pendingActions.delete(chatId);
}

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
export function createInterfaceLanguageKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
  const languages: SupportedLanguage[] = ["ky", "tg", "uz", "en", "ru"];
  return {
    inline_keyboard: languages.map((lang) => [
      { text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`, callback_data: `ui_lang:${lang}` },
    ]),
  };
}

export function createTranscriptionLanguageKeyboard(actionId: string): { inline_keyboard: InlineKeyboardButton[][] } {
  const languages: SupportedLanguage[] = ["ky", "tg", "uz", "en", "ru"];
  const buttons = languages.map((lang) => ({
    text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
    callback_data: `transcribe_lang:${lang}:${actionId}`,
  }));

  return {
    inline_keyboard: [
      buttons.slice(0, 3),
      buttons.slice(3),
      [{ text: "🌍 Auto / Multilingual", callback_data: `transcribe_lang:multi:${actionId}` }],
    ],
  };
}

export function createMainKeyboard(lang: SupportedLanguage): { inline_keyboard: InlineKeyboardButton[][] } {
  const labels: Record<string, Record<SupportedLanguage, string>> = {
    youtube: {
      ky: "🔗 YouTube шилтемеси",
      tg: "🔗 Пайванди YouTube",
      uz: "🔗 YouTube havolasi",
      en: "🔗 YouTube link",
      ru: "🔗 Ссылка YouTube",
    },
    settings: {
      ky: "⚙️ Тил орнотуулар",
      tg: "⚙️ Танзимоти забон",
      uz: "⚙️ Til sozlamalari",
      en: "⚙️ Language settings",
      ru: "⚙️ Настройки языка",
    },
    stop: {
      ky: "🛑 Токтотуу",
      tg: "🛑 Истодан",
      uz: "🛑 To'xtatish",
      en: "🛑 Stop",
      ru: "🛑 Остановить",
    },
  };

  return {
    inline_keyboard: [
      [{ text: labels.youtube[lang], callback_data: "action:youtube" }],
      [
        { text: labels.settings[lang], callback_data: "action:settings" },
        { text: labels.stop[lang], callback_data: "action:stop" },
      ],
    ],
  };
}

export function createTargetLanguageKeyboard(
  actionId: string,
  sourceLanguage?: SupportedLanguage | "multi"
): { inline_keyboard: InlineKeyboardButton[][] } {
  const allLanguages: SupportedLanguage[] = ["ru", "en", "ky", "tg", "uz"];
  const languages = sourceLanguage === "multi" ? allLanguages : allLanguages.filter((l) => l !== sourceLanguage);
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < languages.length; i += 3) {
    rows.push(
      languages.slice(i, i + 3).map((lang) => ({
        text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
        callback_data: `translate_lang:${lang}:${actionId}`,
      }))
    );
  }
  rows.push([
    {
      text: "❌ Без перевода / No translation",
      callback_data: `translate_lang:none:${actionId}`,
    },
  ]);
  return { inline_keyboard: rows };
}

export function createTestLanguageKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
  const languages: SupportedLanguage[] = ["ky", "tg", "uz", "en", "ru"];
  const buttons = languages.map((lang) => ({
    text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
    callback_data: `test_lang:${lang}`,
  }));
  return {
    inline_keyboard: [
      buttons.slice(0, 3),
      buttons.slice(3),
      [{ text: "🔁 All languages / Бардык тилдер", callback_data: "test_lang:all" }],
    ],
  };
}

export function createTranslationKeyboard(transcriptionId: number): { inline_keyboard: InlineKeyboardButton[][] } {
  const languages: SupportedLanguage[] = ["ru", "en", "ky", "tg", "uz"];
  const buttons = languages.map((lang) => ({
    text: `${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}`,
    callback_data: `translate:${lang}:${transcriptionId}`,
  }));

  return {
    inline_keyboard: [buttons.slice(0, 3), buttons.slice(3)],
  };
}

export function createStopKeyboard(lang: SupportedLanguage, processId: string): { inline_keyboard: InlineKeyboardButton[][] } {
  const labels = {
    ky: "🛑 Токтотуу",
    tg: "🛑 Истодан",
    uz: "🛑 To'xtatish",
    en: "🛑 Stop",
    ru: "🛑 Остановить",
  };

  return {
    inline_keyboard: [[{ text: labels[lang], callback_data: `stop:${processId}` }]],
  };
}
