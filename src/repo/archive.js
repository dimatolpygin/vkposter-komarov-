import { query } from '../db/pool.js';

/**
 * Задания на разовое наполнение из архива.
 *
 * Главное свойство таблицы — статус читается из БД, а не из памяти процесса: кнопка
 * «Остановить» ставит `stopping`, исполнитель видит это перед следующим слотом и
 * останавливается. Так остановка работает и после рестарта контейнера, и если задание
 * подхватил другой процесс.
 */

const ACTIVE = ['collecting', 'running', 'stopping'];

export async function create({
  sourceIds, groupIds, periodFrom, periodTo, limitTotal, perDay, requestId, createdBy,
}) {
  const { rows } = await query(
    `INSERT INTO archive_jobs (source_ids, group_ids, period_from, period_to, limit_total,
                               per_day, request_id, created_by, stage)
     VALUES ($1::int[], $2::int[], $3, $4, $5, $6, $7, $8, 'сбор материалов')
     RETURNING *`,
    [sourceIds, groupIds, periodFrom, periodTo, limitTotal, perDay, requestId ?? null,
      createdBy ?? null],
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM archive_jobs WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Активное задание, если оно есть. Их не может быть двух — гарантия уникального индекса. */
export async function findActive() {
  const { rows } = await query(
    `SELECT * FROM archive_jobs WHERE status = ANY($1::text[]) ORDER BY id DESC LIMIT 1`,
    [ACTIVE],
  );
  return rows[0] ?? null;
}

export async function listRecent(limit = 10) {
  const { rows } = await query(
    'SELECT * FROM archive_jobs ORDER BY started_at DESC LIMIT $1',
    [limit],
  );
  return rows;
}

/** Только статус — им обмениваются панель (кнопка «Стоп») и исполнитель. */
export async function statusOf(id) {
  const { rows } = await query('SELECT status FROM archive_jobs WHERE id = $1', [id]);
  return rows[0]?.status ?? null;
}

export async function setStage(id, stage) {
  await query('UPDATE archive_jobs SET stage = $2 WHERE id = $1', [id, stage]);
}

export async function setCollected(id, collected) {
  await query('UPDATE archive_jobs SET collected = $2 WHERE id = $1', [id, collected]);
}

/** План построен: задание переходит к исполнению. */
export async function startExecution(id, { runId, planned, days }) {
  const { rows } = await query(
    `UPDATE archive_jobs
        SET run_id = $2, planned = $3, days = $4, status = 'running', stage = 'публикация'
      WHERE id = $1 AND status <> 'stopping'
      RETURNING *`,
    [id, runId, planned, days],
  );
  // Строки нет — задание успели остановить между сбором и планом. Не перетираем `stopping`.
  return rows[0] ?? null;
}

export async function bump(id, { generated = 0, published = 0, failed = 0 }) {
  await query(
    `UPDATE archive_jobs
        SET generated = generated + $2, published = published + $3, failed = failed + $4
      WHERE id = $1`,
    [id, generated, published, failed],
  );
}

/** Запрос на остановку. Слоты, которые уже уехали, не отзываются — так и задумано. */
export async function requestStop(id) {
  const { rows } = await query(
    `UPDATE archive_jobs SET status = 'stopping'
      WHERE id = $1 AND status IN ('collecting', 'running')
      RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

export async function finish(id, { status, error = null, stage = null }) {
  const { rows } = await query(
    `UPDATE archive_jobs
        SET status = $2, error = $3, stage = COALESCE($4, stage), finished_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, status, error ? String(error).slice(0, 2000) : null, stage],
  );
  return rows[0] ?? null;
}
