import { request } from '../../lib/http-client.js';
import { config } from '../../config.js';
import { log } from '../../logger.js';

const logger = log('адаптер:sikayetvar');

/**
 * sikayetvar.com — площадка жалоб с отдельным русским разделом. Карты сайта нет:
 * `/sitemap.xml` отвечает 410. Зато есть живая лента `/ru/complaints` — свежие жалобы
 * с брендом, датой и заголовком прямо в разметке.
 *
 * Режим источника — «только тема»: жалоба это короткий текст пользователя, статьи для
 * рерайта в ней нет. Темой становится бренд, на который жалуются, а заголовок жалобы
 * уходит подсказкой в промт.
 *
 * Лента общая на весь сайт, а клиенту нужны деньги и обман, а не сервис стиральных
 * машин. Поэтому здесь есть отсев по словам: без него в очередь попадали бы жалобы на
 * доставку и бытовую технику, и пост уходил бы мимо тематики групп.
 */

/** Потолок страниц ленты за проверку. */
const MAX_PAGES = 5;

/** Пауза между страницами: обход — залп по чужому хосту. */
const PAGE_PAUSE_MS = 900;

/**
 * Слова, по которым жалоба считается денежной. Список намеренно широкий: пропустить
 * лишнюю жалобу дешевле, чем потерять настоящий скам-проект — лишнюю отсеет дедуп темы
 * или человек в панели. Правится по живой выдаче, это не догма.
 */
const MONEY_MARKERS = [
  'деньг', 'денеж', 'вывод', 'выплат', 'выигрыш', 'депозит', 'вклад', 'инвест', 'брокер',
  'крипт', 'биржа', 'бирж', 'ставк', 'казино', 'букмекер', 'займ', 'кредит', 'долг',
  'платеж', 'платёж', 'оплат', 'счет', 'счёт', 'кошел', 'мошен', 'обман', 'скам',
  'трейд', 'бонус', 'баланс', 'средств', 'перевод', 'банк', 'карт', 'рубл', 'доллар',
  'списан', 'возврат', 'заработ', 'бирж',
];

/** Разделы сайта, которые внешне похожи на жалобу двумя сегментами пути. */
const NOT_A_COMPLAINT = new Set(['members', 'list', 'write', 'brands', 'all-brands', 'help']);

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** Ссылка на жалобу вместе с её текстом заголовка. */
const COMPLAINT_RE =
  /<a[^>]*href="\/ru\/([a-z0-9-]+)\/([a-z0-9-]+)"[^>]*>([^<]{15,})<\/a>/gi;

/** Дата в подписи карточки: «6 августа 17:47» или «12 декабря 2025 г. 23:57». */
const DATE_RE = /aria-label="(\d{1,2}) ([а-яё]+)(?: (\d{4}) г\.)?[^"]*"/gi;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Дата карточки. Год у свежих жалоб не указан — сайт пишет его только для прошлых лет.
 * Подставляем текущий, а если получилось будущее (проверка 1 января по декабрьской
 * жалобе), отступаем на год назад.
 */
function buildDate(day, monthName, year) {
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month < 0) return null;
  const now = new Date();
  const resolved = year ? Number(year) : now.getUTCFullYear();
  let date = new Date(Date.UTC(resolved, month, Number(day)));
  if (!year && date.getTime() - now.getTime() > 24 * 60 * 60 * 1000) {
    date = new Date(Date.UTC(resolved - 1, month, Number(day)));
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Даты в разметке идут перед заголовком жалобы, но не вплотную: между ними лежат
 * счётчик просмотров и иконки. Поэтому дату не «парсим рядом», а собираем все позиции
 * дат по документу и для каждой жалобы берём ближайшую сверху.
 */
function collectDates(html) {
  const marks = [];
  for (const match of html.matchAll(DATE_RE)) {
    const date = buildDate(match[1], match[2], match[3]);
    if (date) marks.push({ index: match.index, date });
  }
  return marks;
}

function dateBefore(marks, index) {
  let found = null;
  for (const mark of marks) {
    if (mark.index > index) break;
    found = mark.date;
  }
  return found;
}

function decode(text) {
  return text
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Бренд из адреса: `digicash-ru` → `digicash`. Суффикс языка темой быть не должен. */
function brandFromSlug(slug) {
  return slug.replace(/-ru$/, '') || slug;
}

function isAboutMoney(text) {
  const value = text.toLowerCase();
  return MONEY_MARKERS.some((marker) => value.includes(marker));
}

async function fetchPage(url) {
  const response = await request(url, {
    label: 'sikayetvar',
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
  const stats = { всего: 0, мимо_темы: 0, вне_окна: 0 };

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (items.length >= limit) break;
    if (page > 1) await sleep(PAGE_PAUSE_MS);

    const url = page === 1 ? `${baseUrl}/ru/complaints` : `${baseUrl}/ru/complaints?page=${page}`;
    const html = await fetchPage(url);
    const marks = collectDates(html);

    let addedOnPage = 0;
    for (const match of html.matchAll(COMPLAINT_RE)) {
      const [, brandSlug, complaintSlug, rawTitle] = match;
      if (NOT_A_COMPLAINT.has(brandSlug)) continue;

      const title = decode(rawTitle);
      const brand = brandFromSlug(brandSlug);
      stats.всего += 1;

      if (!isAboutMoney(`${brand} ${title}`)) {
        stats.мимо_темы += 1;
        continue;
      }

      const lastmod = dateBefore(marks, match.index);
      if (lastmod && (lastmod < since || (until && lastmod > until))) {
        stats.вне_окна += 1;
        continue;
      }

      const complaintUrl = `${baseUrl}/ru/${brandSlug}/${complaintSlug}`;
      if (seen.has(complaintUrl)) continue;
      seen.add(complaintUrl);

      items.push({
        url: complaintUrl,
        lastmod,
        title,
        // Темой становится бренд, а не жалоба: постов про один и тот же проект клиенту
        // не нужно, а жалоб на него бывают десятки. Дедуп темы схлопнет их в одну.
        topicHint: brand,
        snippet: title,
      });
      addedOnPage += 1;
      if (items.length >= limit) break;
    }

    // Пустая страница означает, что лента кончилась либо разметка поехала.
    if (addedOnPage === 0 && stats.всего === 0) break;
  }

  items.sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0));
  const result = items.slice(0, limit);
  logger.info(
    { ...stats, отобрано: result.length, окно_с: since.toISOString().slice(0, 10) },
    `sikayetvar.com: жалоб просмотрено ${stats.всего}, денежных в окне — ${result.length}`,
  );
  return result;
}
