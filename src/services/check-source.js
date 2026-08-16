import { discoverSource } from '../sources/discovery.js';
import { fetchArticleViaWpApi } from '../sources/wp-api.js';
import * as firecrawl from '../lib/firecrawl.js';
import * as articles from '../repo/articles.js';
import * as runs from '../repo/runs.js';
import * as settings from '../repo/settings.js';
import { query } from '../db/pool.js';
import { captureError } from './capture-error.js';
import { log, errFields } from '../logger.js';
import { getRequestId, extendContext } from '../context.js';

const logger = log('проверка');

/** Блокировка на источник: параллельные проверки одного сайта не должны пересекаться. */
const LOCK_NAMESPACE = 771;

/** Пауза между запросами текстов одного сайта. */
const EXTRACT_PAUSE_MS = 600;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function withSourceLock(sourceId, fn) {
  const { rows } = await query('SELECT pg_try_advisory_lock($1, $2) AS locked', [
    LOCK_NAMESPACE,
    sourceId,
  ]);
  if (!rows[0].locked) {
    throw new Error('Проверка этого источника уже идёт — дождитесь её завершения');
  }
  try {
    return await fn();
  } finally {
    await query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, sourceId]).catch(() => {});
  }
}

/** Дата отсечки: настраиваемое окно свежести. */
export async function freshnessCutoff() {
  const days = await settings.getInt('freshness_window_days', 30);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Признаки страницы-заглушки антибота вместо статьи.
 *
 * Поймано на живом прогоне: vklader закрыт DDoS-Guard, и после блокировки адреса сервера
 * firecrawl вернул «Checking your browser before accessing vklader.com» — 251 символ.
 * Проверка «текста больше 200 символов» это пропустила, заглушка легла в базу как текст
 * статьи, и пост про проект CLW был написан по ней. Такие страницы надо отличать от
 * коротких статей: материал не испорчен, его просто надо перечитать позже.
 */
const BOT_WALL_MARKERS = [
  'ddos-guard',
  'checking your browser',
  'just a moment',
  'cf-browser-verification',
  'enable javascript and cookies',
  'проверка браузера',
  'доступ ограничен',
];

function looksLikeBotWall(text, title) {
  const value = `${title ?? ''}\n${text ?? ''}`.toLowerCase();
  // Длинная страница с этими словами — обычная статья про блокировки, а не заглушка.
  if (value.length > 1500) return false;
  return BOT_WALL_MARKERS.some((marker) => value.includes(marker));
}

/**
 * Извлечение текста одного материала.
 * Порядок попыток осознанный: сначала WP REST API (бесплатно и полный текст),
 * firecrawl — только как страховка, потому что у него 1000 запросов в месяц на проект.
 */
export async function extractOne(source, article) {
  if (source.fetch_via === 'wp_api') {
    try {
      const result = await fetchArticleViaWpApi(source, article.url);
      if (result?.text && result.text.length > 200) {
        return { ...result, via: 'wp_api' };
      }
      logger.warn(
        { url: article.url, символов: result?.text?.length ?? 0 },
        'WP API отдал слишком мало текста — уходим на firecrawl',
      );
    } catch (error) {
      logger.warn({ url: article.url, ...errFields(error) }, 'WP API не сработал — уходим на firecrawl');
    }
  }

  if (!firecrawl.isConfigured()) {
    throw new Error('Текст не извлечён: WP API не дал результата, а FIRECRAWL_API_KEY не задан');
  }
  let { markdown, title } = await firecrawl.scrape(article.url);

  // Заглушка могла прийти не с сайта, а из кэша firecrawl: он живёт двое суток, и одна
  // неудачная попытка залипает в нём вместе со страницей проверки браузера. Повторяем
  // без кэша — на живом примере это дало 4029 символов статьи вместо 251 символа
  // заглушки. Лишний расход лимита только в проблемном случае, не на каждой странице.
  if (looksLikeBotWall(markdown, title)) {
    logger.info({ url: article.url }, 'Ответ похож на страницу защиты от ботов — повторяю без кэша');
    ({ markdown, title } = await firecrawl.scrape(article.url, { fresh: true }));
  }

  if (looksLikeBotWall(markdown, title)) {
    const error = new Error('Сайт закрыт защитой от ботов — вместо статьи отдана заглушка');
    error.botWall = true;
    throw error;
  }
  return { title: title ?? article.title, text: markdown, via: 'firecrawl' };
}

/**
 * Полная проверка одного источника: обнаружение → сохранение → извлечение текста.
 * Пишет запись в runs, чтобы прогон был виден в панели и связан с логами по request-id.
 */
/**
 * @param {object} source строка sources
 * @param {object} [options]
 * @param {'source_check'|'backfill'|'archive'} [options.kind] чем инициирована проверка
 * @param {Date} [options.since] окно обнаружения; по умолчанию — `freshness_window_days`.
 *   Добор (этап 9) передаёт более раннюю дату, чтобы дочерпать архив, не трогая настройку.
 * @param {Date} [options.until] верхняя граница периода. Только наполнение из архива
 *   (этап 10): без неё активный сайт отдаёт свои свежие материалы вместо архивных.
 * @param {number} [options.discoveryLimit] сколько адресов забрать за раз (иначе настройка)
 * @param {number} [options.extractLimit] сколько текстов извлечь за раз (иначе настройка).
 *   Наполнение поднимает оба потолка: ему нужен не «свежий срез», а весь период.
 */
export async function checkSource(source, {
  kind = 'source_check',
  since: sinceOverride,
  until = null,
  discoveryLimit: discoveryLimitOverride,
  extractLimit: extractLimitOverride,
} = {}) {
  const requestId = getRequestId() ?? 'no-rid';
  const runId = await runs.startRun({ requestId, kind, meta: { source: source.code } });
  extendContext({ runId });

  const started = Date.now();
  const stats = {
    source: source.code,
    discovered: 0,
    added: 0,
    duplicates: 0,
    topicDuplicates: 0,
    listings: 0,
    invalid: 0,
    extracted: 0,
    extractFailed: 0,
    topicOnlyReady: 0,
    firecrawlCalls: 0,
  };

  try {
    return await withSourceLock(source.id, async () => {
      const since = sinceOverride ?? (await freshnessCutoff());
      const discoveryLimit = discoveryLimitOverride
        ?? (await settings.getInt('discovery_limit_per_source', 50));
      const extractLimit = extractLimitOverride
        ?? (await settings.getInt('extract_limit_per_check', 10));

      logger.info(
        {
          источник: source.code,
          окно_с: since.toISOString().slice(0, 10),
          окно_по: until ? new Date(until).toISOString().slice(0, 10) : null,
          лимит: discoveryLimit,
        },
        `Проверяем источник ${source.code}, период с ${since.toISOString().slice(0, 10)}` +
          (until ? ` по ${new Date(until).toISOString().slice(0, 10)}` : ''),
      );

      const candidates = await discoverSource(source, { since, until, limit: discoveryLimit });
      stats.discovered = candidates.length;

      for (const candidate of candidates) {
        const result = await articles.saveCandidate(source.id, candidate);
        if (result === 'added') stats.added += 1;
        else if (result === 'duplicate') stats.duplicates += 1;
        else if (result === 'topic_duplicate') stats.topicDuplicates += 1;
        else if (result === 'listing') stats.listings += 1;
        else stats.invalid += 1;
      }

      // Режим «только тема»: текст не нужен, материал сразу готов к генерации
      stats.topicOnlyReady = await articles.markTopicOnlyReady(source.id);

      // Извлечение текста — только для новых материалов. Уже извлечённые в выборку
      // не попадают, поэтому повторная проверка не расходует лимит заново.
      const pending = await articles.listPendingExtraction(source.id, extractLimit);
      for (const [index, article] of pending.entries()) {
        // Пауза между статьями. Тридцать запросов за десять секунд по одному хосту
        // выглядят как перебор: на проде vklader после такого залпа закрыл доступ
        // с адреса сервера по 403. Скорость здесь не важна, прогон фоновый.
        if (index > 0) await sleep(EXTRACT_PAUSE_MS);
        try {
          const extracted = await extractOne(source, article);
          if (extracted.via === 'firecrawl') stats.firecrawlCalls += 1;
          await articles.saveContent(article.id, extracted);
          stats.extracted += 1;
          // Заголовок появился только сейчас — тема, посчитанная по slug, уточняется
          // по нему, и материал может оказаться дублем уже известной темы.
          const topicResult = await articles.refreshTopic(article.id);
          if (topicResult === 'duplicate') stats.topicDuplicates += 1;
          logger.info(
            { url: article.url, символов: extracted.text.length, через: extracted.via, тема: topicResult },
            `Текст извлечён (${extracted.text.length} симв., ${extracted.via})`,
          );
        } catch (error) {
          stats.extractFailed += 1;
          // Заглушка антибота — временная беда сайта, а не брак материала: помечать
          // «failed» нельзя, иначе статья выбывает навсегда из-за одной блокировки.
          // Оставляем статус как есть, причину пишем в журнал, перечитаем в другой раз.
          if (error.botWall) {
            stats.botWalls = (stats.botWalls ?? 0) + 1;
            logger.warn(
              { url: article.url },
              'Сайт отдал страницу защиты от ботов — материал оставлен на следующий раз',
            );
          } else {
            await articles.markFailed(article.id, error.message);
          }
          await captureError('извлечение текста', error, {
            sourceId: source.id,
            articleId: article.id,
            url: article.url,
          });
          logger.error({ url: article.url, ...errFields(error) }, 'Извлечение текста упало');
        }
      }

      await query('UPDATE sources SET last_checked_at = now() WHERE id = $1', [source.id]);
      await runs.finishRun(runId, {
        status: 'done',
        found: stats.added,
        meta: { ...stats, ms: Date.now() - started },
      });

      logger.info(
        stats,
        `Источник ${source.code} проверен: найдено ${stats.discovered}, новых ${stats.added}, ` +
          `дублей URL ${stats.duplicates}, дублей темы ${stats.topicDuplicates}, ` +
          `служебных страниц ${stats.listings}, текстов извлечено ${stats.extracted}`,
      );
      return { runId, ...stats, ms: Date.now() - started };
    });
  } catch (error) {
    await runs.finishRun(runId, { status: 'failed', error: error.message, meta: stats });
    await captureError('проверка источника', error, { sourceId: source.id, runId });
    logger.error({ источник: source.code, ...errFields(error) }, `Проверка источника ${source.code} упала`);
    throw error;
  }
}
