-- Этап 6: публикация в ВК через postmypost.
-- Таблицы groups и publications созданы на этапе 1, здесь — только то, чего им не хватает,
-- и настройки публикации.

-- Отметка «пост уехал»: статус posts уже умеет 'published', но нужна и дата —
-- по ней на этапах 8-11 строится «от свежих к старым» и лог публикаций.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS published_at timestamptz;

-- Режим, в котором создавалась публикация: draft (черновик) или live (в очередь на стену).
-- Хранится рядом с фактом: настройка публикации меняется, а история должна остаться честной.
ALTER TABLE publications ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'draft';
ALTER TABLE publications ADD COLUMN IF NOT EXISTS request_id text;

CREATE INDEX IF NOT EXISTS publications_post_idx ON publications (post_id);

INSERT INTO settings (key, value, title) VALUES
  ('pmp_upload_poll_ms',   '3000',   'Интервал опроса загрузки картинки в postmypost, мс'),
  ('pmp_upload_wait_ms',   '120000', 'Максимальное ожидание загрузки картинки в postmypost, мс'),
  ('publish_delay_minutes', '3',     'На сколько минут вперёд ставится post_at при публикации из панели')
ON CONFLICT (key) DO NOTHING;
