import { query } from '../db/pool.js';

/**
 * Факт публикации: один пост в одну группу — не более одного раза (уникальный индекс
 * по (post_id, group_id)). Повторная попытка обновляет строку, а не плодит дубли.
 */

export async function record({
  postId,
  groupId,
  pmpPublicationId,
  pmpFileId,
  postAt,
  pmpStatus,
  mode,
  requestId,
}) {
  const { rows } = await query(
    `INSERT INTO publications (post_id, group_id, pmp_publication_id, pmp_file_id, post_at,
                               pmp_status, mode, request_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
     ON CONFLICT (post_id, group_id) DO UPDATE
        SET pmp_publication_id = EXCLUDED.pmp_publication_id,
            pmp_file_id = EXCLUDED.pmp_file_id,
            post_at = EXCLUDED.post_at,
            pmp_status = EXCLUDED.pmp_status,
            mode = EXCLUDED.mode,
            request_id = EXCLUDED.request_id,
            error = NULL
     RETURNING *`,
    [postId, groupId, pmpPublicationId, pmpFileId ?? null, postAt ?? null, pmpStatus ?? null,
      mode ?? 'draft', requestId ?? null],
  );
  return rows[0];
}

export async function recordError({ postId, groupId, message, mode, requestId, pmpFileId }) {
  const { rows } = await query(
    `INSERT INTO publications (post_id, group_id, mode, request_id, pmp_file_id, error)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (post_id, group_id) DO UPDATE
        SET error = EXCLUDED.error,
            mode = EXCLUDED.mode,
            request_id = EXCLUDED.request_id
     RETURNING *`,
    [postId, groupId, mode ?? 'draft', requestId ?? null, pmpFileId ?? null,
      String(message).slice(0, 1000)],
  );
  return rows[0];
}

/**
 * Уже известный `file_id` этой обложки. Картинка заливается в postmypost один раз
 * и переиспользуется всеми группами — это и экономия трафика, и требование этапа.
 */
export async function fileIdForPost(postId) {
  const { rows } = await query(
    `SELECT pmp_file_id FROM publications
      WHERE post_id = $1 AND pmp_file_id IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [postId],
  );
  return rows[0]?.pmp_file_id ?? null;
}

/**
 * Убрать запись: публикация удалена из postmypost, значит её больше нет и у нас.
 * Хранить «удалённую публикацию» как ошибку было бы нечестно — уникальный индекс
 * по (post_id, group_id) всё равно не даст двух записей на одну группу.
 */
export async function remove(id) {
  const { rows } = await query('DELETE FROM publications WHERE id = $1 RETURNING *', [id]);
  return rows[0] ?? null;
}

/** Есть ли у поста хоть одна живая публикация — от этого зависит его статус. */
export async function hasSuccess(postId) {
  const { rows } = await query(
    `SELECT 1 FROM publications
      WHERE post_id = $1 AND error IS NULL AND pmp_publication_id IS NOT NULL
      LIMIT 1`,
    [postId],
  );
  return rows.length > 0;
}

/**
 * Этот пост уже уехал в эту группу? Нужно дневному лимиту: повторная публикация
 * того же поста обновляет существующую строку и лимит второй раз не расходует.
 */
export async function isPublished(postId, groupId) {
  const { rows } = await query(
    `SELECT 1 FROM publications
      WHERE post_id = $1 AND group_id = $2
        AND error IS NULL AND pmp_publication_id IS NOT NULL
      LIMIT 1`,
    [postId, groupId],
  );
  return rows.length > 0;
}

export async function listByPost(postId) {
  const { rows } = await query(
    `SELECT p.*, g.name AS group_name, g.login AS group_login
       FROM publications p
       JOIN groups g ON g.id = p.group_id
      WHERE p.post_id = $1
      ORDER BY p.id DESC`,
    [postId],
  );
  return rows;
}

export async function listRecent(limit = 30) {
  const { rows } = await query(
    `SELECT p.*, g.name AS group_name, po.title AS post_title, po.topic_key
       FROM publications p
       JOIN groups g ON g.id = p.group_id
       JOIN posts po ON po.id = p.post_id
      ORDER BY p.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Лог публикаций для раздела «Опубликовано»: группа, тема, время, обложка, ссылка.
 * Фильтры — по группе и по исходу (уехало / сбой): в истории на сотни строк
 * «покажи всё, что не уехало в эту группу» это первый вопрос.
 */
export async function listForLog({ limit = 50, groupId, only } = {}) {
  const where = [];
  const params = [];
  if (groupId) {
    params.push(groupId);
    where.push(`p.group_id = $${params.length}`);
  }
  if (only === 'failed') where.push('p.error IS NOT NULL');
  if (only === 'ok') where.push('p.error IS NULL AND p.pmp_publication_id IS NOT NULL');
  if (only === 'live') where.push("p.mode = 'live' AND p.error IS NULL");
  params.push(limit);

  const { rows } = await query(
    `SELECT p.*, g.name AS group_name, g.login AS group_login, g.external_id AS group_external_id, g.chanel_id AS group_chanel_id,
            po.title AS post_title, po.topic_key, po.image_url, po.status AS post_status,
            a.topic_name, a.url AS article_url
       FROM publications p
       JOIN groups g ON g.id = p.group_id
       JOIN posts po ON po.id = p.post_id
       LEFT JOIN articles a ON a.id = po.article_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(p.post_at, p.created_at) DESC, p.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT p.*, g.pmp_account_id, g.name AS group_name
       FROM publications p JOIN groups g ON g.id = p.group_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Адрес поста на стене — приходит от postmypost уже после реальной публикации. */
export async function setVkUrl(id, url) {
  await query('UPDATE publications SET vk_url = $2 WHERE id = $1', [id, url]);
}

export async function countAll() {
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE error IS NOT NULL)::int AS failed,
            count(*) FILTER (WHERE mode = 'live')::int AS live
       FROM publications`,
  );
  return rows[0];
}
