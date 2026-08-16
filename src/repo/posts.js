import { query } from '../db/pool.js';

/** Сгенерированные посты. */

export async function create(row) {
  const { rows } = await query(
    `INSERT INTO posts (article_id, title, body, char_count, model, provider, prompt_version,
                        tokens_in, tokens_out, cost_usd, latency_ms, attempts, topic_key,
                        request_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'ready')
     RETURNING *`,
    [
      row.articleId ?? null,
      row.title,
      row.body,
      row.body.length,
      row.model ?? null,
      row.provider ?? null,
      row.promptVersion ?? null,
      row.tokensIn ?? null,
      row.tokensOut ?? null,
      row.costUsd ?? null,
      row.latencyMs ?? null,
      row.attempts ?? 1,
      row.topicKey ?? null,
      row.requestId ?? null,
    ],
  );
  return rows[0];
}

/**
 * Забракованный пост. Текст последней попытки сохраняем: без него разбор жалобы
 * «каждый день одна и та же ошибка» упирается в то, что смотреть не на что —
 * причина брака известна словами, а сам текст потерян.
 */
export async function createFailed(row) {
  const body = String(row.body ?? '');
  const { rows } = await query(
    `INSERT INTO posts (article_id, title, body, char_count, model, prompt_version, attempts,
                        topic_key, request_id, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'failed', $10)
     RETURNING *`,
    [
      row.articleId ?? null,
      row.title ?? '(не сгенерирован)',
      body,
      body.length,
      row.model ?? null,
      row.promptVersion ?? null,
      row.attempts ?? 1,
      row.topicKey ?? null,
      row.requestId ?? null,
      String(row.error).slice(0, 1000),
    ],
  );
  return rows[0];
}

