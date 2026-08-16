import * as groups from '../repo/groups.js';
import * as posts from '../repo/posts.js';
import * as runs from '../repo/runs.js';
import * as settings from '../repo/settings.js';
import { slotTimes } from '../lib/schedule.js';
import { log } from '../logger.js';

const logger = log('план');

/**
 * План прогона: какой материал в какую группу и на какое время.
 *
 * Четыре правила, из которых собран этот файл:
 *
 * 1. **Один материал — одна группа.** Пересечений внутри прогона нет: раздача идёт
 *    по кругу из общего списка кандидатов, каждый берётся ровно один раз. Дополнительно
 *    это закрыто уникальным индексом `run_items (run_id, article_id)`.
 * 2. **Сначала очередь источника, внутри неё — от свежих к старым.** Кандидаты (готовые
 *    посты и материалы под генерацию) сливаются в один список и сортируются по
 *    `sources.priority`, затем по дате материала; раздача по кругу сохраняет этот
 *    порядок внутри каждой группы.
 * 3. **Объём задаёт группа.** Квота = `posts_per_day` минус уже опубликованное сегодня.
 * 4. **Время разносится по слотам** внутри окна постинга с джиттером: подряд идущие
 *    посты в одну минуту выглядят как бот.
 */

/**
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number[]} [options.groupIds] ограничить план этими группами (ручной прогон)
 * @param {number} [options.limitPerGroup] жёсткий потолок на группу (проверка, демо)
 * @param {number} [options.stepMinutes] тестовая раскладка слотов: через N минут от «сейчас»,
 *   в обход окна публикаций (настройка `test_slot_step_minutes`)
 */
