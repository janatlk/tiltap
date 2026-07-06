export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  video?: TelegramVideo;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  caption?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance: string;
  data: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  thumbnail?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TranscriptionSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  confidence?: number;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  segments: TranscriptionSegment[];
  warning?: string;
  /** STT provider that produced this result (e.g. 'openai', 'groq', 'elevenlabs', 'local', 'remote'). */
  provider?: string;
  /** STT model name used by the provider. */
  model?: string;
  /** GPU name that processed the job, if applicable. */
  gpu?: string;
}

export interface TranslateRequest {
  text: string;
  targetLang: string;
  sourceLang?: string;
  /** Optional traceability: YouTube/media URL that produced the source text. */
  sourceUrl?: string;
  /** Optional traceability: 'text' | 'youtube' | 'audio' | 'telegram' | 'web'. */
  sourceType?: string;
}

export interface TranslateResponse {
  translatedText: string;
  detectedLang: string;
  warning?: string;
  /** Public request number that the user can quote when reporting errors. */
  requestId?: number;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}