/** Сколько раз генерация по этому материалу уже уходила в брак. */
export async function countFailedByArticle(articleId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM posts WHERE article_id = $1 AND status = 'failed'`,
    [articleId],
  );
  return rows[0].count;
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT p.*, a.url AS article_url, a.topic_name, s.code AS source_code,
            a.content_via, a.research_urls, a.research_at
       FROM posts p
       LEFT JOIN articles a ON a.id = p.article_id
       LEFT JOIN sources s ON s.id = a.source_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Задача обложки записывается ДО поллинга: кредиты kie.ai списываются за задачу,
 * и потерянный taskId — это потерянные деньги. Заодно чистим прошлую ошибку.
 */
export async function setImageTask(postId, taskId, promptVersion) {
  await query(
    `UPDATE posts
        SET image_task_id = $2, image_prompt_version = $3, image_error = NULL
      WHERE id = $1`,
    [postId, taskId, promptVersion ?? null],
  );
}

export async function setImage(postId, { url, path: filePath, credits, latencyMs }) {
  const { rows } = await query(
    `UPDATE posts
        SET image_url = $2, image_path = $3, image_credits = $4, image_latency_ms = $5,
            image_error = NULL, image_generated_at = now()
      WHERE id = $1
      RETURNING *`,
    [postId, url, filePath, credits ?? null, latencyMs ?? null],
  );
  return rows[0] ?? null;
}

/**
 * @param {boolean} [clearTask] снять image_task_id. Нужно, когда задача провалилась
 *   окончательно: иначе следующий запуск будет вечно дочитывать мёртвую задачу вместо
 *   новой генерации. При таймауте, наоборот, id сохраняется — задача оплачена и жива.
 */
export async function setImageError(postId, message, { clearTask = false } = {}) {
  await query(
    clearTask
      ? `UPDATE posts SET image_error = $2, image_task_id = NULL WHERE id = $1`
      : `UPDATE posts SET image_error = $2 WHERE id = $1`,
    [postId, String(message).slice(0, 1000)],
  );
}

/** Готовый пост без обложки — кандидат на генерацию картинки (нужно крону на этапе 9). */
export async function nextWithoutImage() {
  const { rows } = await query(
    `SELECT p.*, a.topic_name
       FROM posts p
       LEFT JOIN articles a ON a.id = p.article_id
      WHERE p.status = 'ready' AND p.image_path IS NULL
      ORDER BY p.id ASC
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Пост уехал в группу. Заодно материал помечается использованным: тема с готовым постом
 * и так не попадает в очередь (см. nextArticleForGeneration), но статус материала должен
 * это отражать — иначе в панели он выглядит «ждёт своей очереди».
 */
export async function markPublished(postId) {
  const { rows } = await query(
    `UPDATE posts SET status = 'published', published_at = now()
      WHERE id = $1
      RETURNING *`,
    [postId],
  );
  const post = rows[0] ?? null;
  if (post?.article_id) {
    await query(`UPDATE articles SET status = 'used' WHERE id = $1`, [post.article_id]);
  }
  return post;
}

/** Откат статуса: последняя публикация поста удалена, значит он снова просто готов. */
export async function markReady(postId) {
  const { rows } = await query(
    `UPDATE posts SET status = 'ready', published_at = NULL WHERE id = $1 RETURNING *`,
    [postId],
  );
  return rows[0] ?? null;
}

/** Готовый пост с обложкой, который ещё никуда не публиковался (кнопка в панели, cron на этапе 8). */
export async function nextForPublishing() {
  const { rows } = await query(
    `SELECT p.*, a.topic_name
       FROM posts p
       LEFT JOIN articles a ON a.id = p.article_id
      WHERE p.status = 'ready' AND p.image_url IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM publications pub
                         WHERE pub.post_id = p.id AND pub.error IS NULL)
      ORDER BY p.id ASC
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function listRecent(limit = 30) {
  const { rows } = await query(
    `SELECT p.id, p.title, p.char_count, p.status, p.model, p.provider, p.cost_usd,
            p.latency_ms, p.attempts, p.topic_key, p.created_at, p.error,
            p.image_url, p.image_path, p.image_credits, p.image_error,
            a.url AS article_url, s.code AS source_code
       FROM posts p
       LEFT JOIN articles a ON a.id = p.article_id
       LEFT JOIN sources s ON s.id = a.source_id
      ORDER BY p.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Материал для следующей генерации: свежий, с известной темой, ещё не отработанный.
 * Темы, по которым пост уже есть, исключаются — это и есть учёт «уже публиковали».
 *
 * @param {number|null} [sourceId] брать только из этого источника. Нужно кнопке в панели:
 *   очередь общая и идёт по дате, поэтому сайт, который публикует реже соседей, своей
 *   очереди может ждать долго, а посмотреть на него хочется сейчас.
 */
export async function nextArticleForGeneration(sourceId = null) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.title, a.content, a.topic_key, a.topic_name,
            COALESCE(a.published_at, a.lastmod) AS published_at,
            s.code AS source_code, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.status IN ('new', 'fetched')
        AND a.topic_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.topic_key = a.topic_key AND p.status <> 'failed')
        AND (s.content_mode = 'topic_only' OR a.content IS NOT NULL)
        AND ($1::int IS NULL OR a.source_id = $1)
      ORDER BY s.priority ASC, COALESCE(a.published_at, a.lastmod) DESC NULLS LAST
      LIMIT 1`,
    [sourceId ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Сколько материалов готово к генерации у каждого источника. Нужно селектору в панели:
 * выбирать источник вслепую бессмысленно, а «vklader (59)» сразу говорит, есть ли там что.
 */
export async function readyCountsBySource() {
  const { rows } = await query(
    `SELECT s.id, s.code, s.title, count(a.id)::int AS ready
       FROM sources s
       LEFT JOIN articles a
         ON a.source_id = s.id
        AND a.status IN ('new', 'fetched')
        AND a.topic_key IS NOT NULL
        AND (s.content_mode = 'topic_only' OR a.content IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM posts p
                         WHERE p.topic_key = a.topic_key AND p.status <> 'failed')
      GROUP BY s.id, s.code, s.title, s.is_active
      -- Выключенный источник остаётся в списке, пока его материалы лежат в базе:
      -- обходить сайт мы перестали, но написать пост по уже собранному можно.
      HAVING s.is_active = true OR count(a.id) > 0
      ORDER BY ready DESC, s.code`,
  );
  return rows;
}

/**
 * Кандидаты в очередь прогона: сначала уже готовые посты, потом материалы под генерацию.
 * Порядок один и тот же — от свежих к старым по дате материала (требование брифа
 * и критерий этапа 8).
 *
 * @param {number} limit сколько нужно
 * @param {number[]} [excludeArticleIds] материалы, уже занятые другим планом
 */
export async function listReadyPosts(limit, excludeArticleIds = []) {
  const { rows } = await query(
    `SELECT p.id, p.title, p.article_id, p.image_url, p.topic_key,
            COALESCE(a.published_at, a.lastmod) AS article_date,
            a.topic_name, s.code AS source_code,
            COALESCE(s.priority, 100) AS source_priority
       FROM posts p
       LEFT JOIN articles a ON a.id = p.article_id
       LEFT JOIN sources s ON s.id = a.source_id
      WHERE p.status = 'ready'
        AND NOT EXISTS (SELECT 1 FROM publications pub
                         WHERE pub.post_id = p.id AND pub.error IS NULL
                           AND pub.pmp_publication_id IS NOT NULL)
        AND (p.article_id IS NULL OR NOT (p.article_id = ANY($2::bigint[])))
      ORDER BY COALESCE(s.priority, 100) ASC,
               COALESCE(a.published_at, a.lastmod) DESC NULLS LAST, p.id ASC
      LIMIT $1`,
    [limit, excludeArticleIds],
  );
  return rows;
}

/**
 * Материалы под генерацию. Тот же фильтр, что у `nextArticleForGeneration`.
 *
 * Порядок: сначала очередь источника (`sources.priority`), внутри неё — от свежих
 * к старым. Приоритет стоит перед датой намеренно: у источника, отодвинутого в конец,
 * свежее почти всегда новее, и общая сортировка по дате снова отдавала бы план ему.
 */
export async function listArticlesForGeneration(limit, excludeArticleIds = []) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.title, a.content, a.topic_key, a.topic_name,
            COALESCE(a.published_at, a.lastmod) AS published_at,
            COALESCE(a.published_at, a.lastmod) AS article_date,
            s.code AS source_code, s.content_mode, s.priority AS source_priority
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.status IN ('new', 'fetched')
        AND a.topic_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.topic_key = a.topic_key AND p.status <> 'failed')
        AND (s.content_mode = 'topic_only' OR a.content IS NOT NULL)
        AND NOT (a.id = ANY($2::bigint[]))
      ORDER BY s.priority ASC, COALESCE(a.published_at, a.lastmod) DESC NULLS LAST, a.id DESC
      LIMIT $1`,
    [limit, excludeArticleIds],
  );
  return rows;
}

