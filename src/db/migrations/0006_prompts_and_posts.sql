-- Этап 4: генерация текста поста.
--
-- Промты переезжают из плоских настроек в отдельную таблицу с версиями. Причина:
-- промт клиента — главный рычаг качества, его будут править часто и не всегда удачно.
-- Нужна история и возможность вернуться к предыдущей редакции без деплоя.
-- Активная версия одна на ключ, её и берёт генерация.

CREATE TABLE IF NOT EXISTS prompts (
  id         bigserial   PRIMARY KEY,
  key        text        NOT NULL,
  version    integer     NOT NULL,
  body       text        NOT NULL,
  note       text,
  is_active  boolean     NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

-- Активная версия ключа ровно одна: активация новой снимает флаг с прежней в одной транзакции.
CREATE UNIQUE INDEX IF NOT EXISTS prompts_active_uidx ON prompts (key) WHERE is_active;

-- Перенос текущих промтов из settings как версии 1. Значения там засеяны на старте
-- приложения из docs/prompts/post_prompt.seed.txt, то есть это реальный промт клиента.
INSERT INTO prompts (key, version, body, note, is_active, created_by)
SELECT s.key, 1, s.value, 'перенесено из настроек при переходе на версионные промты', true, 'миграция'
  FROM settings s
 WHERE s.key IN ('post_prompt', 'image_prompt')
   AND NOT EXISTS (SELECT 1 FROM prompts p WHERE p.key = s.key);

-- ─────────────────────────────────────────────────────────────────────────────
-- Результат генерации: чем сделан пост и сколько это стоило. Без этих полей
-- нельзя ни разобрать сбой («какая модель ответила?»), ни посчитать расход.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE posts ADD COLUMN IF NOT EXISTS provider    text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS tokens_in   integer;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS tokens_out  integer;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS cost_usd    numeric(10, 6);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS latency_ms  integer;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS attempts    integer NOT NULL DEFAULT 1;
-- topic_key дублируется в пост осознанно: материал может быть удалён, а знание
-- «эту тему уже отрабатывали» должно жить дальше (нужно на этапах 6 и 8).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS topic_key   text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS request_id  text;

CREATE INDEX IF NOT EXISTS posts_topic_key_idx ON posts (topic_key);
CREATE INDEX IF NOT EXISTS posts_created_idx   ON posts (created_at DESC);

-- Настройки генерации. Держим в БД, а не в .env: клиент меняет их из панели.
INSERT INTO settings (key, value, title)
VALUES
  ('openrouter_temperature',  '0.85', 'Температура генерации'),
  ('openrouter_max_tokens',   '1800', 'Максимум токенов на ответ'),
  ('openrouter_service_tier', 'flex', 'Тир Gemini: flex дешевле, priority быстрее'),
  ('generation_attempts',     '3',    'Попыток генерации до отказа (валидация не прошла)'),
  ('ad_link',                 'https://proverka-zarabotka.online', 'Ссылка в рекламном блоке')
ON CONFLICT (key) DO NOTHING;
