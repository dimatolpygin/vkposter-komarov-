-- Этап 1: прикладная схема проекта.
-- Восемь таблиц: sources, articles, posts, publications, groups, settings, runs, users.
-- Служебные (schema_migrations, app_meta) созданы на этапе 0.

-- ─────────────────────────────────────────────────────────────────────────────
-- Источники материалов. Каждый сайт настраивается индивидуально: у одних свежее
-- лежит в post-sitemap, у других в services-sitemap, а часть доступна только
-- через firecrawl (прямой запрос отдаёт 403).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id              serial      PRIMARY KEY,
  code            text        NOT NULL UNIQUE,
  title           text        NOT NULL,
  base_url        text        NOT NULL,
  -- sitemap — читаем карту сайта (основной способ); custom — свой адаптер под структуру
  discovery       text        NOT NULL DEFAULT 'sitemap' CHECK (discovery IN ('sitemap', 'custom')),
  sitemap_url     text,
  -- какой именно тип sitemap несёт свежее: post-sitemap / services-sitemap / complaints-sitemap
  sitemap_pattern text,
  -- text — рерайтим исходную статью; topic_only — текста нет, ИИ пишет по теме сам
  content_mode    text        NOT NULL DEFAULT 'text' CHECK (content_mode IN ('text', 'topic_only')),
  -- direct — обычный fetch; firecrawl — только через firecrawl (обход 403/защиты)
  fetch_via       text        NOT NULL DEFAULT 'firecrawl' CHECK (fetch_via IN ('direct', 'firecrawl')),
  is_active       boolean     NOT NULL DEFAULT true,
  notes           text,
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Найденные материалы. url_norm — нормализованный URL (без utm, www, слеша),
-- по нему дедуп. topic_key — нормализованное название проекта, дедуп по теме (этап 3).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
  id                 bigserial   PRIMARY KEY,
  source_id          integer     NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  url                text        NOT NULL,
  url_norm           text        NOT NULL UNIQUE,
  title              text,
  topic_key          text,
  lastmod            timestamptz,
  discovered_at      timestamptz NOT NULL DEFAULT now(),
  content            text,
  content_fetched_at timestamptz,
  status             text        NOT NULL DEFAULT 'new'
                                 CHECK (status IN ('new', 'fetched', 'skipped', 'queued', 'used', 'failed')),
  skip_reason        text
);

CREATE INDEX IF NOT EXISTS articles_topic_key_idx ON articles (topic_key);
CREATE INDEX IF NOT EXISTS articles_lastmod_idx   ON articles (lastmod DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS articles_status_idx    ON articles (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Группы ВК. Привязываются в postmypost, оттуда же тянем id и название —
-- клиент не должен вводить числовые id руками.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
  id                serial      PRIMARY KEY,
  pmp_account_id    bigint      NOT NULL UNIQUE,
  name              text        NOT NULL,
  login             text,
  -- id сообщества на стороне ВК (со знаком минус)
  external_id       text,
  posts_per_day     integer     NOT NULL DEFAULT 10 CHECK (posts_per_day BETWEEN 0 AND 100),
  is_active         boolean     NOT NULL DEFAULT false,
  connection_status integer,
  synced_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Сгенерированные посты.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id               bigserial   PRIMARY KEY,
  article_id       bigint      REFERENCES articles (id) ON DELETE SET NULL,
  title            text        NOT NULL,
  body             text        NOT NULL,
  char_count       integer     NOT NULL DEFAULT 0,
  -- публичный URL обложки (наш домен) и путь на диске
  image_url        text,
  image_path       text,
  model            text,
  prompt_version   integer,
  status           text        NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'ready', 'published', 'failed')),
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_status_idx ON posts (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Факт публикации. Один пост в одну группу — не более одного раза.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS publications (
  id                 bigserial   PRIMARY KEY,
  post_id            bigint      NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  group_id           integer     NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  pmp_publication_id bigint,
  pmp_file_id        bigint,
  post_at            timestamptz,
  -- код статуса publication_status из postmypost (4 черновик, 5 в очередь, 1 опубликована…)
  pmp_status         integer,
  vk_url             text,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, group_id)
);

