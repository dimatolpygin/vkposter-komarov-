import { query, withTransaction } from '../db/pool.js';
import { normalizeUrl } from '../lib/url.js';
import { extractTopic, isListingUrl } from '../lib/topic.js';
import { log } from '../logger.js';

const logger = log('материалы');

/** Код нарушения уникального индекса в Postgres. */
const UNIQUE_VIOLATION = '23505';

/**
 * Активный материал с той же темой. Сверка идёт и по основному ключу, и по массиву
 * альтернативных: заголовок и slug нормализуются по-разному, и «Atlas capital» с одного
 * сайта иначе не сойдётся с «atlas-capital-otzyvy» с другого.
 * Материалы со статусом 'duplicate' в сверке не участвуют — иначе дубль ссылался бы на дубль.
 */
async function findTopicOwner(keys) {
  if (keys.length === 0) return null;
  const { rows } = await query(
    `SELECT a.id, a.url, a.topic_key, a.topic_name, s.code AS source_code
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.status <> 'duplicate'
        AND (a.topic_key = ANY($1::text[]) OR a.topic_aliases && $1::text[])
      ORDER BY a.id
      LIMIT 1`,
    [keys],
  );
  return rows[0] ?? null;
}

async function insertTopicDuplicate(sourceId, candidate, urlNorm, topic, owner) {
  const reason = owner
    ? `дубль темы «${topic.key}»: уже есть материал #${owner.id} (${owner.source_code})`
    : `дубль темы «${topic.key}»`;
  await query(
    `INSERT INTO articles (source_id, url, url_norm, title, lastmod, status, skip_reason,
                           topic_key, topic_name, topic_aliases, topic_via, duplicate_of)
     VALUES ($1, $2, $3, $4, $5, 'duplicate', $6, $7, $8, $9::text[], $10, $11)
     ON CONFLICT (url_norm) DO NOTHING`,
    [
      sourceId,
      candidate.url,
      urlNorm,
      candidate.title ?? null,
      candidate.lastmod ?? null,
      reason,
      topic.key,
      topic.name,
      topic.aliases,
      topic.via,
      owner?.id ?? null,
    ],
  );
}

/**
 * Сохранение найденного материала. Два контура дедупа:
 *   - по URL: уникальный индекс на url_norm, ON CONFLICT DO NOTHING («уже видели»);
 *   - по теме: нормализованное название проекта, см. lib/topic.js.
 *
 * Дубль темы не выбрасывается, а сохраняется со статусом 'duplicate' и причиной —
 * чтобы в панели было видно, что материал найден и почему отклонён. Страницы-листинги
 * («cryptorussia.ru/services») сохраняются как 'skipped': в sitemap они есть, но
 * проектом не являются.
 *
 * @returns {Promise<'added'|'duplicate'|'topic_duplicate'|'listing'|'invalid'>}
 */
