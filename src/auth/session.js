import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Сессия в подписанной cookie, без таблицы сессий.
 *
 * Почему так: аккаунт один, серверов один. Инвалидация «всех остальных сессий» при смене
 * пароля решается сравнением метки выпуска токена (iat) с users.password_changed_at —
 * токен, выданный до смены пароля, автоматически становится недействительным.
 * Это выполняет требование «есть вход — должен быть и выход» без лишней таблицы.
 */

export const COOKIE_NAME = 'vkp_session';
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 суток

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function sign(payloadB64) {
  return createHmac('sha256', config.session.secret).update(payloadB64).digest('base64url');
}

/** Токен: base64url(payload).base64url(hmac) */
export function issueToken({ userId, login }) {
  const payload = {
    uid: userId,
    login,
    iat: Date.now(),
    nonce: randomBytes(6).toString('hex'),
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Возвращает payload или null, если подпись не сходится / токен просрочен. */
export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, signature] = token.split('.', 2);
  if (!payloadB64 || !signature) return null;

  const expected = sign(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.uid || !payload?.iat) return null;
  if (Date.now() - payload.iat > MAX_AGE_MS) return null;
  return payload;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd, // на проде за HTTPS; локально по http cookie должна работать
    maxAge: MAX_AGE_MS,
    path: '/',
  };
}
