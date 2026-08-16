import { Router } from 'express';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { getSchemaVersion } from '../../db/migrate.js';
import { getRequestId } from '../../context.js';
import { log, errFields } from '../../logger.js';

const logger = log('health');

export function healthRouter() {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const checks = { db: 'нет', migrations: null };
    try {
      await pool.query('SELECT 1');
      checks.db = 'ok';

      const schema = await getSchemaVersion();
      checks.migrations = {
        версия: schema.version,
        применено: schema.count,
        применена: schema.appliedAt,
      };

      res.json({
        status: 'ok',
        service: 'vkposter',
        // Версия выката. /health открыт без авторизации, поэтому по нему видно
        // одним curl снаружи, доехал ли автодеплой, — не заходя в панель и на сервер.
        version: config.revision ?? 'dev',
        uptime_sec: Math.round(process.uptime()),
        request_id: getRequestId(),
        ...checks,
      });
    } catch (error) {
      logger.error(errFields(error), 'Проверка здоровья не прошла');
      res.status(503).json({
        status: 'degraded',
        service: 'vkposter',
        request_id: getRequestId(),
        ...checks,
        error: error.message,
      });
    }
  });

  return router;
}