/**
 * Кандидаты наполнения из архива: то же, что и в обычном плане, но с двумя фильтрами —
 * выбранные источники и период материала.
 *
 * Дедуп здесь не свой, а общий: материал не берётся, если по его теме уже есть пост
 * (`NOT EXISTS ... posts`), если он занят чужим планом (`excludeArticleIds` из
 * `run_items`), а готовый пост — если он уже опубликован. Ровно поэтому «уже
 * опубликованные ранее материалы в очередь не попадают» — правило одно на систему.
 *
 * @param {object} options
 * @param {number[]} options.sourceIds выбранные источники
 * @param {string} options.from дата «с», YYYY-MM-DD
 * @param {string} options.to дата «по», YYYY-MM-DD (включительно)
 * @param {number} options.limit сколько нужно
 * @param {number[]} [options.excludeArticleIds] материалы, занятые другим планом
 * @returns {Promise<Array<{kind: 'post'|'article', postId: number|null, articleId: number,
 *   date: Date, label: string}>>} от свежих к старым
 */
export async function listArchiveCandidates({
  sourceIds, from, to, limit, excludeArticleIds = [],
}) {
  const params = [sourceIds, from, to, limit, excludeArticleIds];

  const ready = await query(
    `SELECT p.id, p.title, p.article_id, p.image_url,
            COALESCE(a.published_at, a.lastmod) AS article_date, a.topic_name
       FROM posts p
       JOIN articles a ON a.id = p.article_id
      WHERE p.status = 'ready'
        AND a.source_id = ANY($1::int[])
        AND (COALESCE(a.published_at, a.lastmod) AT TIME ZONE 'Europe/Moscow')::date
            BETWEEN $2::date AND $3::date
        AND NOT EXISTS (SELECT 1 FROM publications pub
                         WHERE pub.post_id = p.id AND pub.error IS NULL
                           AND pub.pmp_publication_id IS NOT NULL)
        AND NOT (p.article_id = ANY($5::bigint[]))
      ORDER BY COALESCE(a.published_at, a.lastmod) DESC NULLS LAST, p.id ASC
      LIMIT $4`,
    params,
  );

  const fresh = await query(
    `SELECT a.id, a.url, a.title, a.topic_name,
            COALESCE(a.published_at, a.lastmod) AS article_date
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.status IN ('new', 'fetched')
        AND a.source_id = ANY($1::int[])
        AND a.topic_key IS NOT NULL
        AND (COALESCE(a.published_at, a.lastmod) AT TIME ZONE 'Europe/Moscow')::date
            BETWEEN $2::date AND $3::date
        AND NOT EXISTS (SELECT 1 FROM posts p
                         WHERE p.topic_key = a.topic_key AND p.status <> 'failed')
        AND (s.content_mode = 'topic_only' OR a.content IS NOT NULL)
        AND NOT (a.id = ANY($5::bigint[]))
      ORDER BY COALESCE(a.published_at, a.lastmod) DESC NULLS LAST, a.id DESC
      LIMIT $4`,
    params,
  );

  return [
    ...ready.rows.map((row) => ({
      kind: 'post',
      postId: Number(row.id),
      articleId: Number(row.article_id),
      date: row.article_date,
      label: row.topic_name ?? row.title,
    })),
    ...fresh.rows.map((row) => ({
      kind: 'article',
      postId: null,
      articleId: Number(row.id),
      date: row.article_date,
      label: row.topic_name ?? row.title ?? row.url,
    })),
  ]
    .sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime())
    .slice(0, limit);
}

export async function findArticleForGeneration(articleId) {
  const { rows } = await query(
    `SELECT a.id, a.url, a.title, a.content, a.topic_key, a.topic_name,
            COALESCE(a.published_at, a.lastmod) AS published_at,
            s.code AS source_code, s.content_mode
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.id = $1`,
    [articleId],
  );
  return rows[0] ?? null;
}

export async function markArticleQueued(articleId) {
  await query(`UPDATE articles SET status = 'queued' WHERE id = $1`, [articleId]);
}

export async function countAll() {
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE image_path IS NOT NULL)::int AS with_image,
            count(*) FILTER (WHERE status = 'published')::int AS published,
            COALESCE(sum(image_credits), 0)::int AS image_credits,
            COALESCE(sum(cost_usd), 0)::numeric AS cost
       FROM posts`,
  );
  return rows[0];
}
