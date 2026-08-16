import { request } from '../../lib/http-client.js';
import { config } from '../../config.js';
import { log } from '../../logger.js';

const logger = log('адаптер:brokertribunal');

/**
 * brokertribunal.com — карта сайта у сайта есть, но она пустая: `/sitemap.xml` отдаёт
 * `<urlset/>` без единой записи, а раздел `/brokers` вообще отвечает 404. При этом сами
 * обзоры живут и открываются: `/brokers/<название>/overview`. Значит, обнаружение идёт
 * не картой, а листингом обзоров — тем самым, по которому ходит живой посетитель.
 *
 * Листингов два, и оба нужны клиенту: брокеры и инвестиционные проекты. Разметка у них
 * одна и та же, поэтому обходятся они одним кодом.
 *
 * Дата у карточки спрятана в HTML-комментарии — сайт её выводить перестал, но в разметке
 * оставил. Это единственный источник даты на листинге, поэтому читаем оттуда. Если сайт
 * когда-нибудь уберёт и комментарий, материалы пойдут без даты: попадут в базу, но в
 * очередь на пост встанут последними (сортировка идёт по дате). Молча всё не сломается.
 */

/** Разделы с обзорами. Порядок важен: брокеры для клиента первичны. */
const LISTINGS = ['/brokers/overviews', '/investment-projects/overviews'];

/** Потолок страниц на один раздел за проверку: у листинга их под сотню, весь архив не нужен. */
const MAX_PAGES = 10;

/** Пауза между страницами листинга: обход — это залп по чужому хосту. */
const PAGE_PAUSE_MS = 900;

/** Карточка обзора в листинге. Разметка одинаковая у обоих разделов. */
const CARD_SPLIT = /<div class="row g-mb-30 u-shadow-v11 g-pa-30">/;

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** «14 августа 2026» → полночь этого дня по UTC. */
function parseRuDate(value) {
  const match = /^\s*(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s*$/i.exec(value ?? '');
  if (!match) return null;
  const [, day, monthName, year] = match;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month < 0) return null;
  const date = new Date(Date.UTC(Number(year), month, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Текст из куска разметки: теги долой, сущности и пробелы в порядок. */
function plain(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Разбирает одну карточку листинга. Возвращает null, если это не карточка обзора. */
function parseCard(block, baseUrl) {
  // Заголовок и ссылка на обзор лежат в <h3>. У картинки выше по блоку ссылка та же,
  // но без текста — поэтому берём именно заголовочную.
  const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
  if (!heading) return null;
  const link = /href="([^"]*\/overview)"/i.exec(heading[1]);
  if (!link) return null;

  const url = new URL(link[1], baseUrl).toString();
  const title = plain(heading[1]) || null;
  const lastmod = parseRuDate(/<!--\s*<p[^>]*>([^<]+)<\/p>\s*-->/i.exec(block)?.[1]);
  const snippet = plain(
    /<p class="g-color-gray-dark-v4 g-line-height-1_8">([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? '',
  );

  // Название проекта — предпоследний сегмент адреса: /brokers/mitazco/overview.
  // Оно надёжнее заголовка: заголовок у сайта рекламный («Mitazco — обманный брокер…»),
  // а тема нужна чистая, иначе дедуп не сойдётся с тем же проектом на другом сайте.
  const slug = new URL(url).pathname.split('/').filter(Boolean).at(-2) ?? null;

  return {
    url,
    lastmod,
    title,
    topicHint: slug,
    snippet: snippet || null,
  };
}

async function fetchPage(url) {
  const response = await request(url, {
    label: 'brokertribunal',
    headers: { 'User-Agent': config.userAgent, Accept: 'text/html,*/*' },
    timeoutMs: 30_000,
    retries: 2,
    raw: true,
  });
  return response.text();
}

export async function discover(source, { since, until = null, limit }) {
  const baseUrl = source.base_url.replace(/\/$/, '');
  const items = [];
  const seen = new Set();

  for (const listing of LISTINGS) {
    let requests = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (items.length >= limit) break;
      if (requests > 0) await sleep(PAGE_PAUSE_MS);
      const url = page === 1 ? `${baseUrl}${listing}` : `${baseUrl}${listing}?page=${page}`;
      requests += 1;

      const html = await fetchPage(url);
      const cards = html.split(CARD_SPLIT).slice(1).map((block) => parseCard(block, baseUrl));
      const parsed = cards.filter(Boolean);
      if (parsed.length === 0) break;

      let fresherThanWindow = 0;
      for (const item of parsed) {
        // Без даты материал не отбрасываем: даты нет только когда сайт сломал разметку,
        // а обзор при этом настоящий. Но и «свежим» такой не считаем — на нём листинг
        // не продолжится.
        if (item.lastmod) {
          if (item.lastmod < since) continue;
          if (until && item.lastmod > until) continue;
          fresherThanWindow += 1;
        }
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        items.push(item);
        if (items.length >= limit) break;
      }

      // Листинг отсортирован от свежих к старым: как только на странице не осталось
      // ничего в окне свежести, дальше только архив — уходим к следующему разделу.
      if (fresherThanWindow === 0) break;
    }
  }

  items.sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0));
  const result = items.slice(0, limit);
  logger.info(
    { найдено: result.length, окно_с: since.toISOString().slice(0, 10) },
    `brokertribunal.com: обзоров в окне свежести — ${result.length}`,
  );
  return result;
}
