-- Этап 2. Разведка реальных источников дала три поправки к сиду этапа 1.
--
-- 1. У всех пяти WordPress-источников открыт WP REST API (/wp-json/wp/v2/posts) и он
--    отдаёт полный текст статьи, заголовок и дату — бесплатно и без firecrawl.
--    Добавляем режим доступа 'wp_api'. Лимит firecrawl (1000/мес) остаётся целиком
--    на scama.net — единственный источник, закрытый от прямых запросов (403).
--
-- 2. У cryptorussia свежесть распределена НЕ так, как считалось на пресейле: сейчас
--    свежее лежит и в post-sitemap.xml (2026-07-23), и в services-sitemap.xml
--    (2026-07-24), а архив 2024 года — в нумерованных файлах обоих типов. Поэтому
--    паттерн становится списком, а свежесть определяется по lastmod из индекса,
--    а не по имени файла.
--
-- 3. vklader.com отдаёт 301 с /sitemap_index.xml на /sitemap.xml — прописываем
--    конечный адрес, чтобы не гонять лишний редирект.

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_fetch_via_check;
ALTER TABLE sources ADD CONSTRAINT sources_fetch_via_check
  CHECK (fetch_via IN ('direct', 'firecrawl', 'wp_api'));

COMMENT ON COLUMN sources.sitemap_pattern IS
  'Список допустимых типов sitemap через запятую. Свежесть определяется по lastmod из индекса.';

-- Пять WP-источников переводим на wp_api
UPDATE sources SET fetch_via = 'wp_api', updated_at = now()
 WHERE code IN ('vklader', 'offbez', 'kaper', 'cryptorussia', 'all-comment');

UPDATE sources
   SET sitemap_url = 'https://vklader.com/sitemap.xml', updated_at = now()
 WHERE code = 'vklader';

UPDATE sources
   SET sitemap_url = 'https://www.kaper.pro/sitemap.xml',
       sitemap_pattern = 'post-sitemap,complaints-sitemap',
       notes = 'Типовой WP. sitemap_index.xml отдаёт 404, рабочий адрес — /sitemap.xml. '
               'Кроме post-sitemap есть complaints-sitemap — тоже подключён.',
       updated_at = now()
 WHERE code = 'kaper';

UPDATE sources
   SET sitemap_pattern = 'post-sitemap,services-sitemap',
       notes = 'Свежее лежит и в post-sitemap.xml, и в services-sitemap.xml; архив 2024 — '
               'в нумерованных файлах обоих типов. Нужный файл выбирается по lastmod из индекса.',
       updated_at = now()
 WHERE code = 'cryptorussia';

UPDATE sources
   SET notes = 'sitemap отдаёт пустой ответ, но открыт WP REST API — обнаружение идёт через '
               '/wp-json/wp/v2/posts. Текста в статьях мало, поэтому режим "только тема".',
       updated_at = now()
 WHERE code = 'all-comment';

UPDATE sources
   SET notes = 'Темы берём из таблицы заявок на scama.net/check: домен + дата + вердикт. '
               'Прямой запрос отдаёт 403, поэтому единственный источник на firecrawl.',
       updated_at = now()
 WHERE code = 'scama';

-- Лимиты разведки: сколько материалов забираем за одну проверку и сколько текстов
-- вытягиваем в тот же проход.
INSERT INTO settings (key, value, title)
VALUES
  ('discovery_limit_per_source', '50', 'Максимум материалов за одну проверку источника'),
  ('extract_limit_per_check',    '10', 'Максимум извлечений текста за одну проверку')
ON CONFLICT (key) DO NOTHING;
