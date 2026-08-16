import { scrape } from '../../lib/firecrawl.js';
import { log } from '../../logger.js';

const logger = log('адаптер:scama');

/**
 * scama.net — единственный источник, закрытый от прямых запросов (403 Forbidden),
 * но доступный через firecrawl. Статей как таковых здесь нет: на /check лежит
 * таблица заявок на проверку — домен, дата и вердикт проверяющего.
 *
 * Поэтому источник работает в режиме «только тема»: темой становится проверяемый
 * домен, а вердикт идёт подсказкой в промт (ИИ пишет статью сам).
 *
 * Формат строки таблицы в markdown от firecrawl:
 * | [112169](https://scama.net/check?id=112169) <br>25.07.26 | quantrovatrade.com<br>25.07.26 | Возможны потери... |
 *
 * Одна проверка источника = один запрос к firecrawl на ~40 тем. Это осознанно дешёво:
 * лимит 1000/мес расходуется почти только здесь.
 */

const ROW_RE =
  /\|\s*\[(\d+)\]\((https?:\/\/[^)]+)\)\s*(?:<br\s*\/?>)?\s*([\d.]+)?\s*\|\s*([^|<]+?)\s*(?:<br\s*\/?>\s*([\d.]+))?\s*\|\s*([^|]*?)\s*\|/g;

/** Дата в таблице — ДД.ММ.ГГ. Преобразуем в UTC-полночь этого дня. */
function parseShortDate(value) {
  if (!value) return null;
  const match = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, dd, mm, yy] = match;
  const date = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd)));
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function discover(source, { since, until = null, limit }) {
  const checkUrl = `${source.base_url.replace(/\/$/, '')}/check`;
  const { markdown } = await scrape(checkUrl, { onlyMainContent: true });

  const items = [];
  const seen = new Set();

  for (const match of markdown.matchAll(ROW_RE)) {
    const [, id, requestUrl, dateA, resource, dateB, verdict] = match;
    const domain = resource?.trim().toLowerCase();
    if (!domain || !domain.includes('.') || domain.includes(' ')) continue;

    const date = parseShortDate(dateB) ?? parseShortDate(dateA);
    if (date && date < since) continue;
    if (date && until && date > until) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);

    items.push({
      // URL заявки уникален и стабилен — по нему работает дедуп
      url: requestUrl,
      lastmod: date,
      title: `Отзывы о ${domain}`,
      // вердикт проверяющего — единственный содержательный контекст со страницы
      topicHint: domain,
      snippet: verdict?.trim() || null,
      externalId: id,
    });
    if (items.length >= limit) break;
  }

  logger.info(
    { найдено: items.length, окно_с: since.toISOString().slice(0, 10) },
    `scama.net: тем в окне свежести — ${items.length}`,
  );
  return items;
}
