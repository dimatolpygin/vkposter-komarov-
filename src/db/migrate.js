import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, waitForDatabase, closePool } from './pool.js';
import { log, errFields } from '../logger.js';

const logger = log('миграции');
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Раннер SQL-миграций. Требования проекта: применяется на старте контейнера ДО подъёма
 * HTTP-сервера и строго идемпотентно — повторный `docker compose up` не должен ломать БД.
 *
 * Гарантии:
 *  - каждая миграция применяется один раз (журнал в schema_migrations);
 *  - каждая миграция целиком в транзакции — упала на середине, откатилась полностью;
 *  - параллельные старты не наступают друг на друга (advisory lock на всю БД);
 *  - изменение уже применённого файла ловится по контрольной сумме и падает с внятной
 *    ошибкой, а не тихо расходится с прод-схемой.
 */

const LOCK_KEY = 4_812_733; // произвольная константа, одна на проект

async function ensureJournal(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text        PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer     NOT NULL
    )
  `);
}

async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith('.sql')).sort((a, b) => a.localeCompare(b, 'en'));
}

function checksumOf(sql) {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    logger.debug('Блокировка на миграции взята');
    await ensureJournal(client);

    const { rows: applied } = await client.query('SELECT version, checksum FROM schema_migrations');
    const appliedMap = new Map(applied.map((row) => [row.version, row.checksum]));

    const files = await listMigrationFiles();
    let appliedCount = 0;

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = checksumOf(sql);

      if (appliedMap.has(version)) {
        if (appliedMap.get(version) !== checksum) {
          throw new Error(
            `Миграция ${version} уже применена, но её файл изменён (контрольная сумма ${appliedMap.get(version)} → ${checksum}). ` +
              'Уже применённые миграции править нельзя — добавьте новую.',
          );
        }
        logger.debug({ version }, 'Миграция уже применена, пропускаем');
        continue;
      }

      const startedAt = process.hrtime.bigint();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        const ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
          [version, checksum, ms],
        );
        await client.query('COMMIT');
        appliedCount += 1;
        logger.info({ version, ms }, `Миграция применена: ${version}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error({ version, ...errFields(error) }, `Миграция упала: ${version} — откат выполнен`);
        throw error;
      }
    }

    const current = files.length ? files.at(-1).replace(/\.sql$/, '') : null;
    logger.info(
      { всего: files.length, применено: appliedCount, версия: current },
      appliedCount === 0
        ? `Новых миграций нет, схема на версии ${current ?? '—'}`
        : `Применено миграций: ${appliedCount}, схема на версии ${current}`,
    );
    return { current, total: files.length, applied: appliedCount };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** Версия схемы для /health — читается из журнала, а не из файлов. */
export async function getSchemaVersion() {
  const { rows } = await pool.query(
    'SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  if (!rows.length) return { version: null, appliedAt: null, count: 0 };
  const { rows: countRows } = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
  return { version: rows[0].version, appliedAt: rows[0].applied_at, count: countRows[0].count };
}

// Запуск напрямую: npm run migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await waitForDatabase();
    await runMigrations();
    await closePool();
  } catch (error) {
    logger.error(errFields(error), 'Прогон миграций завершился с ошибкой');
    await closePool().catch(() => {});
    process.exit(1);
  }
}
