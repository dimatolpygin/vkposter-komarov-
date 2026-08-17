import * as articles from '../repo/articles.js';
import * as posts from '../repo/posts.js';
import { query } from '../db/pool.js';
import { normalizeUrl, hostOf } from '../lib/url.js';
import { extractTopic } from '../lib/topic.js';
import { extractOne, MIN_ARTICLE_CHARS } from './check-source.js';
import { generatePost } from './generate-post.js';
import { generateImageForPost } from './generate-image.js';
import { log, errFields } from '../logger.js';

const logger = log('ручной');

/**
 * Ручной режим: человек даёт ссылку или просто название проекта — система делает пост.
 *
 * Три решения, определившие этот файл:
 *
 * 1. **Дедуп по теме здесь не запрещает, а предупреждает.** Автоматический конвейер обязан
 *    отбрасывать повторы, но если клиент сам указал материал, значит он этого хочет:
 *    например, вышло продолжение истории. Панель показывает «про эту тему уже писали,
 *    пост #N» и требует подтверждения галочкой, а не молча отказывает.
 * 2. **Ссылка с чужого сайта работает.** Если домен есть в источниках — забираем текст
 *    его же способом (WP API / firecrawl). Если нет, материал заводится на служебном
 *    источнике `manual` и текст всё равно пробуем достать через firecrawl; не вышло —
 *    работаем в режиме «только тема», ИИ пишет по названию.
 * 3. **Публикации здесь нет.** Критерий этапа — «показывает результат до публикации»,
 *    поэтому сервис доводит дело до готового поста с обложкой и отдаёт его в карточку,
 *    где клиент читает текст и жмёт «Опубликовать» сам.
 */

/** Источник по домену ссылки: чтобы забрать текст тем же способом, что и в обходе. */
async function sourceForUrl(url) {
  const host = hostOf(url);
  if (!host) return null;
  const { rows } = await query(
    `SELECT * FROM sources
      WHERE code <> 'manual'
        AND (replace(replace(base_url, 'https://', ''), 'http://', '') ILIKE $1
             OR $2 ILIKE '%' || code || '%')
      ORDER BY id LIMIT 1`,
    [`${host}%`, host],
  );
  return rows[0] ?? null;
}

async function manualSource() {
  const { rows } = await query(`SELECT * FROM sources WHERE code = 'manual'`);
  if (!rows[0]) throw new Error('Служебный источник «manual» не найден — примените миграции');
  return rows[0];
}

/**
 * Что известно о теме до генерации: занята ли она и чем.
 * Вызывается панелью до нажатия «Сгенерировать», чтобы предупреждение появилось заранее.
 */
export async function inspect({ url, topic }) {
  const guess = extractTopic({
    title: topic ?? null,
    url: url ?? null,
    topicHint: topic ?? null,
  });
  if (!guess.key) return { topic: guess, owner: null, post: null };

  const owner = await articles.topicOwner([guess.key, ...guess.aliases]);
  let existingPost = null;
  if (owner) {
    const { rows } = await query(
      `SELECT id, title, status FROM posts WHERE article_id = $1 AND status <> 'failed'
        ORDER BY id DESC LIMIT 1`,
      [owner.id],
    );
    existingPost = rows[0] ?? null;
  }
  return { topic: guess, owner, post: existingPost };
}

/**
 * Пост по ссылке или по теме.
 *
 * @param {object} input
 * @param {string} [input.url] адрес материала
 * @param {string} [input.topic] название проекта (когда ссылки нет)
 * @param {boolean} [input.withImage] сразу сгенерировать обложку (по умолчанию да)
 * @param {boolean} [input.force] писать, даже если про тему уже был пост: материал заводится
 *   со своим ключом темы (`<тема>-m2`), потому что уникальный индекс по активной теме —
 *   гарантия автоматического дедупа и отключать её ради ручного повтора нельзя.
 * @returns {Promise<{post: object, article: object, warnings: string[], reusedArticle: boolean}>}
 */
