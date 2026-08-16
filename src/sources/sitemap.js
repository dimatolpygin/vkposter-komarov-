import { request } from '../lib/http-client.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('sitemap');

/** Потолок на число дочерних карт за одну проверку: у крупных сайтов их бывают десятки. */
const MAX_CHILD_MAPS = 40;

/** Пауза между запросами карт одного сайта. */
const REQUEST_PAUSE_MS = 800;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Чтение sitemap. Основной способ обнаружения новых материалов — карта сайта,
 * а не краулинг: она отдаёт готовый список URL с датой изменения.
 *
 * Парсер на регулярках сознательно: sitemap — плоский предсказуемый XML, тянуть
 * зависимость ради двух тегов не нужно.
 */

function decodeXmlEntities(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#039;', "'");
}

/** Разбирает и <sitemapindex>, и <urlset> — структура записей одинаковая. */
export function parseSitemap(xml) {
  const isIndex = /<sitemapindex/i.test(xml);
  const blockRe = isIndex ? /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi : /<url\b[^>]*>([\s\S]*?)<\/url>/gi;

  const entries = [];
  for (const match of xml.matchAll(blockRe)) {
    const block = match[1];
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(block)?.[1];
    if (!loc) continue;
    const lastmodRaw = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(block)?.[1];
    const lastmod = lastmodRaw ? new Date(lastmodRaw) : null;
    entries.push({
      loc: decodeXmlEntities(loc),
      lastmod: lastmod && !Number.isNaN(lastmod.getTime()) ? lastmod : null,
    });
  }
  return { isIndex, entries };
}

async function fetchXml(url, label) {
  return request(url, {
    label,
    headers: { 'User-Agent': config.userAgent, Accept: 'application/xml,text/xml,*/*' },
    timeoutMs: 30_000,
    retries: 2,
    raw: true,
  }).then((response) => response.text());
}

/**
 * Возвращает список материалов из карты сайта источника.
 *
 * Ключевое решение: какой именно дочерний sitemap несёт свежее, определяется по
 * его lastmod в индексе, а НЕ по номеру в имени файла. На пресейле считалось, что
 * у cryptorussia свежее лежит в services-sitemap, а по факту сейчас — и в
 * post-sitemap.xml, и в services-sitemap.xml, тогда как архив 2024 — в нумерованных
 * файлах обоих типов. Сортировка по lastmod устойчива к таким переменам.
 */
export async function discoverViaSitemap(source, { since, until = null, limit }) {
  const label = `sitemap:${source.code}`;
  const indexUrl = source.sitemap_url ?? `${source.base_url}/sitemap.xml`;
  const patterns = (source.sitemap_pattern ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const indexXml = await fetchXml(indexUrl, label);
  const parsedIndex = parseSitemap(indexXml);

  // Источник может отдать сразу urlset вместо индекса — обрабатываем оба случая.
  let children;
  if (parsedIndex.isIndex) {
    children = parsedIndex.entries.filter((entry) =>
      patterns.length === 0 ? true : patterns.some((pattern) => entry.loc.includes(pattern)),
    );
    // Сначала самые свежие; файлы без lastmod проверяем в конце — вслепую отбросить нельзя.
    children.sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0));
    const fresh = children.filter((entry) => !entry.lastmod || entry.lastmod >= since);
    logger.info(
      { источник: source.code, всего: children.length, свежих: fresh.length },
      `${source.code}: в индексе ${children.length} подходящих карт, свежих по lastmod — ${fresh.length}`,
    );
    children = fresh;
  } else {
    children = [{ loc: indexUrl, lastmod: null }];
  }

  // Порядок карт можно использовать как «свежие сначала» только если lastmod у них
  // действительно разные. У vklader генератор карт проставляет всем файлам одно и то же
  // время перезаписи: сортировка ничего не меняет, порядок остаётся как в индексе,
  // а там первым идёт архив 2015 года. С ранним выходом по лимиту обход набирал 50
  // старых адресов из первой карты и до свежих (последний файл) не доходил никогда —
  // источник был активен, а в очередь не попадал, потому что очередь идёт от свежих.
  const stamps = new Set(children.map((entry) => entry.lastmod?.getTime() ?? 0));
  const orderedByDate = stamps.size > 1;
  if (!orderedByDate && children.length > 1) {
    logger.info(
      { источник: source.code, карт: children.length },
      `${source.code}: у всех карт одинаковый lastmod — читаем их целиком, порядок ни о чём не говорит`,
    );
  }

  // При одинаковых lastmod карты читаются с конца: у генераторов WordPress нумерация
  // идёт от старых к новым, свежее лежит в последнем файле. Это не догадка на пустом
  // месте, а замер: у vklader в post-sitemap.xml архив с 2015 года, в post-sitemap15.xml —
  // сегодняшний день. Чтение всех пятнадцати карт подряд работало, но сайт закрыл
  // доступ по IP на 403: пятнадцать запросов карт плюс тридцать за текстами он счёл
  // атакой. С конца хватает одной-двух карт.
  const queue = orderedByDate ? children : [...children].reverse();

  const found = [];
  let emptyInRow = 0;
  for (const [index, child] of queue.slice(0, MAX_CHILD_MAPS).entries()) {
    if (found.length >= limit) break;
    // Две пустые карты подряд означают, что свежее кончилось: дальше только архив.
    // Две, а не одна: у сайта может быть служебная карта без свежих записей посередине.
    if (emptyInRow >= 2) break;
    // Пауза между запросами: обход карт — это залп по одному хосту, а мы у него в гостях.
    if (index > 0) await sleep(REQUEST_PAUSE_MS);
    const xml = parsedIndex.isIndex ? await fetchXml(child.loc, label) : indexXml;
    const { entries } = parseSitemap(xml);
    // Верхняя граница применяется только к самим материалам, но не к выбору дочерних
    // карт: `lastmod` карты — это когда её последний раз перезаписали, и свежая карта
    // спокойно содержит статьи двухлетней давности.
    const fresh = entries.filter(
      (entry) => entry.lastmod && entry.lastmod >= since && (!until || entry.lastmod <= until),
    );
    logger.debug(
      { карта: child.loc, всего: entries.length, свежих: fresh.length },
      `${child.loc}: ${fresh.length} свежих из ${entries.length}`,
    );
    emptyInRow = fresh.length === 0 ? emptyInRow + 1 : 0;
    found.push(...fresh);
  }

  found.sort((a, b) => b.lastmod.getTime() - a.lastmod.getTime());
  return found.slice(0, limit).map((entry) => ({
    url: entry.loc,
    lastmod: entry.lastmod,
    title: null,
    topicHint: null,
  }));
}
