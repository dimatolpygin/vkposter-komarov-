import { request } from '../lib/http-client.js';
import { config } from '../config.js';
import { slugFromUrl } from '../lib/url.js';
import { log } from '../logger.js';

const logger = log('wp-api');

/**
 * Клиент WordPress REST API.
 *
 * Зачем: у всех пяти WP-источников /wp-json/wp/v2/posts открыт и отдаёт полный текст
 * статьи, заголовок и дату — бесплатно. Это снимает нагрузку с firecrawl, у которого
 * всего 1000 запросов в месяц на весь проект. firecrawl остаётся страховкой и
 * единственным способом достать scama.net (403 на прямой запрос).
 */

function apiBase(source) {
  return `${source.base_url.replace(/\/$/, '')}/wp-json/wp/v2`;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    // блоки, которые не являются текстом статьи
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // абзацы и переводы строк сохраняем как разделители, иначе текст склеивается
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&laquo;', '«')
    .replaceAll('&raquo;', '»')
    .replaceAll('&mdash;', '—')
    .replaceAll('&ndash;', '–')
    .replaceAll('&quot;', '"')
    .replaceAll('&#8217;', "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeTitle(html) {
  return stripHtml(html).replace(/\s+/g, ' ').trim();
}

/**
 * Список записей за период: обнаружение для источников без рабочего sitemap.
 *
 * `before` появляется только когда задана верхняя граница (наполнение из архива).
 * Без него у активного сайта первые 100 записей — всегда последние дни, и запрос
 * за прошлый год возвращал бы ровно то же, что и обычный обход.
 */
export async function discoverViaWpApi(source, { since, until = null, limit }) {
  const perPage = Math.min(limit, 100);
  const found = [];

  // Страницы нужны только наполнению из архива: обычный обход укладывается в первую
  // (лимит источника 50). WP отвечает 400 на страницу за пределами выборки — это
  // не ошибка обхода, а сигнал «записи кончились».
  for (let page = 1; found.length < limit && page <= 10; page += 1) {
    const url =
      `${apiBase(source)}/posts?per_page=${perPage}&page=${page}` +
      `&after=${encodeURIComponent(since.toISOString())}` +
      (until ? `&before=${encodeURIComponent(new Date(until).toISOString())}` : '') +
      '&orderby=date&order=desc&_fields=id,date_gmt,link,title';

    let posts;
    try {
      posts = await request(url, {
        label: `wp-api:${source.code}`,
        headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
        timeoutMs: 30_000,
        retries: 2,
      });
    } catch (error) {
      if (page === 1) throw error;
      logger.debug(
        { источник: source.code, страница: page, message: error.message },
        `${source.code}: страница ${page} не отдалась — считаем, что записи кончились`,
      );
      break;
    }

    if (!Array.isArray(posts)) {
      logger.warn({ источник: source.code }, 'WP API вернул неожиданный ответ вместо массива записей');
      break;
    }
    found.push(...posts);
    if (posts.length < perPage) break;
  }

  logger.info(
    { источник: source.code, записей: found.length, до: until ? new Date(until).toISOString().slice(0, 10) : null },
    `${source.code}: WP API отдал ${found.length} записей` +
      (until ? ` за период до ${new Date(until).toISOString().slice(0, 10)}` : ' (свежие)'),
  );

  return found.slice(0, limit).map((post) => ({
    url: post.link,
    lastmod: post.date_gmt ? new Date(`${post.date_gmt}Z`) : null,
    title: decodeTitle(post.title?.rendered ?? ''),
    topicHint: null,
  }));
}

/**
 * Текст одной записи по её URL (через slug).
 *
 * Перебираем все типы записей источника: у cryptorussia свежее лежит в кастомном типе
 * `services`, и запрос только к `posts` его не находит — извлечение уходило на firecrawl
 * и получало 255 символов вместо 4261.
 *
 * Возвращает null, если запись не нашлась ни в одном типе — тогда вызывающий код
 * уходит на firecrawl.
 */
export async function fetchArticleViaWpApi(source, articleUrl) {
  const slug = slugFromUrl(articleUrl);
  if (!slug) return null;

  const types = (source.wp_post_types ?? 'posts')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const type of types) {
    const url =
      `${apiBase(source)}/${type}?slug=${encodeURIComponent(slug)}` +
      '&_fields=id,date_gmt,link,title,content';
    let items;
    try {
      items = await request(url, {
        label: `wp-api:${source.code}`,
        headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
        timeoutMs: 30_000,
        retries: 1,
      });
    } catch (error) {
      logger.warn({ источник: source.code, тип: type, slug, message: error.message },
        `WP API: тип "${type}" недоступен, пробуем следующий`);
      continue;
    }

    if (Array.isArray(items) && items.length > 0) {
      const post = items[0];
      const text = stripHtml(post.content?.rendered ?? '');
      logger.debug(
        { источник: source.code, тип: type, slug, символов: text.length },
        `WP API: запись найдена в типе "${type}"`,
      );
      return {
        title: decodeTitle(post.title?.rendered ?? ''),
        text,
        publishedAt: post.date_gmt ? new Date(`${post.date_gmt}Z`) : null,
      };
    }
  }

  logger.warn(
    { источник: source.code, slug, типы: types.join(',') },
    `WP API не нашёл запись по slug "${slug}" ни в одном из типов`,
  );
  return null;
}
