import { COOKIE_NAME, verifyToken, cookieOptions } from './session.js';
import * as users from '../repo/users.js';
import { log } from '../logger.js';
import { extendContext } from '../context.js';

const logger = log('доступ');

/**
 * Разбирает cookie сессии и кладёт пользователя в req.user, если токен валиден.
 * Ставится до роутов — страницы логина тоже должны знать, вошёл человек или нет.
 *
 * Ключевая проверка: токен, выданный раньше users.password_changed_at, отвергается.
 * Именно так «смена пароля разлогинивает остальные сессии» без таблицы сессий.
 */
export function loadUser() {
  return async (req, res, next) => {
    req.user = null;
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return next();

    const payload = verifyToken(token);
    if (!payload) {
      logger.warn('Cookie сессии не прошла проверку подписи или просрочена — сбрасываем');
      res.clearCookie(COOKIE_NAME, cookieOptions());
      return next();
    }

    try {
      const user = await users.findById(payload.uid);
      if (!user) {
        res.clearCookie(COOKIE_NAME, cookieOptions());
        return next();
      }
      if (payload.iat < new Date(user.password_changed_at).getTime()) {
        logger.warn(
          { логин: user.login },
          'Сессия выдана до смены пароля — разлогиниваем',
        );
        res.clearCookie(COOKIE_NAME, cookieOptions());
        return next();
      }
      req.user = { id: user.id, login: user.login };
      extendContext({ user: user.login });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** Закрывает страницу: без входа — редирект на /login с возвратом на исходный адрес. */
export function requireAuth() {
  return (req, res, next) => {
    if (req.user) return next();
    logger.info(
      { url: req.originalUrl, ip: req.ip },
      `Доступ без входа к ${req.originalUrl} — редирект на /login`,
    );
    if (req.method !== 'GET') return res.status(401).json({ error: 'Требуется вход' });
    const back = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${back}`);
  };
}