export async function saveCandidate(sourceId, candidate) {
  const urlNorm = normalizeUrl(candidate.url);
  if (!urlNorm) return 'invalid';

  // Дубль URL проверяется первым: тот же адрес с utm-меткой — это «уже видели»,
  // а не «дубль темы». Иначе причина отклонения в панели вводила бы в заблуждение.
  const seen = await query('SELECT 1 FROM articles WHERE url_norm = $1', [urlNorm]);
  if (seen.rowCount > 0) return 'duplicate';

  if (isListingUrl(candidate.url)) {
    await query(
      `INSERT INTO articles (source_id, url, url_norm, title, lastmod, status, skip_reason)
       VALUES ($1, $2, $3, $4, $5, 'skipped', 'служебная страница-листинг, не материал')
       ON CONFLICT (url_norm) DO NOTHING`,
      [sourceId, candidate.url, urlNorm, candidate.title ?? null, candidate.lastmod ?? null],
    );
    return 'listing';
  }

  const topic = extractTopic(candidate);
  const keys = [topic.key, ...topic.aliases].filter(Boolean);

  // Без темы материал в генерацию не пойдёт: непонятно, о каком проекте пост, и дедуп
  // на него не действует. Такое даёт короткий служебный адрес вида /wb/.
  if (keys.length === 0) {
    await query(
      `INSERT INTO articles (source_id, url, url_norm, title, lastmod, status, skip_reason)
       VALUES ($1, $2, $3, $4, $5, 'skipped', 'не удалось определить тему по заголовку и адресу')
       ON CONFLICT (url_norm) DO NOTHING`,
      [sourceId, candidate.url, urlNorm, candidate.title ?? null, candidate.lastmod ?? null],
    );
    return 'listing';
  }

  const owner = await findTopicOwner(keys);
  if (owner) {
    await insertTopicDuplicate(sourceId, candidate, urlNorm, topic, owner);
    return 'topic_duplicate';
  }

  try {
    const { rowCount } = await query(
      `INSERT INTO articles (source_id, url, url_norm, title, lastmod, status,
                             topic_key, topic_name, topic_aliases, topic_via)
       VALUES ($1, $2, $3, $4, $5, 'new', $6, $7, $8::text[], $9)
       ON CONFLICT (url_norm) DO NOTHING`,
      [
        sourceId,
        candidate.url,
        urlNorm,
        candidate.title ?? null,
        candidate.lastmod ?? null,
        topic.key,
        topic.name,
        topic.aliases,
        topic.via,
      ],
    );
    return rowCount > 0 ? 'added' : 'duplicate';
  } catch (error) {
    // Гонка: тему занял параллельный прогон между сверкой и вставкой. Уникальный
    // индекс — последняя линия защиты, здесь она и отработала.
    if (error.code !== UNIQUE_VIOLATION) throw error;
    logger.warn(
      { url: candidate.url, тема: topic.key },
      'Тема занята параллельно — сохраняем материал как дубль',
    );
    const raced = await findTopicOwner(keys);
    await insertTopicDuplicate(sourceId, candidate, urlNorm, topic, raced);
    return 'topic_duplicate';
  }
}

/**
 * Пересчёт темы у уже сохранённых материалов.
 *
 * Нужен дважды: при переходе на этап 3 (в БД лежат материалы, найденные без тем) и после
 * извлечения текста — там появляется настоящий заголовок, а тема, посчитанная по одному
 * slug, менее точна. Идём от свежих к старым: при конфликте право на тему остаётся
 * у более свежего материала.
 *
 * @returns {Promise<{processed: number, keyed: number, listings: number, duplicates: number, unkeyed: number}>}
 */
export async function recomputeTopics({ onlyMissing = false } = {}) {
  return withTransaction((client) => recomputeTopicsIn(client, { onlyMissing }));
}

