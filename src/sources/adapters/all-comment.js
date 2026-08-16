import { discoverViaWpApi } from '../wp-api.js';
import { log } from '../../logger.js';

const logger = log('адаптер:all-comment');

/**
 * all-comment.com — WordPress, но карта сайта нерабочая: /sitemap.xml редиректит на
 * /blog/sitemap.xml/, который отдаёт пустой ответ. Зато открыт WP REST API, и он
 * даёт то же самое: свежие записи с датой и заголовком.
 *
 * Текста в статьях мало (это и отмечено в брифе), поэтому источник остаётся в режиме
 * «только тема» — ИИ пишет статью по названию проекта сам. Тема берётся из заголовка.
 */
export async function discover(source, { since, until = null, limit }) {
  const items = await discoverViaWpApi(source, { since, until, limit });
  logger.info(
    { найдено: items.length },
    `all-comment.com: обнаружение через WP REST API (sitemap нерабочий), тем — ${items.length}`,
  );
  return items;
}
