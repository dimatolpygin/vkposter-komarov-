-- Новые источники второго клиента и порядок очереди.
--
-- Клиент просил: новые сайты — главные, старые вторичные. В `sources.priority` меньше
-- число значит раньше очередь (10 первым, 100 обычная, 900 последним), поэтому новым
-- ставим 10, старые остаются на 100. `cryptorussia` как была 900, так и остаётся —
-- её материалы берутся, только когда у остальных свежего не осталось.
--
-- Оба сайта отдают карту сайта, поэтому своего кода им не нужно, хватает строки в БД.
--
-- bookmaker-ratings.ru — WordPress. Обзоры букмекеров лежат в отдельной карте
-- `bookreviews-sitemap.xml` (511 адресов вида /review/...), поэтому фильтр по имени
-- карты обязателен: без него обход соберёт новости спорта и справочник, а не обзоры.
-- Тексты идут через firecrawl: тип `bookreviews` в WP REST API НЕ опубликован
-- (`/wp-json/wp/v2/types` знает только posts, pages, media, blocks), и WP-путь тут
-- бесполезен — это была бы пустая трата запроса перед откатом на firecrawl.
--
-- zarabota.com — Blogger, а не WordPress. Карта — индекс из страниц `sitemap.xml?page=N`,
-- имён-паттернов там нет вовсе, поэтому `sitemap_pattern` пустой: любой фильтр отсёк бы
-- всё. Свежее лежит на первой странице (800 адресов), на второй всего пять.

INSERT INTO sources (code, title, base_url, discovery, sitemap_url, sitemap_pattern,
                     content_mode, fetch_via, priority, is_active, notes)
VALUES
  ('bookmaker-ratings',
   'Bookmaker Ratings — обзоры букмекеров',
   'https://bookmaker-ratings.ru',
   'sitemap',
   'https://bookmaker-ratings.ru/sitemap_index.xml',
   'bookreviews-sitemap',
   'text',
   'firecrawl',
   10,
   true,
   'Обзоры букмекеров. Кастомный тип bookreviews закрыт в WP REST API — тексты только через firecrawl.'),
  ('zarabota',
   'Zarabota.com — обзоры схем заработка',
   'https://www.zarabota.com',
   'sitemap',
   'https://www.zarabota.com/sitemap.xml',
   NULL,
   'text',
   'firecrawl',
   10,
   true,
   'Blogger. Карта сайта — индекс sitemap.xml?page=N без имён-паттернов, фильтр по имени карты не применять.')
ON CONFLICT (code) DO NOTHING;

-- vklader закрыт по IP для сервера в Амстердаме: 403 и на карту сайта, и на главную,
-- с любым User-Agent (с российского адреса тот же запрос отдаёт 200). У первого клиента
-- сервер стоял в другой сети, поэтому проблема появилась только при переносе.
-- Прямой путь и WP REST API тут одинаково бесполезны — оба идут с адреса сервера.
-- Через firecrawl сайт открывается: карта сайта приходит целиком.
UPDATE sources
   SET fetch_via = 'firecrawl',
       notes = 'Сайт отдаёт 403 на IP сервера — и карта сайта, и тексты идут через firecrawl.',
       updated_at = now()
 WHERE code = 'vklader';