async function recomputeTopicsIn(client, { onlyMissing }) {
  const query = (text, params) => client.query(text, params);

  const { rows } = await query(
    `SELECT a.id, a.url, a.title
       FROM articles a
      WHERE ($1::boolean IS FALSE OR a.topic_key IS NULL)
        AND a.status IN ('new', 'fetched', 'duplicate', 'skipped')
      ORDER BY COALESCE(a.published_at, a.lastmod) DESC NULLS LAST, a.id DESC`,
    [onlyMissing],
  );

  // Ключи от предыдущего пересчёта сбрасываются заранее. Иначе уникальный индекс
  // ловит конфликт с ещё не обработанной строкой, которая держит тот же ключ
  // с прошлого прогона, и пересчёт падает на середине.
  await query(
    `UPDATE articles SET topic_key = NULL, topic_aliases = '{}', topic_name = NULL,
            topic_via = NULL, duplicate_of = NULL
      WHERE id = ANY($1::bigint[])`,
    [rows.map((row) => row.id)],
  );

  const stats = { processed: 0, keyed: 0, listings: 0, duplicates: 0, unkeyed: 0 };
  const taken = new Map(); // ключ темы → id материала, который её занял

  for (const row of rows) {
    stats.processed += 1;

    if (isListingUrl(row.url)) {
      await query(
        `UPDATE articles
            SET status = 'skipped', skip_reason = 'служебная страница-листинг, не материал',
                topic_key = NULL, topic_aliases = '{}', topic_name = NULL, topic_via = NULL,
                duplicate_of = NULL
          WHERE id = $1`,
        [row.id],
      );
      stats.listings += 1;
      continue;
    }

    // topicHint у сохранённого материала не восстановить (он жил только в кандидате),
    // поэтому тема считается по заголовку и slug — для этих источников этого достаточно.
    const topic = extractTopic({ title: row.title, url: row.url, topicHint: null });
    const keys = [topic.key, ...topic.aliases].filter(Boolean);
    if (keys.length === 0) {
      await query(
        `UPDATE articles
            SET status = 'skipped',
                skip_reason = 'не удалось определить тему по заголовку и адресу',
                topic_key = NULL, topic_aliases = '{}', topic_name = NULL, topic_via = NULL,
                duplicate_of = NULL
          WHERE id = $1`,
        [row.id],
      );
      stats.unkeyed += 1;
      continue;
    }

    const ownerId = keys.map((key) => taken.get(key)).find(Boolean);

    if (ownerId && ownerId !== row.id) {
      await query(
        `UPDATE articles
            SET status = 'duplicate',
                skip_reason = $2,
                topic_key = $3, topic_name = $4, topic_aliases = $5::text[], topic_via = $6,
                duplicate_of = $7
          WHERE id = $1`,
        [
          row.id,
          `дубль темы «${topic.key}»: уже есть материал #${ownerId}`,
          topic.key,
          topic.name,
          topic.aliases,
          topic.via,
          ownerId,
        ],
      );
      stats.duplicates += 1;
      continue;
    }

    await query(
      `UPDATE articles
          SET topic_key = $2, topic_name = $3, topic_aliases = $4::text[], topic_via = $5,
              duplicate_of = NULL,
              skip_reason = NULL,
              status = CASE WHEN status IN ('duplicate', 'skipped')
                            THEN (CASE WHEN content IS NOT NULL THEN 'fetched' ELSE 'new' END)
                            ELSE status END
        WHERE id = $1`,
      [row.id, topic.key, topic.name, topic.aliases, topic.via],
    );
    stats.keyed += 1;
    for (const key of keys) if (!taken.has(key)) taken.set(key, row.id);
  }

  logger.info(
    stats,
    `Темы пересчитаны: ${stats.keyed} с темой, ${stats.duplicates} дублей темы, ` +
      `${stats.listings} служебных страниц, ${stats.unkeyed} без темы`,
  );
  return stats;
}

/**
 * Материалы, которым нужен текст: только режим text и только те, где текста ещё нет.
 * Свежие вперёд — постинг идёт от свежих к старым.
 */
export async function listPendingExtraction(sourceId, limit) {
  const { rows } = await query(
    `SELECT a.*, s.code AS source_code, s.base_url, s.fetch_via, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.source_id = $1
        AND s.content_mode = 'text'
        AND a.status = 'new'
        AND a.content IS NULL
      ORDER BY COALESCE(a.published_at, a.lastmod) DESC NULLS LAST
      LIMIT $2`,
    [sourceId, limit],
  );
  return rows;
}

export async function saveContent(id, { title, text, publishedAt = null }) {
  await query(
    `UPDATE articles
        SET content = $2,
            title = COALESCE(NULLIF($3, ''), title),
            published_at = COALESCE($4, published_at),
            content_fetched_at = now(),
            content_via = 'source',
            status = 'fetched',
            skip_reason = NULL
      WHERE id = $1`,
    [id, text, title ?? '', publishedAt],
  );
}

/**
 * Материал, собранный поиском (этап 13). Отдельно от `saveContent`: статус материала
 * не меняем (он не «извлечён со страницы»), зато сохраняем ссылки — по ним клиент
 * в панели проверяет, на чём основан пост.
 */
export async function saveResearch(id, { text, urls }) {
  await query(
    `UPDATE articles
        SET content = $2,
            content_via = 'search',
            research_urls = $3::text[],
            research_at = now(),
            content_fetched_at = COALESCE(content_fetched_at, now())
      WHERE id = $1`,
    [id, text, urls],
  );
}

