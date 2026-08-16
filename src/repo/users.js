import { query } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

export async function countUsers() {
  const { rows } = await query('SELECT count(*)::int AS count FROM users');
  return rows[0].count;
}

export async function findByLogin(login) {
  const { rows } = await query('SELECT * FROM users WHERE lower(login) = lower($1)', [login]);
  return rows[0] ?? null;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function createUser(login, plainPassword) {
  const hash = await hashPassword(plainPassword);
  const { rows } = await query(
    `INSERT INTO users (login, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (login) DO NOTHING
     RETURNING id, login`,
    [login, hash],
  );
  return rows[0] ?? null;
}

export async function markLogin(id) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

/**
 * Смена пароля. password_changed_at обновляется той же транзакцией — по этой метке
 * все ранее выданные cookie становятся недействительными (см. auth/session.js).
 */
export async function changePassword(id, plainPassword) {
  const hash = await hashPassword(plainPassword);
  const { rows } = await query(
    `UPDATE users
        SET password_hash = $2, password_changed_at = now()
      WHERE id = $1
      RETURNING password_changed_at`,
    [id, hash],
  );
  return rows[0]?.password_changed_at ?? null;
}
