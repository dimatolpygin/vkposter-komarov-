-- Этап 5: обложка поста через kie.ai.
--
-- Колонки image_url и image_path заведены ещё в 0002 — здесь добавляется то, без чего
-- нельзя разобрать сбой и посчитать расход: id задачи провайдера, версия промта обложки,
-- списанные кредиты, латентность, текст ошибки.
--
-- image_task_id критичен по деньгам: кредиты списываются за задачу, а не за скачивание.
-- Он пишется в БД СРАЗУ после createTask, до поллинга: если контейнер умрёт на ожидании,
-- уже оплаченную генерацию можно дочитать по taskId, а не платить второй раз.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_task_id       text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_prompt_version integer;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_credits        integer;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_latency_ms     integer;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_error          text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_generated_at   timestamptz;

-- Поиск незавершённых задач: пост с задачей, но без картинки — кандидат на дочитывание.
CREATE INDEX IF NOT EXISTS posts_image_pending_idx
  ON posts (id) WHERE image_task_id IS NOT NULL AND image_path IS NULL;

-- Настройки генерации обложки. В БД, а не в .env: клиент правит их из панели.
--
-- Про resolution/aspect_ratio: у kie.ai они конфликтуют. aspect_ratio=auto даёт только 1K,
-- и запрос с 2K при auto падает на создании задачи. Поэтому соотношение задаётся явно.
-- 16:9 — формат обложки ВК и разрешён во всех разрешениях.
INSERT INTO settings (key, value, title)
VALUES
  ('kie_aspect_ratio', '16:9',   'Соотношение сторон обложки (при 2K нельзя auto, 5:4, 4:5, 3:1, 1:3, 9:21)'),
  ('kie_resolution',   '2K',     'Разрешение обложки: 1K / 2K / 4K'),
  ('kie_poll_ms',      '5000',   'Интервал опроса статуса задачи kie.ai, мс'),
  ('kie_wait_ms',      '300000', 'Общий таймаут ожидания картинки, мс (генерация обычно 30-90 с)'),
  ('kie_min_credits',  '20',     'Минимум кредитов kie.ai, ниже которого генерация не начинается')
ON CONFLICT (key) DO NOTHING;
