import * as settings from '../repo/settings.js';
import { query } from '../db/pool.js';
import { checkSource } from './check-source.js';
import { log, errFields } from '../logger.js';

const logger = log('добор');

/**
 * Добор старых тем.
 *
 * Задача из брифа: «если свежего за окно меньше, чем нужно постов, очередь дополняется
 * более ранними материалами, пока не наберётся план». Дефицит бывает двух видов, и лечатся
 * они по-разному:
 *
 * 1. **Материалы в базе есть, но все свежие уже отработаны.** Тут ничего делать не надо:
 *    очередь и так идёт по убыванию даты (`listArticlesForGeneration` без ограничения
 *    по свежести), то есть после свежих сами собой берутся более ранние.
 * 2. **Материалов в базе просто нет.** Обнаружение забирает только окно `freshness_window_days`,
 *    и когда всё в нём использовано, добирать нечего. Тогда окно расширяется — 2×, 4×, 8×
 *    от обычного, до потолка `topic_backfill_max_days` — и источники перечитываются заново.
 *
 * Этот файл занимается вторым случаем. Массовая заливка всего архива — отдельная история
 * (этап 10), здесь берётся ровно столько, сколько не хватает плану.
 */

/** Активные источники, свежие первыми — у кого дольше не проверяли, того и читаем раньше. */
async function activeSources() {
  const { rows } = await query(
    `SELECT * FROM sources
      WHERE is_active = true AND code <> 'manual'
      ORDER BY last_checked_at ASC NULLS FIRST, id`,
  );
  return rows;
}

/**
 * Дособрать материалы, когда план не набрался.
 *
 * @param {number} deficit сколько материалов не хватает
 * @param {object} [options]
 * @param {number} [options.maxSources] сколько источников обойти максимум за раз
 * @returns {Promise<{added: number, checked: number, days: number|null, skipped?: string}>}
 */
export async function backfillArticles(deficit, { maxSources = 5 } = {}) {
  if (deficit <= 0) return { added: 0, checked: 0, days: null };

  const enabled = (await settings.get('topic_backfill_enabled', 'on')) === 'on';
  if (!enabled) {
    return { added: 0, checked: 0, days: null, skipped: 'добор выключен в настройках' };
  }

  const baseDays = await settings.getInt('freshness_window_days', 30);
  const maxDays = await settings.getInt('topic_backfill_max_days', 730);
  const sources = await activeSources();
  if (sources.length === 0) {
    return { added: 0, checked: 0, days: null, skipped: 'нет активных источников' };
  }

  let added = 0;
  let checked = 0;
  let usedDays = null;

  // Шагаем вглубь архива, а не сразу на два года: чем меньше окно, тем свежее материалы
  // и тем дешевле обход (у firecrawl лимит 1000 запросов в месяц).
  for (const multiplier of [2, 4, 8]) {
    const days = Math.min(maxDays, baseDays * multiplier);
    usedDays = days;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    logger.info(
      { нехватка: deficit, глубина_дней: days, источников: Math.min(sources.length, maxSources) },
      `Добор старых тем: не хватает ${deficit}, читаем источники за ${days} дней`,
    );

    for (const source of sources.slice(0, maxSources)) {
      try {
        const stats = await checkSource(source, { kind: 'backfill', since });
        checked += 1;
        added += stats.added;
        if (added >= deficit) break;
      } catch (error) {
        // Один недоступный сайт не должен отменять добор по остальным.
        logger.warn(
          { источник: source.code, ...errFields(error) },
          `Добор по источнику ${source.code} не удался: ${error.message}`,
        );
      }
    }

    if (added >= deficit) break;
    if (days >= maxDays) break;
  }

  logger.info(
    { добавлено: added, источников: checked, глубина_дней: usedDays },
    `Добор завершён: новых материалов ${added} (нужно было ${deficit}), ` +
      `обойдено источников ${checked}, глубина ${usedDays} дней`,
  );

  return { added, checked, days: usedDays };
}
