-- Этап 10: разовое наполнение из архива.
--
-- Задача из брифа: на старте группа должна выглядеть живой, а не пустой, поэтому
-- первое наполнение берётся за прошлый период — с растягиванием по дням, чтобы
-- сто постов не выстрелили в стену за один час.
--
-- Почему отдельная таблица, а не ещё один вид прогона:
--
-- 1. **Задание живёт дольше одного прогона.** Наполнение — это сбор материалов по
--    источникам за период, потом план на несколько дней вперёд, потом исполнение.
--    У прогона (`runs`) нет ни периода, ни выбранных источников, ни кнопки «стоп».
-- 2. **Остановка должна работать между процессами.** Флаг в памяти не переживёт
--    рестарт контейнера, а кнопка «Остановить» обязана останавливать и то задание,
--    которое подхватил другой процесс. Поэтому статус — строка в БД, и исполнитель
--    перечитывает её перед каждым слотом.
-- 3. **Прерванное задание нужно продолжать.** План лежит в `run_items` (как и у обычного
--    прогона), задание помнит свой `run_id`, и после рестарта исполнение продолжается
--    с того слота, где встало.

-- Прогон наполнения — отдельный вид: обычный цикл не должен подхватывать его слоты
-- как «незаконченный прогон» и доводить их своими правилами.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check;
ALTER TABLE runs ADD CONSTRAINT runs_kind_check
  CHECK (kind IN ('cron', 'manual', 'backfill', 'source_check', 'archive'));

CREATE TABLE IF NOT EXISTS archive_jobs (
  id          bigserial   PRIMARY KEY,
  run_id      bigint      REFERENCES runs (id) ON DELETE SET NULL,
  -- collecting — идёт обход источников за период; running — исполняются слоты;
  -- stopping — нажата кнопка «Остановить», исполнитель дочитает её перед слотом.
  status      text        NOT NULL DEFAULT 'collecting'
              CHECK (status IN ('collecting', 'running', 'stopping', 'stopped', 'done', 'failed')),
  source_ids  integer[]   NOT NULL DEFAULT '{}',
  group_ids   integer[]   NOT NULL DEFAULT '{}',
  period_from date        NOT NULL,
  period_to   date        NOT NULL,
  limit_total integer     NOT NULL CHECK (limit_total BETWEEN 1 AND 500),
  -- Растягивание по дням: сколько постов в день на группу берёт наполнение. Верхняя
  -- граница всё равно `groups.posts_per_day` — задание не может превысить дневной лимит.
  per_day     integer     NOT NULL CHECK (per_day BETWEEN 1 AND 100),
  collected   integer     NOT NULL DEFAULT 0,
  planned     integer     NOT NULL DEFAULT 0,
  generated   integer     NOT NULL DEFAULT 0,
  published   integer     NOT NULL DEFAULT 0,
  failed      integer     NOT NULL DEFAULT 0,
  days        integer,
  stage       text,
  error       text,
  request_id  text,
  created_by  text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- Одно активное задание на систему. Два наполнения сразу — это гонка за те же
-- материалы и двойной расход дневных лимитов групп.
CREATE UNIQUE INDEX IF NOT EXISTS archive_jobs_one_active_uidx
  ON archive_jobs ((1)) WHERE status IN ('collecting', 'running', 'stopping');

CREATE INDEX IF NOT EXISTS archive_jobs_started_idx ON archive_jobs (started_at DESC);

-- Ключ `backfill_enabled` из этапа 1 («Идёт наполнение из архива») наконец получает
-- свой смысл: это индикатор активного задания, а не настройка. Правит его код.
UPDATE settings SET value = 'false', title = 'Идёт разовое наполнение из архива (ставится кодом)'
 WHERE key = 'backfill_enabled';
