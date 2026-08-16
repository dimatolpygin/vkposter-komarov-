import * as settings from '../repo/settings.js';
import { query } from '../db/pool.js';
import { checkSource } from './check-source.js';
import { captureError } from './capture-error.js';
import { log, errFields } from '../logger.js';

const logger = log('обновление');

/**
 * Обход всех источников перед прогоном.
 *
 * Зачем отдельным шагом: прогон строит план из того, что уже лежит в базе, а обход
 * сайтов раньше запускался только при нехватке материалов (`backfillArticles`). Пока
 * запас в базе был, свежие статьи не забирались вовсе — на проде источники не
 * проверялись двое суток подряд, хотя крон отработал оба дня. Система публиковала
 * накопленное, а новое на сайтах старело.
 *
 * Порядок работы прогона теперь такой: сначала забрать свежее со всех сайтов, потом
 * строить план (он идёт от свежих к старым), и только если материалов всё равно не
 * хватило — уходить вглубь архива добором.
 *
 * Сбой одного источника не должен ронять прогон: сайт лежит или отдал мусор — это
 * запись в журнале ошибок, а не отмена публикаций на день.
 */

/** Не перечитывать источник, если его смотрели совсем недавно (ручные прогоны подряд). */
const DEFAULT_MIN_AGE_MINUTES = 60;

async function sourcesToCheck(minAgeMinutes) {
  const { rows } = await query(
    `SELECT * FROM sources
      WHERE is_active = true
        AND code <> 'manual'
        AND (last_checked_at IS NULL OR last_checked_at < now() - ($1 || ' minutes')::interval)
      ORDER BY last_checked_at ASC NULLS FIRST, id`,
    [String(minAgeMinutes)],
  );
  return rows;
}

/**
 * Забрать свежие материалы со всех активных источников.
 *
 * @param {object} [options]
 * @param {number} [options.minAgeMinutes] сколько минут источник считается свежепроверенным
 * @returns {Promise<{checked: number, added: number, extracted: number, failed: number,
 *   skipped?: string}>}
 */
export async function refreshSources({ minAgeMinutes } = {}) {
  const enabled = (await settings.get('refresh_sources_enabled', 'on')) === 'on';
  if (!enabled) {
    return { checked: 0, added: 0, extracted: 0, failed: 0, skipped: 'обновление источников выключено' };
  }

  const minAge = minAgeMinutes
    ?? (await settings.getInt('refresh_sources_min_age_minutes', DEFAULT_MIN_AGE_MINUTES));
  const list = await sourcesToCheck(minAge);
  if (list.length === 0) {
    return { checked: 0, added: 0, extracted: 0, failed: 0, skipped: 'все источники проверены недавно' };
  }

  const stats = { checked: 0, added: 0, extracted: 0, failed: 0 };
  logger.info(
    { источников: list.length },
    `Обновление источников перед прогоном: ${list.length} сайтов`,
  );

  for (const source of list) {
    try {
      const result = await checkSource(source, { kind: 'source_check' });
      stats.checked += 1;
      stats.added += result.added;
      stats.extracted += result.extracted;
    } catch (error) {
      stats.failed += 1;
      logger.error(
        { источник: source.code, ...errFields(error) },
        `Источник ${source.code} не обновился — прогон продолжается без него`,
      );
      // checkSource пишет свою запись в журнал сам; здесь только на случай сбоя вне его.
      if (!error.captured) {
        await captureError('обновление источников', error, { sourceId: source.id }).catch(() => {});
      }
    }
  }

  logger.info(
    stats,
    `Источники обновлены: проверено ${stats.checked}, новых материалов ${stats.added}, ` +
      `текстов ${stats.extracted}, сбоев ${stats.failed}`,
  );
  return stats;
}
