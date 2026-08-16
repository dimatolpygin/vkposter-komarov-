import { query } from '../db/pool.js';

/** Все настройки как объект { key: value }. */
export async function getAll() {
  const { rows } = await query('SELECT key, value, title, updated_at FROM settings ORDER BY key');
  return rows;
}

export async function getMap() {
  const rows = await getAll();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function get(key, fallback = null) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? fallback;
}

export async function getInt(key, fallback) {
  const raw = await get(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export async function set(key, value, title = null) {
  await query(
    `INSERT INTO settings (key, value, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value), title],
  );
}

/** Записать значение только если ключа ещё нет (для сидов). */
export async function setIfAbsent(key, value, title = null) {
  const { rowCount } = await query(
    `INSERT INTO settings (key, value, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING`,
    [key, String(value), title],
  );
  return rowCount > 0;
}
