-- Этап 11: журнал сбоев для раздела «Ошибки».
--
-- Почему отдельная таблица, а не «собрать ошибки из runs/run_items/publications»:
--
-- 1. **Контекст сбоя нигде не хранится.** В `run_items.error` и `publications.error`
--    лежит только текст сообщения. Критерий этапа требует показать, **на каком шаге**
--    конвейера и **в каком внешнем сервисе** упало и **какое тело ответа** пришло —
--    сейчас это есть только в логах контейнера, куда клиенту ходить нечем.
-- 2. **Сбой бывает вне прогона.** Проверка источника, синхронизация групп, ручной
--    режим, наполнение из архива, тик планировщика — у них нет ни слота, ни публикации,
--    и ошибка не оседает нигде.
-- 3. **`request-id` связывает панель с логами.** Он и так пишется в каждую строку лога;
--    храня его рядом с ошибкой, получаем сквозной путь «карточка в панели →
--    `docker compose logs app | grep <rid>`».
--
-- Таблица служебная: пишем «широко» (любой сбой, который поймали), читаем последние N.
-- Роста не боимся — при 30 постах в день это единицы строк в сутки, плюс чистка кнопкой.

CREATE TABLE IF NOT EXISTS app_errors (
  id          bigserial   PRIMARY KEY,
  -- Шаг конвейера на человеческом языке: «генерация текста», «публикация», ...
  -- Свободная строка, а не enum: шаги добавляются вместе с кодом, а миграция ради
  -- нового значения — лишний повод не записать ошибку вообще.
  stage       text        NOT NULL,
  -- Внешний сервис, если сбой пришёл от него: openrouter / kie.ai / postmypost / firecrawl.
  service     text,
  message     text        NOT NULL,
  -- Тело ответа провайдера (обрезанное) — именно оно объясняет 422 и 401.
  details     text,
  http_status integer,
  url         text,
  request_id  text,
  run_id      bigint      REFERENCES runs (id) ON DELETE SET NULL,
  post_id     bigint      REFERENCES posts (id) ON DELETE SET NULL,
  group_id    integer     REFERENCES groups (id) ON DELETE SET NULL,
  article_id  bigint      REFERENCES articles (id) ON DELETE SET NULL,
  source_id   integer     REFERENCES sources (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_errors_created_idx ON app_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS app_errors_run_idx ON app_errors (run_id);

-- Ссылка на пост в ВК. postmypost адрес записи на стене не отдаёт, поэтому поле
-- заполняется тем, что удалось получить после живой публикации; для черновика его
-- не существует в природе, и панель показывает ссылку на саму группу.
ALTER TABLE publications ADD COLUMN IF NOT EXISTS vk_url text;
