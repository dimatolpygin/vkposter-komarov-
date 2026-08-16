-- Этап 13: материал для поста собирается поиском, когда своей статьи нет.
--
-- Зачем колонки, а не «просто положить текст в content»: собранный материал и
-- статья источника — разные вещи по доверию. Статью мы рерайтим, а найденное в сети
-- склеено из чужих страниц, и клиенту в панели надо видеть, откуда это взялось,
-- чтобы проверить пост. Плюс без пометки нельзя отличить «текст не удалось извлечь»
-- от «текста и не было, взяли из поиска».

ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_via    text;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS research_urls  text[] NOT NULL DEFAULT '{}';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS research_at    timestamptz;

COMMENT ON COLUMN articles.content_via IS
  'Откуда взялся content: source - страница источника, search - собран поиском firecrawl';

-- Уже накопленные материалы получают честную пометку происхождения: их текст
-- (там, где он есть) извлечён со страницы источника.
UPDATE articles SET content_via = 'source'
 WHERE content IS NOT NULL AND length(content) > 200 AND content_via IS NULL;

-- Режим по умолчанию — «только когда своего текста нет». Это ровно тот случай,
-- ради которого этап и делается (scama.net и all-comment отдают одни названия),
-- и при нём расход лимита firecrawl предсказуем: поиск идёт не на каждый пост.
--
-- Запрос шаблоном, а не константой: подбор формулировки меняет качество выдачи
-- сильнее любого кода, и клиент должен править её сам, без деплоя.
INSERT INTO settings (key, value, title) VALUES
  ('research_mode', 'missing',
   'Сбор материала поиском: off - выключен, missing - только для тем без текста, always - всегда'),
  ('research_results', '3',
   'Сколько страниц брать из поиска на один материал (расход лимита firecrawl)'),
  ('research_query', '"{{проект}}" отзывы обман вывод денег',
   'Шаблон поискового запроса; {{проект}} подставляется названием темы'),
  ('research_chars_per_page', '3000',
   'Сколько символов брать с одной найденной страницы')
ON CONFLICT (key) DO NOTHING;
