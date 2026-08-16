-- Заглушки антибота, попавшие в базу как текст статьи.
--
-- vklader закрыт DDoS-Guard. После того как сайт заблокировал адрес сервера, firecrawl
-- вернул страницу «Checking your browser before accessing vklader.com» на 251 символ,
-- а проверка «текста больше 200 символов» её пропустила. Материал получил этот текст,
-- и пост про проект был написан по нему.
--
-- Код теперь такие страницы распознаёт и не сохраняет (см. services/check-source.js),
-- а здесь чистятся те, что уже успели осесть: текст сбрасывается, материал возвращается
-- в очередь на извлечение. Сама тема не теряется, статья будет перечитана при следующей
-- проверке источника.

UPDATE articles
   SET content = NULL,
       content_via = NULL,
       content_fetched_at = NULL,
       status = 'new'
 WHERE content IS NOT NULL
   AND length(content) < 1500
   AND (
     lower(content) LIKE '%checking your browser%'
     OR lower(content) LIKE '%ddos-guard%'
     OR lower(content) LIKE '%just a moment%'
     OR lower(content) LIKE '%cf-browser-verification%'
   );