export async function buildPlan({ now = new Date(), groupIds, limitPerGroup, stepMinutes } = {}) {
  const targets = groupIds?.length ? await groups.findByIds(groupIds) : await groups.listActive();
  const active = targets.filter((group) => group.is_active);

  if (active.length === 0) {
    return { items: [], groups: [], reason: 'Нет включённых групп: включите группу в разделе «Группы»' };
  }

  const quotas = [];
  for (const group of active) {
    const publishedToday = await groups.publishedToday(group.id);
    const cap = limitPerGroup ?? group.posts_per_day;
    quotas.push({
      group,
      publishedToday,
      quota: Math.max(0, Math.min(cap, group.posts_per_day) - publishedToday),
    });
  }

  const capacity = quotas.reduce((sum, item) => sum + item.quota, 0);
  if (capacity === 0) {
    return {
      items: [],
      groups: quotas,
      reason: 'Дневные лимиты всех включённых групп на сегодня исчерпаны',
    };
  }

  // Материалы, занятые другими планами (в том числе незаконченным прогоном), в очередь
  // не берём: иначе один материал уедет в две группы разными прогонами.
  const busy = await runs.plannedArticleIds();
  const ready = await posts.listReadyPosts(capacity, busy);
  const fresh = await posts.listArticlesForGeneration(capacity, [
    ...busy,
    ...ready.map((row) => Number(row.article_id)).filter(Boolean),
  ]);

  const candidates = [
    ...ready.map((row) => ({
      kind: 'post',
      postId: Number(row.id),
      articleId: row.article_id ? Number(row.article_id) : null,
      date: row.article_date,
      label: row.title,
      priority: Number(row.source_priority ?? 100),
      needsImage: !row.image_url,
    })),
    ...fresh.map((row) => ({
      kind: 'article',
      postId: null,
      articleId: Number(row.id),
      date: row.article_date,
      label: row.topic_name ?? row.title ?? row.url,
      priority: Number(row.source_priority ?? 100),
      needsImage: true,
    })),
  ].sort((a, b) => {
    // Готовый пост идёт раньше нового материала, даже если материал свежее. Причина
    // денежная: за текст такого поста уже заплачено, и он ждёт только обложки. Когда
    // сортировка была общей по дате, хвост постов, сделанных неделю назад, оттеснялся
    // сегодняшними темами и мог не опубликоваться никогда — а именно так выглядит
    // очередь после дня, когда на обложки не хватило кредитов.
    if (a.kind !== b.kind) return a.kind === 'post' ? -1 : 1;
    // Очередь источника (`sources.priority`) сильнее даты. Иначе сайт, отодвинутый
    // клиентом в конец, всё равно забирал бы план: он публикует чаще остальных,
    // и его материалы почти всегда свежее.
    if (a.priority !== b.priority) return a.priority - b.priority;
    return dateValue(b.date) - dateValue(a.date);
  });

  // Один материал — один слот. Уникальный индекс `run_items (run_id, article_id)` это
  // гарантирует, но падением всей вставки: 03.08 план не записался целиком и постов за
  // день не вышло вовсе. Причина была в двух готовых постах на один материал (#5 и #6 по
  // merabo, сделаны вручную на этапе проверки) — очередь такого не запрещает. Лишний
  // кандидат отбрасывается здесь, до вставки; оставшийся выигрывает по порядку сортировки.
  const seen = new Set();
  const unique = candidates.filter((item) => {
    if (!item.articleId) return true;
    if (seen.has(item.articleId)) {
      logger.warn(
        { материал: item.articleId, пост: item.postId, тема: item.label },
        `Материал #${item.articleId} уже есть в плане — второй пост по нему пропущен`,
      );
      return false;
    }
    seen.add(item.articleId);
    return true;
  });

  if (unique.length === 0) {
    return {
      items: [],
      groups: quotas,
      capacity,
      shortfall: capacity,
      reason: 'Нет материалов для постинга: проверьте источники в разделе «Источники»',
    };
  }

  // Раздача по кругу: группы получают материалы по очереди, поэтому наборы не пересекаются,
  // а внутри группы порядок остаётся «от свежих к старым».
  const left = quotas.map((item) => ({ ...item, left: item.quota }));
  const assignments = [];
  let cursor = 0;
  while (cursor < unique.length && left.some((item) => item.left > 0)) {
    let placed = false;
    for (const slot of left) {
      if (slot.left === 0 || cursor >= unique.length) continue;
      assignments.push({ group: slot.group, candidate: unique[cursor] });
      cursor += 1;
      slot.left -= 1;
      placed = true;
    }
    if (!placed) break;
  }

  // При расписании «каждые N часов» посты растягиваются максимум до следующего прогона:
  // иначе слоты соседних прогонов лягут друг на друга в одном и том же окне.
  const map = await settings.getMap();
  const testStep = stepMinutes ?? Number.parseInt(map.test_slot_step_minutes ?? '0', 10) ?? 0;
  const maxSpanMinutes = map.schedule_mode === 'interval'
    ? Math.max(1, Number.parseInt(map.schedule_interval_hours ?? '5', 10) || 5) * 60
    : null;

  const times = slotTimes(assignments.length, {
    now,
    windowStart: map.posting_window_start ?? '10:00',
    windowEnd: map.posting_window_end ?? '21:00',
    leadMinutes: Number.parseInt(map.publish_delay_minutes ?? '3', 10) || 3,
    jitterMinutes: Number.parseInt(map.slot_jitter_minutes ?? '7', 10) || 7,
    maxSpanMinutes,
    stepMinutes: testStep > 0 ? testStep : null,
  });

  const items = assignments.map((assignment, index) => ({
    groupId: assignment.group.id,
    groupName: assignment.group.name,
    slotNo: index + 1,
    articleId: assignment.candidate.articleId,
    postId: assignment.candidate.postId,
    postAt: times[index],
    label: assignment.candidate.label,
    kind: assignment.candidate.kind,
    date: assignment.candidate.date,
  }));

  logger.info(
    { слотов: items.length, групп: active.length, ёмкость: capacity, кандидатов: unique.length },
    `План прогона: ${items.length} постов на ${active.length} групп ` +
      `(ёмкость ${capacity}, кандидатов ${unique.length})`,
  );

  return {
    items,
    groups: quotas,
    capacity,
    // Нехватка — сигнал для добора (`services/backfill.js`): очередь пуста не потому,
    // что группы заполнены, а потому что материалов в базе меньше, чем нужно плану.
    shortfall: Math.max(0, capacity - items.length),
    stepMinutes: testStep > 0 ? testStep : null,
    reason: items.length < capacity
      ? `Материалов меньше плана: ${items.length} из ${capacity}`
      : null,
  };
}

function dateValue(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
