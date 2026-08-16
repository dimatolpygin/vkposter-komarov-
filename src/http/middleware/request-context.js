import { runWithContext, newRequestId, getRequestId } from '../../context.js';
import { log } from '../../logger.js';

const logger = log('http');

/**
 * Ставит request-id на каждый входящий запрос (или подхватывает X-Request-Id извне),
 * открывает контекст на всё время обработки и логирует входящий/исходящий пакет.
 * Дальше по коду request-id доступен без проброса параметрами.
 */
export function requestContext() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && /^[\w-]{4,64}$/.test(incoming) ? incoming : newRequestId();

    runWithContext({ requestId, source: 'http' }, () => {
      res.setHeader('X-Request-Id', requestId);
      const startedAt = process.hrtime.bigint();

      logger.info(
        { method: req.method, url: req.originalUrl, ip: req.ip, ua: req.get('user-agent') },
        `→ входящий запрос ${req.method} ${req.originalUrl}`,
      );

      res.on('finish', () => {
        const ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
        const line = `← ответ ${res.statusCode} за ${ms} мс на ${req.method} ${req.originalUrl}`;
        const fields = { method: req.method, url: req.originalUrl, status: res.statusCode, ms };
        if (res.statusCode >= 500) logger.error(fields, line);
        else if (res.statusCode >= 400) logger.warn(fields, line);
        else logger.info(fields, line);
      });

      next();
    });
  };
}

export { getRequestId };
