import { Router } from 'express';
import { COOKIE_NAME, issueToken, cookieOptions } from '../../auth/session.js';
import { requireAuth } from '../../auth/middleware.js';
import { verifyPassword, PASSWORD_MIN_LENGTH } from '../../auth/password.js';
import * as users from '../../repo/users.js';
import { loginPage, page, esc } from '../views/layout.js';
import { log, errFields } from '../../logger.js';

const logger = log('вход');

/**
 * Простой тормоз на подбор пароля: после 5 неудач с одного IP — пауза.
 * В памяти процесса: аккаунт один, кластера нет, отдельного хранилища не требуется.
 */
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

function throttleState(ip) {
  const entry = attempts.get(ip);
  if (!entry) return { locked: false, count: 0 };
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return { locked: true, count: entry.count, secondsLeft: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
  }
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
    attempts.delete(ip);
    return { locked: false, count: 0 };
  }
  return { locked: false, count: entry.count };
}

function registerFailure(ip) {
  const entry = attempts.get(ip) ?? { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOCK_MS;
  attempts.set(ip, entry);
  return entry;
}

function safeNext(raw) {
  // Открытый редирект недопустим: пускаем только относительные пути внутри панели.
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export function authRouter() {
  const router = Router();

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.type('html').send(loginPage({ next: safeNext(req.query.next) }));
  });

  router.post('/login', async (req, res, next) => {
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    const target = safeNext(req.body?.next);
    const ip = req.ip;

    const throttle = throttleState(ip);
    if (throttle.locked) {
      logger.warn({ ip, попыток: throttle.count }, 'Вход заблокирован: слишком много неудачных попыток');
      return res.status(429).type('html').send(
        loginPage({
          login,
          next: target,
          message: {
            kind: 'err',
            text: `Слишком много неудачных попыток. Попробуйте через ${throttle.secondsLeft} сек.`,
          },
        }),
      );
    }

    try {
      const user = await users.findByLogin(login);
      const ok = user ? await verifyPassword(password, user.password_hash) : false;

      if (!ok) {
        const entry = registerFailure(ip);
        logger.warn(
          { логин: login, ip, попытка: entry.count, ua: req.get('user-agent') },
          `Неудачная попытка входа: логин "${login}"`,
        );
        return res.status(401).type('html').send(
          loginPage({ login, next: target, message: { kind: 'err', text: 'Неверный логин или пароль' } }),
        );
      }

      attempts.delete(ip);
      await users.markLogin(user.id);
      res.cookie(COOKIE_NAME, issueToken({ userId: user.id, login: user.login }), cookieOptions());
      logger.info({ логин: user.login, ip, ua: req.get('user-agent') }, `Вход выполнен: ${user.login}`);
      return res.redirect(target);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', (req, res) => {
    const who = req.user?.login ?? 'неизвестный';
    res.clearCookie(COOKIE_NAME, cookieOptions());
    logger.info({ логин: who, ip: req.ip }, `Выход выполнен: ${who}`);
    res.redirect('/login');
  });

  // Смена пароля
  router.get('/account', requireAuth(), (req, res) => {
    res.type('html').send(renderAccount({ user: req.user }));
  });

  router.post('/account/password', requireAuth(), async (req, res, next) => {
    const current = String(req.body?.current ?? '');
    const next1 = String(req.body?.next1 ?? '');
    const next2 = String(req.body?.next2 ?? '');

    const fail = (text) =>
      res.status(400).type('html').send(renderAccount({ user: req.user, message: { kind: 'err', text } }));

    try {
      const user = await users.findById(req.user.id);
      if (!user || !(await verifyPassword(current, user.password_hash))) {
        logger.warn({ логин: req.user.login, ip: req.ip }, 'Смена пароля: текущий пароль указан неверно');
        return fail('Текущий пароль указан неверно');
      }
      if (next1 !== next2) return fail('Новые пароли не совпадают');
      if (next1.length < PASSWORD_MIN_LENGTH) {
        return fail(`Новый пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов`);
      }
      if (next1 === current) return fail('Новый пароль совпадает с текущим');

      await users.changePassword(user.id, next1);
      // Своя сессия тоже стала недействительной — выдаём новую, чтобы не выкидывать себя.
      res.cookie(COOKIE_NAME, issueToken({ userId: user.id, login: user.login }), cookieOptions());
      logger.info(
        { логин: user.login, ip: req.ip },
        `Пароль изменён: ${user.login}. Все остальные сессии разлогинены`,
      );
      return res.type('html').send(
        renderAccount({
          user: req.user,
          message: {
            kind: 'ok',
            text: 'Пароль изменён. Все другие открытые сессии разлогинены.',
          },
        }),
      );
    } catch (error) {
      logger.error(errFields(error), 'Смена пароля упала');
      return next(error);
    }
  });

  return router;
}

function renderAccount({ user, message }) {
  const body = `
    <div class="card" style="max-width:460px">
      <form method="post" action="/account/password">
        <div class="field">
          <label for="current">Текущий пароль</label>
          <input id="current" name="current" type="password" autocomplete="current-password" required>
        </div>
        <div class="field">
          <label for="next1">Новый пароль</label>
          <input id="next1" name="next1" type="password" autocomplete="new-password" required>
          <div class="hint">Не короче ${PASSWORD_MIN_LENGTH} символов</div>
        </div>
        <div class="field">
          <label for="next2">Новый пароль ещё раз</label>
          <input id="next2" name="next2" type="password" autocomplete="new-password" required>
        </div>
        <button type="submit">Сменить пароль</button>
      </form>
    </div>
    <div class="card" style="max-width:460px">
      <strong>Логин:</strong> <code>${esc(user.login)}</code>
      <div class="hint">После смены пароля все сессии в других браузерах будут закрыты.</div>
    </div>`;

  return page({
    title: 'Аккаунт',
    active: '/account',
    user,
    heading: 'Аккаунт',
    sub: 'Смена пароля для входа в панель.',
    message,
    body,
  });
}
