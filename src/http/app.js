import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from '../config.js';
import { log, errFields } from '../logger.js';
import { getRequestId } from '../context.js';
import { mediaRoot } from '../lib/media.js';
import { requestContext } from './middleware/request-context.js';
import { loadUser } from '../auth/middleware.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { panelRouter } from './routes/panel.js';
import { debugRouter } from './routes/debug.js';

const logger = log('http');

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // на проде за nginx/Caddy — иначе req.ip врёт
  app.disable('x-powered-by');

  app.use(requestContext());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // /health открыт без авторизации — его дёргает healthcheck контейнера.
  app.use(healthRouter());

  // Обложки постов раздаются БЕЗ авторизации и намеренно: postmypost скачивает картинку
  // по URL сам, в момент публикации, и никаких cookie у него нет. Отдаём только файлы
  // из тома media, статикой, с длинным кешем — имена уникальны, перезаписи не бывает.
  app.use(
    '/media',
    express.static(mediaRoot(), {
      index: false,
      dotfiles: 'ignore',
      maxAge: '30d',
    }),
  );
  // Несуществующий файл обложки не должен проваливаться в панель и получать редирект
  // на форму входа — отвечаем честным 404 прямо здесь.
  app.use('/media', (req, res) => {
    res.status(404).json({ error: 'Файл не найден', path: req.originalUrl });
  });

  if (!config.isProd) {
    app.use(debugRouter());
    logger.warn('Подключены отладочные роуты /_debug/* (только вне production)');
  }

  // Всё ниже знает, вошёл пользователь или нет.
  app.use(loadUser());
  app.use(authRouter());
  app.use(panelRouter());

  app.use((req, res) => {
    res.status(404).json({ error: 'Не найдено', path: req.originalUrl, request_id: getRequestId() });
  });

  // eslint-disable-next-line no-unused-vars -- четвёртый аргумент обязателен для Express
  app.use((error, req, res, _next) => {
    logger.error(
      { method: req.method, url: req.originalUrl, ...errFields(error) },
      'Необработанная ошибка при обработке запроса',
    );
    res.status(500).json({ error: 'Внутренняя ошибка', request_id: getRequestId() });
  });

  return app;
}
