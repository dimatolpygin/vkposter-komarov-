-- Этап 8. Девять сайтов, присланных клиентом 17 августа.
--
-- Все девять проверены запросами С САМОГО СЕРВЕРА (17.08.2026, 18:55 МСК): IP имеет
-- значение — vklader в своё время отдавал 403 именно с адреса сервера, а с российского
-- 200. Проверялись три вещи: отдаёт ли сайт карту, в какой дочерней карте лежит свежее
-- (по lastmod, а не по имени файла), и открыт ли WP REST API на НУЖНЫЙ тип записи.
-- Последнее — про деньги: где API открыт, текст приходит бесплатно, иначе за каждый
-- материал списывается кредит firecrawl.
--
-- Разведка на пресейле разошлась с фактом в четырёх местах, поэтому здесь записано
-- измеренное, а не ожидавшееся:
--
-- 1. coinmania — обзоры лежат НЕ в `exchanges-sitemap` (такой карты нет вовсе), а в
--    `trejdery-sitemap*`: 08.17 свежие, url вида /trejdery/<имя>-otzyvy/. Тип
--    `trejdery` в WP API ОТКРЫТ, поэтому источник идёт через wp_api. В `post-sitemap`
--    у них новости крипты (последнее 03.07) — не отзывы, не берём.
-- 2. torforex — `sitemap_index.xml` отдаёт 404, рабочий адрес /sitemap.xml (77 карт);
--    robots.txt при этом указывает на другой домен, torforex.ru. Обзоры — в
--    `trader-sitemap*`, тип `trader` в WP API открыт, свежее 17.08.
-- 3. kapp1 — свежее в `post-sitemap` (17.08), но это справочник и правила спорта
--    (/rule-hokkey-ofsajd/, /article-manual-...), а не отзывы. Отзывы у них в
--    /zhaloby/ — карта `template_zhaloby-sitemap`, но она стоит с 04.09.2025 и тип
--    в WP API НЕ опубликован (там только posts и pages). Поэтому берём жалобы через
--    firecrawl и ставим очередь позади остальных: материал не свежий.
-- 5. scammer — карты и содержимое живут отдельными жизнями: в индексе `complaint-sitemap`
--    помечена 13.08, а внутри у неё материалы 2024 года; свежее лежит в нумерованных
--    `complaint-sitemap3` (13.08.2026) и `capper-sitemap6` (30.06.2026). Единственная
--    по-настоящему свежая обычная карта, `post-sitemap`, содержит 67 заглушек вида
--    /stati/x-14/ — заголовок «x», текст 31 символ. Её не берём: обход тратил бы на них
--    очередь, а генератор писал бы посты по пустоте.
-- 6. capper-expert.ru не открывается с машины разработчика (fetch failed), но с сервера
--    отдаёт 200 — проверять его нужно на проде.
-- 4. easilytrading.ru НЕ подключается: сайт отвечает 307 с / на / — редирект в кольцо,
--    карты нет (404). robots.txt при этом живой, то есть сервер работает, а сайт закрыт.
--    Вопрос клиенту: адрес верный или проект закрылся.
--
-- Тип записи (`wp_post_types`) для WP-источников заполнен по факту, а не по умолчанию:
-- поиск текста идёт запросом `/wp-json/wp/v2/<тип>?slug=...`, и со значением по умолчанию
-- `posts` записи кастомного типа не находятся вовсе. Проверено на coinmania: адрес из
-- карты есть, а `posts?slug=merit-otzyvy` отдаёт пустой массив — текст ушёл бы на
-- firecrawl, то есть за деньги, при открытом бесплатном API. Типы взяты из
-- `/wp-json/wp/v2/types` каждого сайта (поле rest_base).
--
-- 7. scammer идёт в режиме `topic_only`, а не `text`. Замер шести жалоб через открытый
--    WP API: 274, 8, 36, 277, 187, 244 символа — это не статьи, а строчки-обращения
--    пользователей. Порог осмысленного текста в системе 800 символов, и правильный
--    ответ здесь не «доставать текст лучше», а «текста нет»: у сайта берётся название
--    проекта, пост пишется по теме. Заодно источник не тратит ни одного запроса за текст.
--    Для сравнения, там где рерайт имеет смысл: coinmania 2330-15776 символов,
--    torforex 3161-6177.
-- 8. kapp1 вставляется ВЫКЛЮЧЕННЫМ. Проверка обхода дала ноль адресов, и это не сбой:
--    его карта отзывов помечена 04.09.2025, окно свежести (30 дней) отсекает её ещё на
--    уровне выбора дочерних карт. Включать источник, который в обычном прогоне всегда
--    возвращает пустоту, значит держать в панели вечно «проверен, найдено 0». Его
--    материал берётся адресно — через «Добор старых тем» с периодом.
-- Очередь (`priority`): у настроенных ранее источников клиента стоит 10, они главные.
-- Новым ставим 100 — обычная очередь, чтобы девять сайтов сразу не оттеснили те два,
-- по которым клиент уже принял материал. Двум сайтам с несвежим материалом
-- (capper-expert, kapp1) ставим 200: их темы берутся, когда у остальных свежее кончилось.

