import * as firecrawl from '../lib/firecrawl.js';
import * as articles from '../repo/articles.js';
import * as settings from '../repo/settings.js';
import { projectSearchName, projectTokens } from '../lib/topic.js';
import { captureError } from './capture-error.js';
import { log, errFields } from '../logger.js';

const logger = log('сбор-материала');

/**
 * Сбор материала о проекте поиском в вебе.
 *
 * Зачем: у scama.net и all-comment своих текстов нет — только названия проектов.
 * Без этого шага такая тема уходит в генерацию «как есть», и модель пишет обзор
 * по типичным схемам мошеннических проектов, не зная о конкретном ничего. Выглядит
 * убедительно, проверяемых фактов ноль. Промт клиента честно просит «поискать в сети»,
 * но у модели через OpenRouter интернета нет — искать должны мы.
 *
 * Правила этого файла:
 *
 * 1. **Никогда не роняет генерацию.** Не нашлось, упал firecrawl, кончился лимит —
 *    пишем запись в журнал «Ошибки» и возвращаем null. Пост будет сделан по теме,
 *    как раньше: хуже, но есть.
 * 2. **Расход виден заранее.** Число страниц берётся из настройки, каждый вызов
 *    логируется отдельной строкой (бесплатный лимит firecrawl — 1000 запросов в месяц
 *    на весь проект, и поиск тратит его быстрее, чем извлечение статей).
 * 3. **Собранное сохраняется вместе со ссылками.** Пост, написанный по чужим страницам,
 *    клиент должен иметь возможность проверить — в карточке материала видно, откуда.
 */

/**
 * Пауза после сбоя поиска.
 *
 * Сбой у поиска не бывает единичным: кончились кредиты firecrawl — они кончились
 * для всех слотов прогона, а не для одного. Без паузы каждый следующий слот повторял
 * тот же запрос: на кредитах это шесть десятков одинаковых записей в журнале, а на
 * зависании — по три минуты ожидания на слот, то есть прогон растягивался на часы.
 * После сбоя поиск отключается на время: пост пишется по теме, публикации идут дальше.
 */
const PAUSE_AFTER_LIMIT_MS = 6 * 60 * 60 * 1000;
const PAUSE_AFTER_FAILURE_MS = 30 * 60 * 1000;

let pausedUntil = 0;
let pauseReason = '';

/** Для тестов и ручного запуска из панели: снять паузу поиска. */
export function resumeResearch() {
  pausedUntil = 0;
  pauseReason = '';
}

/** Сколько символов собранного материала уходит в промт целиком. */
const MAX_TOTAL_CHARS = 12_000;

/** Материал короче этого считаем неудачей поиска: одна навигация без содержания. */
const MIN_USEFUL_CHARS = 400;

/**
 * Нужен ли сбор для этого материала.
 * @param {object} article строка articles
 * @param {string} mode настройка research_mode
 */
export function shouldResearch(article, mode) {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // missing: своего текста нет или он символический (заголовок и меню)
  return !article?.content || article.content.trim().length <= 200;
}

/**
 * Собрать материал по теме и сохранить его в статью.
 *
 * @param {object} article строка articles
 * @param {{force?: boolean}} [options] force — искать, даже если режим «выключено»
 * @returns {Promise<{text: string, urls: string[], pages: number}|null>} null — не искали или не нашли
 */
export async function collectMaterial(article, { force = false } = {}) {
  const mode = await settings.get('research_mode', 'missing');
  if (!force && !shouldResearch(article, mode)) return null;
  if (!firecrawl.isConfigured()) {
    logger.warn('FIRECRAWL_API_KEY не задан — поиск материала пропущен');
    return null;
  }
  if (!force && Date.now() < pausedUntil) {
    logger.info(
      { материал: article.id, до: new Date(pausedUntil).toLocaleString('ru-RU') },
      `Поиск материала на паузе (${pauseReason}) — пост будет написан по теме`,
    );
    return null;
  }

  // Для поиска имя нужно с доменом: проект известен как «merabo.ru», а не «merabo».
  const project = projectSearchName(article.topic_name) || article.title || article.topic_key;
  if (!project) return null;

  const limit = await settings.getInt('research_results', 3);
  const perPage = await settings.getInt('research_chars_per_page', 3000);
  const template = await settings.get('research_query', '{{проект}} отзывы обман вывод денег');
  const query = template.replaceAll('{{проект}}', project);

  try {
    let usedQuery = query;
    let pages = await searchPages(query, limit, perPage, project);

    // Уточняющие слова иногда обнуляют выдачу: у малоизвестного проекта нет страниц,
    // где рядом стоят и название, и «обман», и «вывод денег». Повторяем одним
    // названием — это ещё один расход лимита, поэтому ровно одна попытка и только
    // если первая дала пусто.
    if (pages.length === 0 && query.trim() !== project.trim()) {
      logger.info(
        { материал: article.id, запрос: query },
        `Поиск по «${query}» пуст — повторяю по одному названию «${project}»`,
      );
      usedQuery = project;
      pages = await searchPages(project, limit, perPage, project);
    }

    if (pages.length === 0) {
      logger.warn(
        { материал: article.id, запрос: usedQuery },
        `Поиск по «${project}» не дал пригодного текста — пост будет написан по теме`,
      );
      return null;
    }

    const text = buildMaterial(project, pages).slice(0, MAX_TOTAL_CHARS);
    const urls = pages.map((page) => page.url);
    await articles.saveResearch(article.id, { text, urls });

    logger.info(
      { материал: article.id, проект: project, страниц: pages.length, символов: text.length },
      `Собран материал по «${project}»: ${pages.length} страниц, ${text.length} символов`,
    );
    return { text, urls, pages: pages.length };
  } catch (error) {
    // Кредиты кончились или запрос завис — остальные слоты упрутся в то же самое.
    const outOfCredits = error.code === 402 || /insufficient credits/i.test(error.message ?? '');
    const stuck = error.timedOut === true || /таймаут/i.test(error.message ?? '');
    if (outOfCredits || stuck) {
      pausedUntil = Date.now() + (outOfCredits ? PAUSE_AFTER_LIMIT_MS : PAUSE_AFTER_FAILURE_MS);
      pauseReason = outOfCredits ? 'кончились кредиты firecrawl' : 'поиск не отвечает';
      logger.warn(
        { до: new Date(pausedUntil).toLocaleString('ru-RU'), причина: pauseReason },
        `Поиск материала отключён до ${new Date(pausedUntil).toLocaleString('ru-RU')}: ${pauseReason}`,
      );
    }
    logger.error(
      { материал: article.id, запрос: query, ...errFields(error) },
      `Сбор материала по «${project}» не удался — пост будет написан по теме`,
    );
    await captureError('сбор материала', error, {
      service: 'firecrawl',
      articleId: article.id,
      details: `запрос: ${query}`,
    });
    return null;
  }
}

