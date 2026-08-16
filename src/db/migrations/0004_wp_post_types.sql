-- Этап 2, поправка по результатам прогона.
--
-- Проблема: у cryptorussia свежие материалы лежат в кастомном типе записей `services`,
-- а не в `post`. Запрос /wp-json/wp/v2/posts?slug=... их не находил, извлечение уходило
-- на firecrawl и получало 255 символов вместо 4261 — то есть тратило лимит и отдавало
-- худший результат. Тип `services` открыт в REST (rest_base=services), поэтому достаточно
-- перечислить допустимые типы записей у источника.
--
-- Вторая поправка: lastmod из sitemap не равен дате публикации. У cryptorussia массовое
-- пересохранение записей подняло lastmod у сотен архивных статей. Настоящую дату отдаёт
-- WP API (date_gmt) — сохраняем её отдельно и опираемся на неё при сортировке
-- «от свежих к старым», а lastmod оставляем как оценку для источников без API.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS wp_post_types text NOT NULL DEFAULT 'posts';

COMMENT ON COLUMN sources.wp_post_types IS
  'Список rest_base типов записей WP через запятую, в порядке приоритета при поиске по slug.';

UPDATE sources SET wp_post_types = 'posts,services', updated_at = now()
 WHERE code = 'cryptorussia';

ALTER TABLE articles ADD COLUMN IF NOT EXISTS published_at timestamptz;

COMMENT ON COLUMN articles.published_at IS
  'Реальная дата публикации из WP API. Приоритетнее lastmod при сортировке от свежих к старым.';

CREATE INDEX IF NOT EXISTS articles_published_idx
  ON articles (COALESCE(published_at, lastmod) DESC NULLS LAST);
