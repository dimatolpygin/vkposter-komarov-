-- Этап 3: дедуп по теме.
--
-- Дедуп по URL уже держит уникальный индекс на articles.url_norm (этап 1).
-- Здесь добавляется второй контур: один и тот же проект приходит с разных сайтов
-- под разными адресами и разными формулировками заголовка — «Atlas capital: обман
-- и невыплаты брокера» и «atlas-capital-otzyvy». Нормализованное название проекта
-- (topic_key) схлопывает их в одну тему.
--
-- Почему уникальный индекс частичный, а не обычный: дубль по теме мы не выбрасываем,
-- а сохраняем со статусом 'duplicate' — чтобы в панели было видно, что материал найден
-- и почему отклонён. Индекс охраняет только «активные» материалы: среди них тема
-- обязана быть уникальной, и прямой INSERT второго активного материала с той же темой
-- падает на уровне схемы.

-- Статус 'duplicate' — отдельный, а не 'skipped': по нему строится частичный индекс,
-- и в панели причины «дубль темы» и «служебная страница» различаются.
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_status_check;
ALTER TABLE articles ADD CONSTRAINT articles_status_check
  CHECK (status IN ('new', 'fetched', 'skipped', 'duplicate', 'queued', 'used', 'failed'));

-- Название проекта в человекочитаемом виде — для панели; topic_key — машинный ключ.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS topic_name text;

-- Альтернативные ключи той же темы. Заголовок и slug дают разные нормализации
-- («Финоко» из заголовка против «finoko-otzyvy-o-finansovoy-analitike» из адреса).
-- В topic_key лежит основной ключ, в topic_aliases — остальные варианты, и сверка
-- при сохранении идёт по всем сразу: иначе тема с двух сайтов не схлопнется.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS topic_aliases text[] NOT NULL DEFAULT '{}';

-- Чем именно получена тема: hint (подсказка адаптера) / title / slug. Нужно при разборе,
-- почему две статьи про один проект не схлопнулись.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS topic_via text;

-- На какой материал указывает дубль.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS duplicate_of bigint REFERENCES articles (id) ON DELETE SET NULL;

COMMENT ON COLUMN articles.topic_key IS
  'Нормализованное название проекта: транслит кириллицы, без TLD, без слов-шумов, только [a-z0-9].';
COMMENT ON COLUMN articles.topic_aliases IS
  'Прочие варианты ключа той же темы (из заголовка и из slug). Участвуют в сверке на дубль.';

-- Защита на уровне схемы: среди активных материалов тема уникальна.
CREATE UNIQUE INDEX IF NOT EXISTS articles_topic_active_uidx
  ON articles (topic_key)
  WHERE topic_key IS NOT NULL AND status <> 'duplicate';

-- Поиск по альтернативным ключам (пересечение массивов).
CREATE INDEX IF NOT EXISTS articles_topic_aliases_idx ON articles USING gin (topic_aliases);