/**
 * Поиск + отбор страниц, из которых реально есть что взять.
 *
 * Второй фильтр — на релевантность, и он здесь главный. Поисковик всегда что-нибудь
 * возвращает: по неизвестному проекту в выдачу приходят общие статьи «как распознать
 * мошенников» с РБК и YouTube. Отдать их модели как фактуру хуже, чем не искать вовсе:
 * она аккуратно перенесёт в пост чужие детали (лицензии, суммы, страны) и получится
 * убедительная выдумка про конкретный проект. Поэтому берём только страницы,
 * где название проекта действительно упоминается.
 */
async function searchPages(query, limit, perPage, project) {
  const found = await firecrawl.search(query, { limit });
  // Домен в названии — самый надёжный признак: «merabo.ru» встречается только там,
  // где речь именно о нём. Без домена ловятся однокоренные чужие компании: по слову
  // «merabo» в выдачу пришла индийская «Merabo Labs», к проекту отношения не имеющая.
  const domains = project
    .split(/\s+/)
    .filter((part) => /[\p{L}\p{N}]\.[\p{L}]{2,}/u.test(part))
    .map((part) => part.toLowerCase());
  const { words } = projectTokens(project);
  const needles = domains.length > 0
    ? domains
    : words.map((word) => word.toLowerCase()).filter((word) => word.length >= 4);
  // Домену хватает одного упоминания, отдельному слову — двух.
  const minHits = domains.length > 0 ? 1 : 2;

  const pages = [];
  let dropped = 0;
  for (const page of found) {
    const text = cleanPage(page.markdown).slice(0, perPage);
    if (text.length < MIN_USEFUL_CHARS) { dropped += 1; continue; }
    if (!isAboutProject(text, page.title, needles, minHits)) { dropped += 1; continue; }
    pages.push({ ...page, text });
  }
  if (dropped > 0) {
    logger.info(
      { запрос: query, отброшено: dropped, принято: pages.length },
      `Поиск «${query}»: отброшено ${dropped} страниц не про проект`,
    );
  }
  return pages;
}

/**
 * Страница действительно про этот проект. Порог упоминаний зависит от того, что ищем:
 * домен опознаёт проект однозначно и достаточно одного, а отдельное слово названия
 * требует двух — одно упоминание так выглядит перечисление в списке «ещё 200
 * сомнительных сайтов», фактуры там нет.
 */
function isAboutProject(text, title, needles, minHits) {
  if (needles.length === 0) return true;
  const haystack = text.toLowerCase();
  const heading = String(title ?? '').toLowerCase();
  return needles.some((needle) => {
    if (heading.includes(needle)) return true;
    let hits = 0;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) return false;
      hits += 1;
      if (hits >= minHits) return true;
      from = at + needle.length;
    }
  });
}

/**
 * Склейка найденного в один материал. Источник каждого куска подписан: модель должна
 * понимать, что это несколько независимых страниц, а не одна статья — иначе она
 * склеивает противоречащие детали в один «факт».
 */
function buildMaterial(project, pages) {
  const parts = [
    `Найденные в сети материалы о проекте «${project}». Это выдержки с разных сайтов, ` +
      'а не одна статья: используй их как фактуру, противоречия разрешай в пользу ' +
      'осторожной формулировки, ничего не додумывай.',
  ];
  for (const [index, page] of pages.entries()) {
    parts.push(
      '',
      `--- Источник ${index + 1}: ${page.title ?? page.url}`,
      `Адрес: ${page.url}`,
      '',
      page.text,
    );
  }
  return parts.join('\n');
}

/**
 * Чистка страницы поисковой выдачи: навигация, ссылки и картинки в markdown.
 *
 * Оставлять их нельзя по двум причинам: они съедают лимит символов (в шапке сайта
 * ссылок бывает больше, чем текста в статье) и подсовывают модели чужие адреса,
 * которые она потом вставляет в пост.
 */
function cleanPage(markdown) {
  return String(markdown ?? '')
    // картинки целиком
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // ссылки: остаётся только текст
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // голые адреса в тексте
    .replace(/https?:\/\/\S+/g, '')
    // строки-меню: почти пустые после чистки ссылок
    .split('\n')
    .filter((line) => {
      const value = line.trim();
      if (!value) return true;
      return value.replace(/[^\p{L}\p{N}]+/gu, '').length >= 3;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
