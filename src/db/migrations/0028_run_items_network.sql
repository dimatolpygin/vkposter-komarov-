-- Этап 7: одна тема уходит и в ВК, и в ОК.
--
-- До этого правило было «один материал — одна группа на весь прогон», и оно держалось
-- уникальным индексом run_items (run_id, article_id). Клиенту нужно другое: тема должна
-- попасть один раз в какую-то группу ВК и один раз в какую-то группу ОК, чтобы в поиске
-- нашлись обе площадки, но статья при этом была одна — один текст, одна обложка, две
-- публикации.
--
-- Поэтому уникальность становится «материал + сеть»: внутри одной сети пересечений
-- по-прежнему нет (два поста одной темы в двух группах ВК — это дубль на поиске),
-- между сетями пересечение разрешено ровно одно.
--
-- Сеть слота хранится в самой строке, а не берётся джойном по группе: индекс должен
-- работать без обращения к groups, и историю прогона не должно переписывать позднее
-- изменение группы.

ALTER TABLE run_items ADD COLUMN IF NOT EXISTS chanel_id smallint;

UPDATE run_items i
   SET chanel_id = g.chanel_id
  FROM groups g
 WHERE g.id = i.group_id AND i.chanel_id IS NULL;

-- Группы уже нет (жёсткое удаление до этапа 10) — считаем ВК: до появления ОК других
-- сетей в системе не было.
UPDATE run_items SET chanel_id = 2 WHERE chanel_id IS NULL;

ALTER TABLE run_items ALTER COLUMN chanel_id SET NOT NULL;
ALTER TABLE run_items ALTER COLUMN chanel_id SET DEFAULT 2;

DROP INDEX IF EXISTS run_items_run_article_uidx;
DROP INDEX IF EXISTS run_items_run_post_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS run_items_run_article_net_uidx
  ON run_items (run_id, article_id, chanel_id) WHERE article_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS run_items_run_post_net_uidx
  ON run_items (run_id, post_id, chanel_id) WHERE post_id IS NOT NULL;

-- Выключатель на случай, если клиент передумает: без зеркалирования система работает
-- как раньше — каждая группа получает свои темы, пересечений нет вообще.
INSERT INTO settings (key, value, title) VALUES
  ('mirror_networks', '1', 'Одна тема идёт и в ВК, и в ОК (1 — да, 0 — у каждой группы свои темы)')
ON CONFLICT (key) DO NOTHING;
