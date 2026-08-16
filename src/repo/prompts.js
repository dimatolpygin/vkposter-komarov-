import { query, withTransaction } from '../db/pool.js';
import { log } from '../logger.js';

const logger = log('промты');

/**
 * Промты с версиями. Активная версия одна на ключ — её берёт генерация.
 * Правка не перезаписывает текст, а создаёт новую версию: у клиента должна быть
 * возможность вернуться к предыдущей редакции, если качество постов просело.
 */

export async function getActive(key) {
  const { rows } = await query(
    'SELECT * FROM prompts WHERE key = $1 AND is_active LIMIT 1',
    [key],
  );
  return rows[0] ?? null;
}

export async function getActiveBody(key, fallback = '') {
  const row = await getActive(key);
  return row?.body ?? fallback;
}

export async function listVersions(key, limit = 20) {
  const { rows } = await query(
    `SELECT id, key, version, note, is_active, created_by, created_at, length(body) AS length
       FROM prompts WHERE key = $1 ORDER BY version DESC LIMIT $2`,
    [key, limit],
  );
  return rows;
}

export async function findVersion(key, version) {
  const { rows } = await query('SELECT * FROM prompts WHERE key = $1 AND version = $2', [
    key,
    version,
  ]);
  return rows[0] ?? null;
}

/**
 * Новая версия промта, сразу активная. Одна транзакция: снятие флага и вставка,
 * иначе частичный уникальный индекс (одна активная версия на ключ) поймает конфликт.
 * @returns {Promise<number>} номер созданной версии
 */
export async function saveVersion(key, body, { note = null, createdBy = null } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT COALESCE(max(version), 0) + 1 AS next FROM prompts WHERE key = $1',
      [key],
    );
    const version = rows[0].next;
    await client.query('UPDATE prompts SET is_active = false WHERE key = $1 AND is_active', [key]);
    await client.query(
      `INSERT INTO prompts (key, version, body, note, is_active, created_by)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [key, version, body, note, createdBy],
    );
    // Настройки держат зеркало активного промта: остальной код (и панель этапа 1)
    // читает его через settings, менять все обращения ради этапа 4 незачем.
    await client.query(
      `INSERT INTO settings (key, value, title) VALUES ($1, $2, 'зеркало активного промта')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [key, body],
    );
    logger.info({ промт: key, версия: version, символов: body.length, кто: createdBy },
      `Промт ${key}: сохранена версия ${version}`);
    return version;
  });
}

/** Возврат к прежней версии: активной становится она же, без создания копии. */
export async function activateVersion(key, version, { by = null } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT body FROM prompts WHERE key = $1 AND version = $2', [
      key,
      version,
    ]);
    if (rows.length === 0) throw new Error(`Версия ${version} промта ${key} не найдена`);
    await client.query('UPDATE prompts SET is_active = false WHERE key = $1 AND is_active', [key]);
    await client.query('UPDATE prompts SET is_active = true WHERE key = $1 AND version = $2', [
      key,
      version,
    ]);
    await client.query(
      `INSERT INTO settings (key, value, title) VALUES ($1, $2, 'зеркало активного промта')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [key, rows[0].body],
    );
    logger.info({ промт: key, версия: version, кто: by }, `Промт ${key}: откат к версии ${version}`);
    return version;
  });
}
