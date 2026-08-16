import { config } from './config.js';
import { logger, log, errFields } from './logger.js';
import { runWithContext, newRequestId } from './context.js';
import { pool, waitForDatabase, closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { runSeeds } from './bootstrap/seed.js';
import { createApp } from './http/app.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { resumeArchiveFill } from './services/archive-fill.js';

const startupLog = log('запуск');

/**
 * Порядок старта важен: сначала БД и миграции, только потом HTTP.
 * Иначе первый же запрос может прийти в схему, которой ещё нет.
 */
async function main() {
  startupLog.info(
    { окружение: config.nodeEnv, порт: config.http.port, node: process.version },
    'Стартуем vkposter',
  );

  await waitForDatabase();
  const migrations = await runMigrations();

  // Отмечаем факт старта в БД — заодно подтверждает, что запись работает, а не только чтение.
  const { rows } = await pool.query(
    `UPDATE app_meta
        SET app_version = $1, started_at = now(), boot_count = boot_count + 1
      WHERE id = 1
      RETURNING boot_count`,
    [process.env.APP_VERSION ?? '0.1.0'],
  );
  startupLog.info({ запусков: rows[0]?.boot_count }, `Запуск номер ${rows[0]?.boot_count} записан в БД`);

  // Аккаунт панели и промты — после миграций, до приёма запросов.
  await runSeeds();

  const app = createApp();
  const server = app.listen(config.http.port, '0.0.0.0', () => {
    startupLog.info(
      { url: `http://localhost:${config.http.port}`, схема: migrations.current },
      `HTTP-сервер слушает порт ${config.http.port}, схема БД: ${migrations.current}`,
    );
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Планировщик поднимается после HTTP: прогон должен идти на живом приложении,
  // а не в момент, когда порт ещё не открыт. Сам он ничего не делает, пока
  // `schedule_enabled` в настройках не переведён в `on`.
  startScheduler();

  // Наполнение из архива живёт днями и переживает рестарт: незаконченное задание
  // подхватывается с того слота, где встало. Иначе оно навсегда осталось бы в статусе
  // «выполняется» и блокировало запуск нового.
  await resumeArchiveFill().catch((error) =>
    startupLog.error(errFields(error), 'Не удалось подхватить задание наполнения'),
  );

  setupShutdown(server);
}

/** Аккуратная остановка: перестаём принимать запросы, закрываем пул, выходим. */
function setupShutdown(server) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    startupLog.info({ сигнал: signal }, `Получен ${signal} — останавливаемся`);

    const forceExit = setTimeout(() => {
      startupLog.error('Остановка затянулась — выходим принудительно');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    stopScheduler();
    await new Promise((resolve) => server.close(resolve));
    startupLog.info('HTTP-сервер закрыт');
    await closePool().catch((error) => startupLog.error(errFields(error), 'Не удалось закрыть пул БД'));
    startupLog.info('Остановка завершена');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error(errFields(reason), 'Необработанное отклонение промиса');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal(errFields(error), 'Необработанное исключение — процесс будет остановлен');
    shutdown('uncaughtException');
  });
}

runWithContext({ requestId: newRequestId('boot'), source: 'запуск' }, main).catch(async (error) => {
  startupLog.fatal(errFields(error), 'Старт не удался');
  await closePool().catch(() => {});
  process.exit(1);
});
