-- Порядок чтения дочерних карт, когда lastmod у них одинаковый.
--
-- Пока источников было двенадцать, хватало одного правила: при равных lastmod читать
-- карты с конца, потому что генераторы WordPress нумеруют их от старых к новым (у vklader
-- в post-sitemap.xml архив с 2015 года, в post-sitemap15.xml — сегодняшний день).
--
-- torforex.org нумерует наоборот. Все 25 карт `trader-sitemap*` помечены 17.08.2026, то
-- есть по lastmod они неразличимы, но свежее лежит в НЕнумерованной `trader-sitemap.xml`
-- (адреса 02.07-17.08), а `trader-sitemap25.xml` — это 2024 год. Чтение с конца давало
-- ровно ноль: две пустые карты подряд, выход по правилу «свежее кончилось», источник
-- живой и полностью недоступный.
--
-- Поэтому порядок становится настройкой источника, а не общим правилом:
--   auto    — как раньше: при равных lastmod читаем с конца (поведение по умолчанию,
--             ничего не меняется для уже настроенных сайтов);
--   index   — в порядке индекса, свежее в начале (torforex);
--   reverse — всегда с конца, даже если lastmod различаются.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS sitemap_order text NOT NULL DEFAULT 'auto';

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_sitemap_order_check;
ALTER TABLE sources ADD CONSTRAINT sources_sitemap_order_check
  CHECK (sitemap_order IN ('auto', 'index', 'reverse'));

COMMENT ON COLUMN sources.sitemap_order IS
  'Порядок чтения дочерних карт: auto — с конца при равных lastmod, index — как в индексе, reverse — всегда с конца.';

UPDATE sources
   SET sitemap_order = 'index',
       notes = 'sitemap_index.xml отдаёт 404, рабочий адрес /sitemap.xml (77 карт). '
               'Обзоры в trader-sitemap*, тип trader открыт в WP API. Нумерация карт '
               'обратная: свежее в trader-sitemap.xml, поэтому порядок чтения — index.',
       updated_at = now()
 WHERE code = 'torforex';
