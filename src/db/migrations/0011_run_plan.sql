-- Этап 8: уникальность по группам + расписание.
--
-- Прогон перестаёт быть «нажал кнопку — что-то опубликовалось» и становится планом:
-- сначала материалы распределяются по группам и слотам времени, потом план исполняется.
-- План хранится в БД, а не в памяти процесса, ровно для одного случая: прогон прервался
-- (рестарт контейнера, обрыв сети), и следующий запуск должен продолжить, а не начать
-- заново и не опубликовать то же дважды.

CREATE TABLE IF NOT EXISTS run_items (
  id         bigserial   PRIMARY KEY,
  run_id     bigint      NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  group_id   integer     NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  -- Номер слота внутри прогона: задаёт и порядок исполнения, и время публикации.
  slot_no    integer     NOT NULL,
  article_id bigint      REFERENCES articles (id) ON DELETE SET NULL,
  post_id    bigint      REFERENCES posts (id)    ON DELETE SET NULL,
  post_at    timestamptz NOT NULL,
  status     text        NOT NULL DEFAULT 'planned'
             CHECK (status IN ('planned', 'generated', 'published', 'failed', 'skipped')),
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_items_run_idx ON run_items (run_id, slot_no);
CREATE INDEX IF NOT EXISTS run_items_group_idx ON run_items (group_id);

-- Главная гарантия этапа: внутри прогона один материал уходит ровно в одну группу.
-- Не «проверим в коде», а ограничение схемы: пересечение физически не вставится.
CREATE UNIQUE INDEX IF NOT EXISTS run_items_run_article_uidx
  ON run_items (run_id, article_id) WHERE article_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS run_items_run_post_uidx
  ON run_items (run_id, post_id) WHERE post_id IS NOT NULL;

-- Настройки расписания и антиспама. schedule_mode/interval/daily_at засеяны на этапе 1,
-- здесь окно постинга и джиттер: публикации не должны падать в одну минуту и не должны
-- уходить ночью.
INSERT INTO settings (key, value, title) VALUES
  ('posting_window_start', '10:00', 'Начало окна публикаций, МСК'),
  ('posting_window_end',   '21:00', 'Конец окна публикаций, МСК'),
  ('slot_jitter_minutes',  '7',     'Случайный разброс времени публикации внутри слота, минут')
ON CONFLICT (key) DO NOTHING;