/**
 * Уточнение темы после извлечения текста.
 *
 * При обнаружении через sitemap заголовка нет — тема считается по slug. После извлечения
 * появляется настоящий заголовок, из него тема точнее («Atlas capital» вместо
 * «atlas-capital-obman-i-nevyplaty»). Старый ключ сохраняется в aliases: по нему материал
 * уже сверялся с другими, и терять его нельзя.
 *
 * Если уточнённая тема оказалась занята другим материалом — этот помечается дублем.
 * @returns {Promise<'kept'|'updated'|'duplicate'>}
 */
export async function refreshTopic(id) {
  const { rows } = await query(
    `SELECT id, url, title, topic_key, topic_aliases FROM articles WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return 'kept';

  const topic = extractTopic({ title: row.title, url: row.url, topicHint: null });
  if (!topic.key || topic.key === row.topic_key) return 'kept';

  const aliases = [...new Set([...topic.aliases, ...(row.topic_aliases ?? []), row.topic_key])]
    .filter((key) => key && key !== topic.key);

  const owner = await findTopicOwner([topic.key]);
  if (owner && owner.id !== id) {
    await query(
      `UPDATE articles
          SET status = 'duplicate', skip_reason = $2, duplicate_of = $3,
              topic_key = $4, topic_name = $5, topic_aliases = $6::text[], topic_via = $7
        WHERE id = $1`,
      [
        id,
        `дубль темы «${topic.key}»: уже есть материал #${owner.id} (${owner.source_code})`,
        owner.id,
        topic.key,
        topic.name,
        aliases,
        topic.via,
      ],
    );
    logger.info(
      { материал: id, тема: topic.key, занял: owner.id },
      `Материал #${id} после извлечения текста оказался дублем темы «${topic.key}»`,
    );
    return 'duplicate';
  }

  await query(
    `UPDATE articles
        SET topic_key = $2, topic_name = $3, topic_aliases = $4::text[], topic_via = $5
      WHERE id = $1`,
    [id, topic.key, topic.name, aliases, topic.via],
  );
  return 'updated';
}

export async function markFailed(id, reason) {
  await query(`UPDATE articles SET status = 'failed', skip_reason = $2 WHERE id = $1`, [
    id,
    String(reason).slice(0, 500),
  ]);
}

/** Материалы в режиме «только тема» текста не требуют — сразу считаем готовыми. */
export async function markTopicOnlyReady(sourceId) {
  const { rowCount } = await query(
    `UPDATE articles a
        SET status = 'fetched'
      WHERE a.source_id = $1
        AND a.status = 'new'
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id AND s.content_mode = 'topic_only')`,
    [sourceId],
  );
  return rowCount;
}

export async function statsBySource() {
  const { rows } = await query(`
    SELECT s.id AS source_id,
           count(a.id)::int                                        AS total,
           count(a.id) FILTER (WHERE a.content IS NOT NULL)::int    AS with_text,
           count(a.id) FILTER (WHERE a.status = 'failed')::int       AS failed,
           count(a.id) FILTER (WHERE a.status = 'duplicate')::int    AS topic_duplicates,
           count(a.id) FILTER (WHERE a.status = 'skipped')::int      AS skipped,
           count(DISTINCT a.topic_key) FILTER (
             WHERE a.topic_key IS NOT NULL AND a.status <> 'duplicate')::int AS topics,
           max(COALESCE(a.published_at, a.lastmod))                 AS newest
      FROM sources s
      LEFT JOIN articles a ON a.source_id = s.id
     GROUP BY s.id
  `);
  return new Map(rows.map((row) => [row.source_id, row]));
}

