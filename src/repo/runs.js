import { query } from '../db/pool.js';

export async function startRun({ requestId, kind, meta = {} }) {
  const { rows } = await query(
    `INSERT INTO runs (request_id, kind, meta) VALUES ($1, $2, $3) RETURNING id`,
    [requestId, kind, meta],
  );
  return rows[0].id;
}

export async function finishRun(id, { status, found = 0, generated = 0, published = 0, error = null, meta }) {
  await query(
    `UPDATE runs
        SET status = $2, finished_at = now(), found = $3, generated = $4, published = $5,
            error = $6, meta = COALESCE($7, meta)
      WHERE id = $1`,
    [id, status, found, generated, published, error ? String(error).slice(0, 2000) : null, meta ?? null],
  );
}

/**
 * История прогонов для раздела «Прогоны». Счётчики слотов и сбоев считаются здесь,
 * а не в панели: иначе на каждый прогон в списке уходил бы отдельный запрос.
 */
export async function listRecent(limit = 30, { kind } = {}) {
  const params = [];
  let where = '';
  if (kind) {
    params.push(kind);
    where = `WHERE kind = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT r.*,
            (SELECT count(*) FROM run_items i WHERE i.run_id = r.id)::int AS items,
            (SELECT count(*) FROM run_items i
              WHERE i.run_id = r.id AND i.status = 'failed')::int AS items_failed,
            (SELECT count(*) FROM app_errors e WHERE e.run_id = r.id)::int AS errors
       FROM runs r
       ${where}
      ORDER BY r.started_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM runs WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function lastRun() {
  const { rows } = await query('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1');
  return rows[0] ?? null;
}

/**
 * Последний прогон постинга. Проверки источников в расписание не входят, наполнение
 * из архива — тоже: у него своя история (`archive_jobs`), и якорем расписания оно быть
 * не должно, иначе разовая заливка сдвинула бы ближайший автозапуск.
 */
export async function lastCycle() {
  const { rows } = await query(
    `SELECT * FROM runs WHERE kind IN ('cron', 'manual', 'backfill')
      ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Незаконченный прогон постинга. Ровно ради него план лежит в БД: прогон могли прервать
 * рестартом контейнера, и следующий запуск должен продолжить его, а не начать новый.
 *
 * Наполнение из архива (`kind = 'archive'`) сюда не попадает намеренно: его слоты
 * расписаны на несколько дней вперёд и исполняются своим заданием, а обычный прогон,
 * подхватив их, разложил бы чужой план по своим правилам.
 */
export async function unfinishedCycle() {
  const { rows } = await query(
    `SELECT r.* FROM runs r
      WHERE r.status = 'running' AND r.kind IN ('cron', 'manual', 'backfill')
        AND EXISTS (SELECT 1 FROM run_items i
                     WHERE i.run_id = r.id AND i.status IN ('planned', 'generated'))
      ORDER BY r.started_at ASC
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Сколько прогонов подряд упало после последнего удачного. Нужно планировщику:
 * повторять сбойный прогон стоит, но не бесконечно — иначе при системной беде
 * (нет кредитов, лежит провайдер) он будет перезапускаться до конца суток.
 */
export async function failedCyclesInRow() {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM runs
      WHERE kind IN ('cron', 'manual', 'backfill')
        AND status = 'failed'
        AND started_at > GREATEST(
          COALESCE(
            (SELECT max(started_at) FROM runs
              WHERE kind IN ('cron', 'manual', 'backfill') AND status = 'done'),
            '-infinity'::timestamptz),
          -- Полусуточное окно: вчерашние сбои не должны съедать сегодняшние попытки.
          now() - interval '12 hours')`,
  );
  return rows[0].count;
}

/**
 * Закрыть прогоны, застрявшие в статусе «идёт».
 *
 * Прогон, упавший между «начат» и первым слотом, некому перевести в конечный статус:
 * цикла ещё нет. На проде так повисли два прогона подряд, и в панели оба выглядели
 * как работающие. Условие «нет ни одного слота в работе» отличает застрявший прогон
 * от живого: у исполняемого слот всегда в статусе `planned` или `generated`.
 */
export async function closeStaleRunning(olderThanMinutes = 120) {
  const { rows } = await query(
    `UPDATE runs SET status = 'failed', finished_at = now(),
            error = COALESCE(error, 'Прогон прерван: не осталось слотов в работе')
      WHERE status = 'running'
        AND started_at < now() - ($1 || ' minutes')::interval
        AND NOT EXISTS (SELECT 1 FROM run_items i
                         WHERE i.run_id = runs.id AND i.status IN ('planned', 'generated'))
      RETURNING id`,
    [String(olderThanMinutes)],
  );
  return rows.map((row) => Number(row.id));
}

/**
 * Записать план прогона. Одна вставка на все слоты: частично записанный план — это
 * прогон, который при продолжении не знает про свой же хвост.
 */
export async function addItems(runId, items) {
  if (!items.length) return [];
  const values = [];
  const params = [];
  items.forEach((item, index) => {
    const base = index * 6;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
    );
    params.push(
      runId,
      item.groupId,
      item.slotNo,
      item.articleId ?? null,
      // Готовый пост попадает в план сразу с post_id: генерировать для него нечего.
      item.postId ?? null,
      item.postAt,
    );
  });
  const { rows } = await query(
    `INSERT INTO run_items (run_id, group_id, slot_no, article_id, post_id, post_at)
     VALUES ${values.join(', ')}
     RETURNING *`,
    params,
  );
  return rows;
}

/** Слоты прогона в порядке исполнения, с именами групп и темами. */
export async function listItems(runId) {
  const { rows } = await query(
    `SELECT i.*, g.name AS group_name, g.pmp_account_id,
            a.topic_name, a.url AS article_url,
            COALESCE(a.published_at, a.lastmod) AS article_date,
            p.title AS post_title, p.image_url
       FROM run_items i
       JOIN groups g ON g.id = i.group_id
       LEFT JOIN articles a ON a.id = i.article_id
       LEFT JOIN posts p ON p.id = i.post_id
      WHERE i.run_id = $1
      ORDER BY i.slot_no`,
    [runId],
  );
  return rows;
}

export async function setItemPost(itemId, postId, status = 'generated') {
  await query(
    `UPDATE run_items SET post_id = $2, status = $3, error = NULL, updated_at = now()
      WHERE id = $1`,
    [itemId, postId, status],
  );
}

export async function setItemStatus(itemId, status, error = null) {
  await query(
    `UPDATE run_items SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
    [itemId, status, error ? String(error).slice(0, 1000) : null],
  );
}

/** Материалы, уже занятые планами: второй раз в очередь они не попадают. */
export async function plannedArticleIds() {
  const { rows } = await query(
    `SELECT DISTINCT article_id FROM run_items
      WHERE article_id IS NOT NULL AND status IN ('planned', 'generated', 'published')`,
  );
  return rows.map((row) => Number(row.article_id));
}
