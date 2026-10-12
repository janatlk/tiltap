import { query, queryOne } from "../db/connection";
import { logger } from "../utils/logger";

/**
 * Публичная сводка работы сервиса.
 *
 * Наружу уходят только числа: сколько запросов, сколько отказов, по каким
 * языкам. Ни текстов, ни ссылок, ни адресов — страница открыта всем, и всё,
 * что попадёт в этот ответ, окажется у любого желающего.
 *
 * Считаем по журналам запросов, а не по счётчикам в памяти: перезапуск
 * бэкенда не должен обнулять историю.
 */

export interface DailyPoint {
  day: string;
  translations: number;
  transcriptions: number;
  errors: number;
}

export interface PublicStats {
  totals: {
    translations: number;
    transcriptions: number;
    requests: number;
    errors: number;
    /** Доля отказов в процентах, округлённая до десятых. */
    errorRate: number;
  };
  daily: DailyPoint[];
  languages: { code: string; count: number }[];
  sources: { source: string; count: number }[];
  since: string | null;
  updatedAt: string;
}

// Считается тремя запросами по журналам; на каждое открытие страницы это
// лишняя работа для базы, а цифры за пять минут не устаревают.
const CACHE_MS = 5 * 60 * 1000;
let cached: { at: number; data: PublicStats } | null = null;

/** Языки, которые мы действительно поддерживаем: в журналах есть и мусор от проверок. */
const KNOWN_LANGUAGES = new Set(["ky", "tg", "uz", "ru", "en", "uz_cyrl"]);

interface TotalsRow {
  translations: string;
  transcriptions: string;
  errors: string;
  since: Date | null;
}

export async function getPublicStats(): Promise<PublicStats> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const totals = await queryOne<TotalsRow>(
    `SELECT
       (SELECT COUNT(*) FROM translation_requests) AS translations,
       (SELECT COUNT(*) FROM transcription_requests) + (SELECT COUNT(*) FROM web_jobs) AS transcriptions,
       (SELECT COUNT(*) FROM translation_requests WHERE error_message IS NOT NULL)
       + (SELECT COUNT(*) FROM transcription_requests WHERE status = 'error')
       + (SELECT COUNT(*) FROM web_jobs WHERE status = 'failed') AS errors,
       (SELECT MIN(created_at) FROM translation_requests) AS since`
  );

  // Отказ переводов ищем по error_message, а не по status: статус там остаётся
  // 'pending' почти всегда — успех его не переписывает, и считать по нему
  // значило бы объявить неудачей весь поток.
  const daily = await query<{ day: Date; translations: string; transcriptions: string; errors: string }>(
    `SELECT day,
            SUM(translations)::int AS translations,
            SUM(transcriptions)::int AS transcriptions,
            SUM(errors)::int AS errors
       FROM (
         SELECT date_trunc('day', created_at)::date AS day,
                COUNT(*) AS translations, 0 AS transcriptions,
                COUNT(*) FILTER (WHERE error_message IS NOT NULL) AS errors
           FROM translation_requests
          WHERE created_at > NOW() - INTERVAL '30 days'
          GROUP BY 1
         UNION ALL
         SELECT date_trunc('day', created_at)::date,
                0, COUNT(*), COUNT(*) FILTER (WHERE status = 'error')
           FROM transcription_requests
          WHERE created_at > NOW() - INTERVAL '30 days'
          GROUP BY 1
         UNION ALL
         SELECT date_trunc('day', created_at)::date,
                0, COUNT(*), COUNT(*) FILTER (WHERE status = 'failed')
           FROM web_jobs
          WHERE created_at > NOW() - INTERVAL '30 days'
          GROUP BY 1
       ) parts
      GROUP BY day
      ORDER BY day`
  );

  const languages = await query<{ code: string; count: string }>(
    `SELECT target_lang AS code, COUNT(*) AS count
       FROM translation_requests
      WHERE target_lang IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC`
  );

  const sources = await query<{ source: string; count: string }>(
    `SELECT source, SUM(count)::int AS count FROM (
       SELECT COALESCE(source_type, 'другое') AS source, COUNT(*) AS count
         FROM transcription_requests GROUP BY 1
       UNION ALL
       SELECT 'web', COUNT(*) FROM web_jobs
     ) parts
     GROUP BY source
     ORDER BY 2 DESC`
  );

  const translations = Number(totals?.translations ?? 0);
  const transcriptions = Number(totals?.transcriptions ?? 0);
  const errors = Number(totals?.errors ?? 0);
  const requests = translations + transcriptions;

  const data: PublicStats = {
    totals: {
      translations,
      transcriptions,
      requests,
      errors,
      errorRate: requests > 0 ? Math.round((errors / requests) * 1000) / 10 : 0,
    },
    daily: (daily ?? []).map((row) => ({
      day: new Date(row.day).toISOString().slice(0, 10),
      translations: Number(row.translations),
      transcriptions: Number(row.transcriptions),
      errors: Number(row.errors),
    })),
    languages: (languages ?? [])
      .filter((row) => KNOWN_LANGUAGES.has(row.code))
      .map((row) => ({ code: row.code, count: Number(row.count) })),
    sources: (sources ?? []).map((row) => ({ source: row.source, count: Number(row.count) })),
    since: totals?.since ? new Date(totals.since).toISOString().slice(0, 10) : null,
    updatedAt: new Date().toISOString(),
  };

  cached = { at: Date.now(), data };
  logger.info("Public stats recomputed", { requests, errors });
  return data;
}
