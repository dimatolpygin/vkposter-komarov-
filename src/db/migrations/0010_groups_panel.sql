-- Этап 7: раздел «Группы» в панели.
-- Таблица groups создана на этапе 1, синхронизация из postmypost — на этапе 6.
-- Здесь то, чего не хватает для управления группами руками клиента.

-- Мягкое удаление. Критерий этапа: «удаление группы из панели не ломает историю
-- публикаций по ней». Физическое удаление строки историю уносит (publications.group_id
-- ссылается на groups), поэтому «удалить» в панели = убрать из списка и из постинга,
-- строку и её публикации сохранить.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Страховка на уровне схемы: раньше FK стоял с ON DELETE CASCADE, то есть один
-- случайный DELETE по groups тихо уносил историю публикаций. Теперь база не даст
-- удалить группу, по которой что-то публиковалось, — только мягко скрыть.
ALTER TABLE publications DROP CONSTRAINT IF EXISTS publications_group_id_fkey;
ALTER TABLE publications
  ADD CONSTRAINT publications_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES groups (id) ON DELETE RESTRICT;

-- Список групп всегда фильтруется по «не удалена», индекс под это.
CREATE INDEX IF NOT EXISTS groups_visible_idx ON groups (deleted_at, name);