export async function createManualPost({ url, topic, withImage = true, force = false }) {
  const warnings = [];
  const cleanUrl = url?.trim() || null;
  const cleanTopic = topic?.trim() || null;
  if (!cleanUrl && !cleanTopic) throw new Error('Укажите ссылку или тему');

  let article = null;
  let reusedArticle = false;

  if (cleanUrl) {
    const urlNorm = normalizeUrl(cleanUrl);
    if (!urlNorm) throw new Error('Ссылка не похожа на адрес: нужен http(s)-адрес материала');

    article = await articles.findByUrlNorm(urlNorm);
    if (article) {
      reusedArticle = true;
      warnings.push(`Материал уже есть в базе (#${article.id}, источник ${article.source_code}).`);
    } else {
      const source = (await sourceForUrl(cleanUrl)) ?? (await manualSource());
      const created = await articles.createManual({
        sourceId: source.id,
        url: cleanUrl,
        title: cleanTopic,
        topicHint: cleanTopic,
        force,
      });
      article = { ...created.article, source_code: source.code, content_mode: source.content_mode };
      if (/-m\d+$/.test(created.topic.key)) {
        warnings.push(`Про эту тему уже писали — повтор заведён отдельной темой «${created.topic.key}».`);
      }

      // Текст достаём тем же путём, что и обход источников. Не вышло — это не отказ:
      // модель умеет писать по одной теме, так работают all-comment и scama.net.
      try {
        const extracted = await extractOne(source, article);
        // Порог тот же, что в обходе источников, а не 200 символов. Поймано на ссылке
        // с Дзена: страница отдала боту 573 символа навигационного меню («Найти в Дзене,
        // Подписки, Новости…»), это прошло старый порог и легло в базу как текст статьи —
        // пост писался по меню. Меньше порога считаем, что текста нет: пусть модель
        // пишет по теме, так работают all-comment и scama.net.
        if (extracted?.text?.length >= MIN_ARTICLE_CHARS) {
          await articles.saveContent(article.id, extracted);
          // Уточнение темы по настоящему заголовку — только для обычного материала.
          // У осознанного повтора ключ намеренно свой (`…-m2`), а `refreshTopic` пересчитал
          // бы его по заголовку, нашёл занятую тему и пометил материал дублем — то есть
          // отменил бы ровно то, на что человек поставил галочку.
          if (!force) await articles.refreshTopic(article.id);
          article = await articles.findByUrlNorm(urlNorm);
        } else {
          warnings.push('Текст статьи достать не удалось — пост написан по теме.');
        }
      } catch (error) {
        warnings.push(`Текст статьи достать не удалось (${error.message}) — пост написан по теме.`);
        logger.warn({ url: cleanUrl, ...errFields(error) }, 'Ручной режим: извлечение текста не удалось');
      }
    }
  } else {
    const source = await manualSource();

    // Ключ темы считаем ДО вставки и по самому названию, а не по адресу: адрес здесь
    // синтетический, и если довериться ему, заголовок поста получится вида
    // «tema-1785139558984». Не разобрали название — честно говорим об этом.
    const guess = extractTopic({ title: cleanTopic, url: null, topicHint: cleanTopic });
    if (!guess.key) {
      throw new Error(
        `Не удалось разобрать название проекта из «${cleanTopic}»: ` +
          'оставлены только служебные слова. Укажите само название (например «Global ERP») или дайте ссылку.',
      );
    }

    // Адрес синтетический: `articles.url_norm` уникален и обязателен, а у темы адреса нет.
    // Домен `manual.local` не существует специально — по нему видно, что это ручной ввод.
    const created = await articles.createManual({
      sourceId: source.id,
      url: `https://manual.local/${guess.key}-${Date.now()}`,
      title: cleanTopic,
      topicHint: cleanTopic,
      force,
    });
    article = { ...created.article, source_code: source.code, content_mode: 'topic_only' };
    if (/-m\d+$/.test(created.topic.key)) {
      warnings.push(`Про эту тему уже писали — повтор заведён отдельной темой «${created.topic.key}».`);
    }
  }

  logger.info(
    { материал: article.id, тема: article.topic_key, по_ссылке: Boolean(cleanUrl) },
    `Ручной режим: материал #${article.id} («${article.topic_name ?? article.title}») готов к генерации`,
  );

  // interactive: человек ждёт ответ, поэтому priority-tier вместо дешёвого flex.
  const post = await generatePost(article, { interactive: true });

  let withCover = post;
  if (withImage) {
    try {
      withCover = await generateImageForPost(post);
    } catch (error) {
      warnings.push(`Обложка не сгенерировалась (${error.message}) — можно повторить в карточке поста.`);
      logger.warn({ пост: post.id, ...errFields(error) }, 'Ручной режим: обложка не сгенерировалась');
      withCover = (await posts.findById(post.id)) ?? post;
    }
  }

  logger.info(
    { пост: withCover.id, материал: article.id, обложка: Boolean(withCover.image_url) },
    `Ручной режим: пост #${withCover.id} готов${withCover.image_url ? ' с обложкой' : ' без обложки'}`,
  );

  return { post: withCover, article, warnings, reusedArticle };
}
