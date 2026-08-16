import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/**
 * Хеширование пароля на встроенном scrypt.
 * Почему не bcrypt/argon2: они тянут нативную сборку, а образ на alpine без build-base.
 * scrypt из node:crypto — memory-hard, для одного админского пароля более чем достаточно.
 *
 * Формат хранения: scrypt$N$r$p$keylen$salt_hex$hash_hex — параметры лежат рядом с хешем,
 * поэтому их можно поднять в будущем, не ломая уже сохранённые пароли.
 */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

export const PASSWORD_MIN_LENGTH = 8;

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов`);
  }
  const salt = randomBytes(16);
  const { N, r, p, keylen } = PARAMS;
  const derived = await scrypt(plain, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, keylen, salt.toString('hex'), derived.toString('hex')].join('$');
}

export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, keylen, saltHex, hashHex] = parts;
  try {
    const derived = await scrypt(plain, Buffer.from(saltHex, 'hex'), Number(keylen), {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
