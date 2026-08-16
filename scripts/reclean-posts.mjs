/**
 * Разовый прогон постобработки по уже сохранённым постам.
 *
 * Нужен, когда правила чистки поменялись (например, длинные тире заменены короткими):
 * текст в БД сгенерирован по старым правилам, и перегенерировать его через модель —
 * лишние деньги и другой текст. Правки идемпотентны: повторный запуск ничего не меняет.
 *
 * Запуск: docker compose exec app node scripts/reclean-posts.mjs
 */
import { pool, closePool } from '../src/db/pool.js';
import { cleanPostText } from '../src/lib/text-clean.js';

const { rows } = await pool.query('SELECT id, title, body FROM posts ORDER BY id');
let changed = 0;

for (const row of rows) {
  const title = cleanPostText(row.title).split('\n')[0];
  const body = cleanPostText(row.body);
  if (title === row.title && body === row.body) continue;

  await pool.query('UPDATE posts SET title = $2, body = $3, char_count = $4 WHERE id = $1', [
    row.id,
    title,
    body,
    body.length,
  ]);
  changed += 1;
  console.log(`Пост #${row.id}: обновлён, ${row.body.length} → ${body.length} символов`);
}

console.log(`Готово: проверено ${rows.length}, изменено ${changed}`);
await closePool();
