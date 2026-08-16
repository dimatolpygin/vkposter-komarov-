import { query } from '../db/pool.js';

/**
 * Журнал сбоев (`app_errors`) — источник раздела «Ошибки».
 *
 * Пишется «широко»: любой пойманный сбой конвейера, даже тот, который уже осел
 * в `run_items.error`. Дубль здесь осознанный — в слоте лежит одна строка текста,
 * а тут шаг, сервис, статус, тело ответа и `request-id`, по которому находятся
 * строки в `docker compose logs`.
 */

export async function record({
  stage,
  service = null,
  message,
  details = null,
  httpStatus = null,
  url = null,
  requestId = null,
  runId = null,
  postId = null,
  groupId = null,
  articleId = null,
  sourceId = null,
}) {
  const { rows } = await query(
    `INSERT INTO app_errors (stage, service, message, details, http_status, url,
                             request_id, run_id, post_id, group_id, article_id, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      String(stage).slice(0, 200),
      service,
      String(message ?? 'без сообщения').slice(0, 2000),
      details ? String(details).slice(0, 4000) : null,
      httpStatus,
      url ? String(url).slice(0, 500) : null,
      requestId,
      runId,
      postId,
      groupId,
      articleId,
      sourceId,
    ],
  );
  return rows[0].id;
}

/**
 * Последние сбои с расшифровкой связей. Фильтры — по шагу и по сервису: когда
 * отвалился один провайдер, остальное в списке только мешает.
 */
export async function listRecent({ limit = 50, stage, service } = {}) {
  const where = [];
  const params = [];
  if (stage) {
    params.push(stage);
    where.push(`e.stage = $${params.length}`);
  }
  if (service) {
    params.push(service);
    where.push(`e.service = $${params.length}`);
  }
  params.push(limit);

  const { rows } = await query(
    `SELECT e.*, g.name AS group_name, p.title AS post_title,
            a.topic_name, a.url AS article_url, s.title AS source_name
       FROM app_errors e
       LEFT JOIN groups g ON g.id = e.group_id
       LEFT JOIN posts p ON p.id = e.post_id
       LEFT JOIN articles a ON a.id = e.article_id
       LEFT JOIN sources s ON s.id = e.source_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Ошибки конкретного прогона — для его карточки. */
export async function listByRun(runId, limit = 50) {
  const { rows } = await query(
    `SELECT e.*, g.name AS group_name
       FROM app_errors e
       LEFT JOIN groups g ON g.id = e.group_id
      WHERE e.run_id = $1
      ORDER BY e.id
      LIMIT $2`,
    [runId, limit],
  );
  return rows;
}

/** Сводка для фильтров и счётчика на «Обзоре»: сколько и по каким сервисам. */
export async function summary(hours = 24) {
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE created_at > now() - ($1 || ' hours')::interval)::int AS recent
       FROM app_errors`,
    [String(hours)],
  );
  const { rows: byStage } = await query(
    `SELECT stage, service, count(*)::int AS n
       FROM app_errors
      GROUP BY stage, service
      ORDER BY n DESC
      LIMIT 20`,
  );
  return { ...rows[0], byStage };
}

/** Очистка журнала: следы проверок не должны навсегда висеть у клиента в панели. */
export async function clear() {
  const { rowCount } = await query('DELETE FROM app_errors');
  return rowCount;
}