export async function listRecent(limit = 40, sourceId = null) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.title, COALESCE(a.published_at, a.lastmod) AS lastmod, a.status, a.skip_reason,
            a.content IS NOT NULL AS has_text,
            length(a.content) AS text_len,
            a.topic_key, a.topic_name, a.topic_via, a.duplicate_of,
            s.code AS source_code, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE ($2::int IS NULL OR a.source_id = $2)
      ORDER BY COALESCE(a.published_at, a.lastmod) DESC NULLS LAST, a.id DESC
      LIMIT $1`,
    [limit, sourceId],
  );
  return rows;
}

/**
 * Отклонённые материалы: дубли темы и служебные страницы. Отдельная выборка нужна потому,
 * что в списке последних найденных (сортировка по дате) отклонённое почти не показывается —
 * дубль обычно старше «победителя», а разбираться в причинах отклонения нужно.
 */
export async function listRejected(limit = 20) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.title, a.status, a.skip_reason, a.topic_key, a.topic_via,
            a.duplicate_of, COALESCE(a.published_at, a.lastmod) AS lastmod,
            s.code AS source_code, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.status IN ('duplicate', 'skipped')
      ORDER BY a.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function countAll() {
  const { rows } = await query('SELECT count(*)::int AS count FROM articles');
  return rows[0].count;
}

export async function findByUrlNorm(urlNorm) {
  const { rows } = await query(
    `SELECT a.*, s.code AS source_code, s.content_mode, s.fetch_via
       FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE a.url_norm = $1`,
    [urlNorm],
  );
  return rows[0] ?? null;
}

/** Владелец темы — нужен ручному режиму, чтобы предупредить «про это уже писали». */
export async function topicOwner(keys) {
  return findTopicOwner(keys.filter(Boolean));
}

/**
 * Свободный вариант ключа темы для осознанного повтора.
 *
 * Тема занята активным материалом, а клиент всё равно хочет второй пост (вышло
 * продолжение истории). Просто вставить второй материал с тем же ключом нельзя:
 * `articles_topic_active_uidx` этого не даст — и правильно, иначе автоматический дедуп
 * перестал бы быть гарантией. Поэтому повтор получает свой ключ `<тема>-m2`, `-m3`, …
 * Название темы (`topic_name`) остаётся человеческим — именно оно уходит в промт,
 * а базовый ключ остаётся за первым материалом, и автообход по-прежнему видит дубли.
 */
async function freeTopicKey(baseKey) {
  for (let attempt = 2; attempt <= 50; attempt += 1) {
    const key = `${baseKey}-m${attempt}`;
    const { rows } = await query(
      `SELECT 1 FROM articles WHERE topic_key = $1 AND status <> 'duplicate' LIMIT 1`,
      [key],
    );
    if (rows.length === 0) return key;
  }
  throw new Error(`По теме «${baseKey}» уже 50 материалов — похоже, что-то пошло не так`);
}

/**
 * Материал, заведённый человеком через панель (ссылка или тема).
 *
 * Отличается от `saveCandidate` тем, что **не отбрасывает дубли темы**: клиент указал
 * материал явно, и решение «писать или не писать» принимает он, а не дедуп. Предупреждение
 * о занятой теме показывается в панели до генерации, а согласие приходит флагом `force`.
 */
export async function createManual({ sourceId, url, title, content, topicHint, publishedAt, force = false }) {
  const urlNorm = normalizeUrl(url) ?? url;
  const topic = extractTopic({ title, url, topicHint });
  if (!topic.key) {
    throw new Error('Не удалось определить тему: укажите название проекта или ссылку с ним в адресе');
  }
  if (force) {
    const owner = await findTopicOwner([topic.key, ...topic.aliases]);
    if (owner) {
      topic.key = await freeTopicKey(topic.key);
      // Псевдонимы того же материала занял бы тот же индекс на следующем повторе,
      // а никакой пользы от них у ручного повтора нет.
      topic.aliases = [];
    }
  }
  const { rows } = await query(
    `INSERT INTO articles (source_id, url, url_norm, title, published_at, content,
                           content_fetched_at, status, topic_key, topic_name, topic_aliases, topic_via)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
             CASE WHEN $6::text IS NULL THEN 'new' ELSE 'fetched' END,
             $7, $8, $9::text[], $10)
     RETURNING *`,
    [
      sourceId,
      url,
      urlNorm,
      title ?? null,
      publishedAt ?? new Date(),
      content ?? null,
      topic.key,
      topic.name,
      topic.aliases,
      topic.via,
    ],
  );
  return { article: rows[0], topic };
}