INSERT INTO sources (code, title, base_url, discovery, sitemap_url, sitemap_pattern,
                     content_mode, fetch_via, wp_post_types, priority, is_active, notes)
VALUES
  ('coinmania',
   'Coinmania — обзоры трейдеров и сервисов',
   'https://coinmania.com',
   'sitemap',
   'https://coinmania.com/sitemap_index.xml',
   'trejdery-sitemap',
   'text',
   'wp_api',
   'trejdery',
   100,
   true,
   'Обзоры в trejdery-sitemap (свежее 17.08). Тип trejdery открыт в WP REST API — текст бесплатно. post-sitemap не брать: там новости крипты.'),
  ('torforex',
   'TorForex — обзоры брокеров и трейдеров',
   'https://torforex.org',
   'sitemap',
   'https://torforex.org/sitemap.xml',
   'trader-sitemap',
   'text',
   'wp_api',
   'trader,site-review,posts',
   100,
   true,
   'sitemap_index.xml отдаёт 404, рабочий адрес /sitemap.xml (77 карт). Обзоры в trader-sitemap*, тип trader открыт в WP API. robots.txt указывает на torforex.ru — другой домен.'),
  ('scammer',
   'Scammer.ru — капперы, жалобы, проекты',
   'https://scammer.ru',
   'sitemap',
   'https://scammer.ru/sitemap_index.xml',
   'complaint-sitemap,capper-sitemap,project-sitemap',
   'topic_only',
   'wp_api',
   'posts,complaint,capper,project',
   100,
   true,
   'Свежее в нумерованных картах: complaint-sitemap3 (13.08), capper-sitemap6 (30.06). post-sitemap НЕ берём: там 67 заглушек вида /stati/x-14/ на 31 символ. Режим topic_only: жалобы у них по 8-277 символов, рерайтить нечего — ИИ пишет по названию проекта.'),
  ('vsyapravda',
   'Вся Правда — справочник финансовых организаций',
   'https://vsyapravda.net',
   'sitemap',
   'https://vsyapravda.net/sitemap.xml',
   NULL,
   'text',
   'firecrawl',
   'posts',
   100,
   true,
   'Плоский urlset без индекса, фильтр по имени карты не применять. WP API нет (404) — тексты только через firecrawl. Карточки /directories/finance/brokers/*, свежее 14.08.'),
  ('backfund',
   'BackFund — разборы проектов и профили',
   'https://backfund.info',
   'sitemap',
   'https://backfund.info/sitemap.xml',
   NULL,
   'text',
   'firecrawl',
   'posts',
   100,
   true,
   'Плоский urlset, фильтра нет. WP API 404 — только firecrawl. Разборы в /blog/post/*, профили в /profile/*, свежее 17.08.'),
  ('trustorg',
   'TrustOrg — отзывы о сайтах и статьи',
   'https://trustorg.com',
   'sitemap',
   'https://trustorg.com/sitemap.xml',
   'sites_,articles_',
   'text',
   'firecrawl',
   'posts',
   100,
   true,
   'Индекс из 24 карт по пути /sitemaps/. Берём sites_ (24960 карточек сайтов) и articles_ (252 статьи, /article/19); socials_ не берём. WP API нет — тексты через firecrawl. Карточки шаблонные, качество текста проверить на первом посте.'),
  ('capper-expert',
   'Capper Expert — обзоры капперов',
   'https://capper-expert.ru',
   'sitemap',
   'https://capper-expert.ru/sitemap_index.xml',
   'post-sitemap',
   'text',
   'wp_api',
   'posts',
   200,
   true,
   'WP API открыт, но материал не свежий: карта стоит с 01.07.2026, последняя запись 25.06. Очередь позади остальных.'),
  ('kapp1',
   'Kapp1 — жалобы на букмекеров и капперов',
   'https://kapp1.ru',
   'sitemap',
   'https://kapp1.ru/sitemap_index.xml',
   'template_zhaloby-sitemap',
   'text',
   'firecrawl',
   'posts',
   200,
   false,
   'ВЫКЛЮЧЕН: свежего нет. Отзывы только в /zhaloby/ (карта template_zhaloby-sitemap стоит с 04.09.2025), обычный обход по окну свежести даёт ноль адресов. Материал доступен через «Добор старых тем» с указанным периодом. post-sitemap свежий, но там правила спорта и справочник, не отзывы.')
ON CONFLICT (code) DO NOTHING;
