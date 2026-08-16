import { query } from '../db/pool.js';

export async function listAll() {
  const { rows } = await query('SELECT * FROM sources ORDER BY id');
  return rows;
}

export async function listActive() {
  const { rows } = await query('SELECT * FROM sources WHERE is_active ORDER BY id');
  return rows;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM sources WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function setActive(id, isActive) {
  await query('UPDATE sources SET is_active = $2, updated_at = now() WHERE id = $1', [id, isActive]);
}

/**
 * Очередь источника: меньше число — раньше берём его темы. Значения из панели:
 * 10 (первым), 100 (обычная очередь), 900 (последним).
 */
export async function setPriority(id, priority) {
  await query('UPDATE sources SET priority = $2, updated_at = now() WHERE id = $1', [
    id,
    priority,
  ]);
}

export async function count() {
  const { rows } = await query('SELECT count(*)::int AS count FROM sources');
  return rows[0].count;
}
