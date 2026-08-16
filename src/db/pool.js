import pg from 'pg';
import { config } from '../config.js';
import { log, errFields } from '../logger.js';

const logger = log('БД');

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  logger.error(errFields(error), 'Ошибка простаивающего соединения с БД');
});

/** Запрос с логом: текст (сжатый), длительность, число строк. */
export async function query(text, params = []) {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await pool.query(text, params);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.debug(
      { sql: text.replace(/\s+/g, ' ').trim().slice(0, 200), rows: result.rowCount, ms: Math.round(ms) },
      'SQL-запрос выполнен',
    );
    return result;
  } catch (error) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.error(
      { sql: text.replace(/\s+/g, ' ').trim().slice(0, 200), params, ms: Math.round(ms), ...errFields(error) },
      'SQL-запрос упал',
    );
    throw error;
  }
}

/** Транзакция: коммит при успехе, откат при любой ошибке. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Выполнить работу под advisory lock — так параллельные прогоны не наступают друг на друга.
 *
 * Redis в проекте нет (2 ядра / 2 ГБ), поэтому блокировки держим в Postgres. Лок берётся
 * на отдельном соединении и живёт ровно столько, сколько живёт это соединение: упавший
 * процесс не оставляет вечный лок, потому что соединение закрывается вместе с ним.
 *
 * @param {number} key числовой ключ лока (свой на каждый вид работы)
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn работа под локом
 * @returns {Promise<{acquired: boolean, result?: any}>} `acquired: false` — лок занят
 */
export async function withAdvisoryLock(key, fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!rows[0]?.ok) {
      logger.warn({ лок: key }, 'Advisory lock занят — работа не начата');
      return { acquired: false };
    }
    try {
      return { acquired: true, result: await fn(client) };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/**
 * Ждём, пока БД примет соединение. Контейнер app стартует раньше postgres даже
 * с depends_on: condition: service_healthy — на медленной машине healthcheck может
 * успеть раньше, чем postgres реально готов принимать запросы.
 */
export async function waitForDatabase() {
  const { connectRetries, connectRetryDelayMs } = config.db;
  for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      logger.info({ host: config.db.host, db: config.db.database, attempt }, 'Соединение с БД установлено');
      return;
    } catch (error) {
      if (attempt === connectRetries) {
        logger.error(errFields(error), `БД не ответила за ${connectRetries} попыток — останавливаемся`);
        throw error;
      }
      logger.warn(
        { attempt, retries: connectRetries, message: error.message },
        `БД пока недоступна, повтор через ${connectRetryDelayMs} мс`,
      );
      await new Promise((resolve) => setTimeout(resolve, connectRetryDelayMs));
    }
  }
}

export async function closePool() {
  await pool.end();
  logger.info('Пул соединений с БД закрыт');
}