CREATE INDEX IF NOT EXISTS publications_group_idx ON publications (group_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Настройки: окно свежести, расписание, промты, лимиты. Плоский key/value,
-- значение — текст (числа и JSON приводятся в коде).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key         text        PRIMARY KEY,
  value       text        NOT NULL,
  title       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Прогоны: cron, ручной запуск, наполнение из архива, проверка источника.
-- request_id связывает запись с логами контейнера (этап 11).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id          bigserial   PRIMARY KEY,
  request_id  text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('cron', 'manual', 'backfill', 'source_check')),
  status      text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  found       integer     NOT NULL DEFAULT 0,
  generated   integer     NOT NULL DEFAULT 0,
  published   integer     NOT NULL DEFAULT 0,
  error       text,
  meta        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Пользователи панели. По решению на бутстрапе — один аккаунт (админ = клиент).
-- password_changed_at служит признаком инвалидации сессий: cookie, выданная
-- раньше этой отметки, считается недействительной.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  serial      PRIMARY KEY,
  login               text        NOT NULL UNIQUE,
  password_hash       text        NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Сид источников из брифа. Идемпотентно: повторный прогон ничего не меняет.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO sources (code, title, base_url, discovery, sitemap_url, sitemap_pattern, content_mode, fetch_via, is_active, notes)
VALUES
  ('vklader', 'vklader.com', 'https://vklader.com', 'sitemap',
   'https://vklader.com/sitemap_index.xml', 'post-sitemap', 'text', 'firecrawl', true,
   'Основной донор объёма: 10-15 статей в день. Последний номер post-sitemap — свежак.'),

  ('offbez', 'offbez.com', 'https://offbez.com', 'sitemap',
   'https://offbez.com/sitemap_index.xml', 'post-sitemap', 'text', 'firecrawl', true,
   'Типовой WordPress, активный. Второй по объёму после vklader.'),

  ('kaper', 'kaper.pro', 'https://www.kaper.pro', 'sitemap',
   'https://www.kaper.pro/sitemap_index.xml', 'post-sitemap', 'text', 'firecrawl', true,
   'Типовой WP, защиты нет. Есть также complaints-sitemap — можно подключить как второй пул.'),

  ('cryptorussia', 'cryptorussia.ru', 'https://cryptorussia.ru', 'sitemap',
   'https://cryptorussia.ru/sitemap_index.xml', 'services-sitemap', 'text', 'firecrawl', true,
   'Свежее лежит НЕ в post-sitemap (там архив 2024), а в services-sitemap. Проверять именно его.'),

  ('all-comment', 'all-comment.com', 'https://all-comment.com', 'custom',
   NULL, NULL, 'topic_only', 'firecrawl', true,
   'sitemap.xml отдаёт 404, структура нестандартная. Текста мало — работает в режиме "ИИ пишет по теме сам".'),

  ('scama', 'scama.net', 'https://scama.net', 'custom',
   NULL, NULL, 'topic_only', 'firecrawl', true,
   'Темы берём с scama.net/check. Прямой запрос отдаёт 403 Forbidden, через firecrawl доступен без проблем.')
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Сид настроек. Значения по умолчанию — из брифа (10 постов на группу в день).
-- Промты сидятся отдельно на старте приложения (нужен файл с диска).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO settings (key, value, title)
VALUES
  ('freshness_window_days', '30',        'Окно свежести материалов, дней'),
  ('default_posts_per_day', '10',        'Постов в день на группу по умолчанию'),
  ('schedule_mode',         'daily',     'Режим расписания: daily или interval'),
  ('schedule_interval_hours', '5',       'Интервал запуска при режиме interval, часов'),
  ('schedule_daily_at',     '10:00',     'Время ежедневного запуска, МСК'),
  ('publish_mode',          'draft',     'Режим публикации: draft (черновик) или live (реальная публикация)'),
  ('post_min_chars',        '1200',      'Минимальная длина поста, символов'),
  ('post_max_chars',        '2200',      'Максимальная длина поста, символов'),
  ('backfill_enabled',      'false',     'Идёт наполнение из архива')
ON CONFLICT (key) DO NOTHING;
