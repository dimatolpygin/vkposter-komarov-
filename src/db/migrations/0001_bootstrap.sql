-- Этап 0: базовые расширения и служебная таблица приложения.
-- Прикладные таблицы (sources, articles, posts, groups, settings, runs, users)
-- появляются на этапе 1 отдельной миграцией.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Служебные метаданные приложения: одна строка (id = 1), пишется на старте.
-- Нужна, чтобы /health мог подтвердить не только коннект, но и запись в БД.
CREATE TABLE IF NOT EXISTS app_meta (
  id            smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  app_version   text        NOT NULL DEFAULT '0.0.0',
  started_at    timestamptz NOT NULL DEFAULT now(),
  boot_count    integer     NOT NULL DEFAULT 0
);

INSERT INTO app_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
