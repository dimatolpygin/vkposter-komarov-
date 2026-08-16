import { withAdvisoryLock, query } from '../db/pool.js';
import * as archive from '../repo/archive.js';
import * as groups from '../repo/groups.js';
import * as posts from '../repo/posts.js';
import * as runs from '../repo/runs.js';
import * as settings from '../repo/settings.js';
import { slotTimes, parseHhMm } from '../lib/schedule.js';
import { checkSource } from './check-source.js';
import { generatePost } from './generate-post.js';
import { generateImageForPost } from './generate-image.js';
import { publishPost, usingLocalPmpStub } from './publish-post.js';
import { captureError } from './capture-error.js';
import { publicBaseReachable } from '../lib/media.js';
import { runWithContext, newRequestId, getRequestId } from '../context.js';
import { log, errFields } from '../logger.js';

const logger = log('архив');

/**
 * Разовое наполнение из архива.
 *
 * Зачем оно есть: новая группа не должна выглядеть пустой. Клиент задаёт период и лимит,
 * система забирает из выбранных источников материалы за этот период и раскладывает их
 * по дням — так стена наполняется постепенно, а не сотней постов за час.
 *
 * Четыре решения, определившие этот файл:
 *
 * 1. **Задание — строка в БД, а не объект в памяти.** Кнопка «Остановить» ставит статус
 *    `stopping`, исполнитель читает его перед каждым слотом. Поэтому остановка работает
 *    и после рестарта контейнера, и в другом процессе, и прогресс виден в панели без
 *    обращения к процессу, который задание запустил.
 * 2. **План лежит в `run_items`, как у обычного прогона.** Даром достаётся всё разом:
 *    продолжение после перезапуска, защита от повторной публикации одного материала
 *    (уникальный индекс), и главное — обычный прогон не возьмёт занятые материалы,
 *    потому что смотрит в ту же таблицу.
 * 3. **Дедуп не свой.** Кандидаты берутся общей выборкой (`listArchiveCandidates`):
 *    материал с уже написанным постом и опубликованный пост туда не попадают.
 * 4. **Растягивание по дням — через `post_at`.** Публикации создаются сейчас, но встают
 *    в postmypost на будущие даты. Дневной лимит группы при этом считается на день слота
 *    (см. `groups.publishedOn`), иначе задание упёрлось бы в лимит первого же дня.
 */

/** Свой замок: наполнение и обычный прогон не мешают друг другу, но два наполнения — да. */
const ARCHIVE_LOCK_KEY = 815_240_802;

/** Потолок раскладки. 90 дней — это уже «клиент задал лимит, который группам не съесть». */
const MAX_DAYS = 90;

/** Идёт ли задание прямо сейчас в этом процессе (для панели). */
let current = null;

export function archiveRunningSince() {
  return current ? new Date(current.startedAt) : null;
}

/**
 * Поставить задание в очередь и уйти в фон.
 *
 * @param {object} input
 * @param {number[]} input.sourceIds выбранные источники
 * @param {number[]} input.groupIds группы, куда раскладывать
 * @param {string} input.from дата «с», YYYY-MM-DD
 * @param {string} input.to дата «по», YYYY-MM-DD
 * @param {number} input.limitTotal сколько постов сделать всего
 * @param {number} input.perDay сколько постов в день на группу
 * @param {string} [input.createdBy] логин из панели — для истории
 */
export async function startArchiveFill({
  sourceIds, groupIds, from, to, limitTotal, perDay, createdBy,
}) {
  if (!sourceIds?.length) throw new Error('Выберите хотя бы один источник');
  if (!groupIds?.length) throw new Error('Выберите хотя бы одну группу');
  if (!from || !to) throw new Error('Задайте период: даты «с» и «по»');
  if (new Date(from) > new Date(to)) throw new Error('Дата «с» позже даты «по»');
  if (!(limitTotal > 0)) throw new Error('Лимит постов должен быть больше нуля');
  if (!(perDay > 0)) throw new Error('Постов в день должно быть больше нуля');

  const active = await archive.findActive();
  if (active) {
    throw new Error(
      `Наполнение уже идёт (задание #${active.id}). Дождитесь окончания или остановите его.`,
    );
  }

  // Дешёвая проверка до первой траты: postmypost скачивает картинку сам, и с локальным
  // PUBLIC_BASE_URL ни один слот не уедет — незачем генерировать сотню постов впустую.
  const reachable = publicBaseReachable();
  if (!reachable.ok && !usingLocalPmpStub()) throw new Error(reachable.hint);

  const targets = (await groups.findByIds(groupIds)).filter((group) => group.is_active);
  if (targets.length === 0) {
    throw new Error('Среди выбранных групп нет включённых — включите группу в разделе «Группы»');
  }

  const job = await archive.create({
    sourceIds,
    groupIds,
    periodFrom: from,
    periodTo: to,
    limitTotal,
    perDay,
    requestId: getRequestId() ?? null,
    createdBy: createdBy ?? null,
  });

  logger.info(
    { задание: job.id, период: `${from}..${to}`, лимит: limitTotal, в_день: perDay,
      источников: sourceIds.length, групп: targets.length },
    `Наполнение из архива #${job.id}: период ${from}..${to}, до ${limitTotal} постов, ` +
      `${perDay} в день на группу`,
  );

  launch(job.id);
  return job;
}

/** Остановить задание. Слоты, которые уже уехали в postmypost, не отзываются. */
export async function stopArchiveFill(id) {
  const job = await archive.requestStop(id);
  if (!job) throw new Error(`Задание #${id} не выполняется — останавливать нечего`);
  logger.warn({ задание: id }, `Задание наполнения #${id}: запрошена остановка`);
  return job;
}

/**
 * Подхватить задание после перезапуска приложения.
 *
 * Задание живёт днями, а контейнер может перезапуститься в любой момент. Без этого
 * незаконченное задание навсегда осталось бы в статусе `running` и блокировало новое.
 */
export async function resumeArchiveFill() {
  const job = await archive.findActive();
  if (!job) return null;
  logger.warn(
    { задание: job.id, статус: job.status },
    `После перезапуска найдено задание наполнения #${job.id} (${job.status}) — продолжаем`,
  );
  launch(job.id);
  return job;
}

/** Состояние для панели: активное задание, недавние, идёт ли работа в этом процессе. */
export async function archiveState() {
  const [active, recent] = await Promise.all([archive.findActive(), archive.listRecent(8)]);
  return { active, recent, runningSince: archiveRunningSince() };
}

function launch(jobId) {
  if (current) return;
  const startedAt = Date.now();
  const task = runWithContext(
    { requestId: newRequestId('arch'), source: 'наполнение' },
    () => runJob(jobId),
  )
    .catch((error) => {
      logger.error(errFields(error), `Задание наполнения #${jobId} упало: ${error.message}`);
      if (!error.captured) captureError('наполнение из архива', error).catch(() => {});
      return archive
        .finish(jobId, { status: 'failed', error: error.message, stage: 'сбой' })
        .catch(() => {});
    })
    .finally(async () => {
      current = null;
      await settings.set('backfill_enabled', 'false').catch(() => {});
    });
  current = { jobId, startedAt, task };
}

async function runJob(jobId) {
  const { acquired } = await withAdvisoryLock(ARCHIVE_LOCK_KEY, () => execute(jobId));
  if (!acquired) {
    logger.warn({ задание: jobId }, 'Наполнение уже выполняется в другом процессе — не дублируем');
  }
}

/** Запрошена ли остановка. Статус читается из БД перед каждым шагом — в этом весь смысл. */
async function stopRequested(jobId) {
  const status = await archive.statusOf(jobId);
  return status === null || status === 'stopping' || status === 'stopped';
}

async function execute(jobId) {
  await settings.set('backfill_enabled', 'true');
  let job = await archive.findById(jobId);
  if (!job) throw new Error(`Задание #${jobId} исчезло из базы`);

  // Сбор нужен один раз: у продолженного задания план уже есть, источники перечитывать
  // не надо — это лишние запросы к сайтам и к firecrawl.
  if (!job.run_id) {
    await collect(job);
    if (await stopRequested(jobId)) return finishStopped(jobId, null);

    const plan = await buildArchivePlan(job);
    if (plan.items.length === 0) {
      await archive.finish(jobId, {
        status: 'failed',
        stage: 'план',
        error: plan.reason ?? 'Материалов за период не нашлось',
      });
      logger.warn({ задание: jobId }, `Наполнение #${jobId}: ${plan.reason}`);
      return null;
    }

    const runId = await runs.startRun({
      requestId: getRequestId() ?? null,
      kind: 'archive',
      meta: {
        задание: jobId,
        период: `${dayText(job.period_from)}..${dayText(job.period_to)}`,
        слотов: plan.items.length,
        дней: plan.days,
      },
    });
    await runs.addItems(runId, plan.items);
    const started = await archive.startExecution(jobId, {
      runId,
      planned: plan.items.length,
      days: plan.days,
    });
    logger.info(
      { задание: jobId, прогон: runId, слотов: plan.items.length, дней: plan.days },
      `Наполнение #${jobId}: очередь на ${plan.items.length} постов, ` +
        `растянута на ${plan.days} дн.`,
    );
    // Остановили между сбором и планом — слоты гасим, ничего не публикуем.
    if (!started) return finishStopped(jobId, runId);
    job = await archive.findById(jobId);
  }

  return publishQueue(job);
}

/** Сбор материалов за период по выбранным источникам. */
async function collect(job) {
  await archive.setStage(job.id, 'сбор материалов');
  const { rows: list } = await query(
    `SELECT * FROM sources
      WHERE id = ANY($1::int[]) AND is_active = true AND code <> 'manual'
      ORDER BY id`,
    [job.source_ids],
  );

  const since = new Date(`${dayText(job.period_from)}T00:00:00`);
  const until = new Date(`${dayText(job.period_to)}T23:59:59`);
  let collected = 0;

  for (const source of list) {
    if (await stopRequested(job.id)) break;
    try {
      const stats = await checkSource(source, {
        kind: 'archive',
        since,
        until,
        // Потолки обычного обхода тут не годятся: ему нужен свежий срез, а заданию —
        // весь период целиком, иначе за 2024 год вернулись бы те же 50 адресов.
        discoveryLimit: Math.min(300, Math.max(50, job.limit_total * 2)),
        extractLimit: job.limit_total,
      });
      collected += stats.added;
      await archive.setCollected(job.id, collected);
    } catch (error) {
      // Один недоступный сайт не отменяет наполнение по остальным.
      logger.warn(
        { задание: job.id, источник: source.code, ...errFields(error) },
        `Наполнение #${job.id}: источник ${source.code} не отдался — ${error.message}`,
      );
    }
  }

  logger.info(
    { задание: job.id, новых: collected, источников: list.length },
    `Наполнение #${job.id}: собрано новых материалов ${collected} по ${list.length} источникам`,
  );
  return collected;
}

/**
 * План наполнения: кандидаты от свежих к старым раскладываются по дням и группам.
 *
 * Внутри дня группы получают материалы по кругу — так порядок «от свежих к старым»
 * сохраняется и внутри каждой группы, и по очереди целиком.
 */
export async function buildArchivePlan(job, now = new Date()) {
  const map = await settings.getMap();
  const targets = (await groups.findByIds(job.group_ids)).filter((group) => group.is_active);
  if (targets.length === 0) {
    return { items: [], days: 0, reason: 'Среди выбранных групп нет включённых' };
  }

  const busy = await runs.plannedArticleIds();
  const candidates = await posts.listArchiveCandidates({
    sourceIds: job.source_ids,
    from: dayText(job.period_from),
    to: dayText(job.period_to),
    limit: job.limit_total,
    excludeArticleIds: busy,
  });

  if (candidates.length === 0) {
    return {
      items: [],
      days: 0,
      reason: 'За этот период новых материалов не нашлось: возможно, по ним уже были посты',
    };
  }

  const windowStart = map.posting_window_start ?? '10:00';
  const windowEnd = map.posting_window_end ?? '21:00';
  const jitter = Number.parseInt(map.slot_jitter_minutes ?? '7', 10) || 7;
  const lead = Number.parseInt(map.publish_delay_minutes ?? '3', 10) || 3;

  const items = [];
  let cursor = 0;
  let usedDays = 0;

  for (let dayOffset = 0; dayOffset < MAX_DAYS && cursor < candidates.length; dayOffset += 1) {
    const base = dayBase(now, dayOffset);
    // Сегодняшнее окно уже закрылось — первый день пропускаем целиком, иначе слоты
    // уехали бы в завтрашнее окно и наложились на слоты второго дня.
    if (dayOffset === 0 && windowClosed(now, windowEnd, lead)) continue;

    const quotas = [];
    for (const group of targets) {
      const taken = await groups.scheduledOn(group.id, base);
      const cap = Math.min(job.per_day, group.posts_per_day) - taken;
      quotas.push({ group, left: Math.max(0, cap) });
    }

    const dayAssignments = [];
    let placed = true;
    while (placed && cursor < candidates.length) {
      placed = false;
      for (const quota of quotas) {
        if (quota.left <= 0 || cursor >= candidates.length) continue;
        dayAssignments.push({ group: quota.group, candidate: candidates[cursor] });
        cursor += 1;
        quota.left -= 1;
        placed = true;
      }
    }
    if (dayAssignments.length === 0) continue;

    const times = slotTimes(dayAssignments.length, {
      now: base,
      windowStart,
      windowEnd,
      leadMinutes: lead,
      jitterMinutes: jitter,
    });

    dayAssignments.forEach((assignment, index) => {
      items.push({
        groupId: assignment.group.id,
        groupName: assignment.group.name,
        slotNo: items.length + 1,
        articleId: assignment.candidate.articleId,
        postId: assignment.candidate.postId,
        postAt: times[index],
        label: assignment.candidate.label,
        kind: assignment.candidate.kind,
        date: assignment.candidate.date,
      });
    });
    usedDays += 1;
  }

  return {
    items,
    days: usedDays,
    candidates: candidates.length,
    reason: items.length < candidates.length
      ? `Разложено ${items.length} из ${candidates.length} найденных: остальным не хватило дней ` +
        `(потолок ${MAX_DAYS} дн.) или дневных лимитов групп`
      : null,
  };
}

/** Исполнение очереди: текст, обложка, публикация на своё время. По одному слоту. */
async function publishQueue(job) {
  await archive.setStage(job.id, 'публикация');
  const items = (await runs.listItems(job.run_id)).filter((item) =>
    ['planned', 'generated'].includes(item.status),
  );

  let generated = 0;
  let published = 0;
  let failed = 0;
  let stopped = false;

  for (const item of items) {
    if (await stopRequested(job.id)) {
      stopped = true;
      break;
    }

    try {
      let post = item.post_id ? await posts.findById(Number(item.post_id)) : null;
      if (!post) {
        const article = await posts.findArticleForGeneration(Number(item.article_id));
        if (!article) throw new Error(`Материал #${item.article_id} исчез из базы`);
        post = await generatePost(article);
        generated += 1;
        await runs.setItemPost(item.id, post.id);
        await archive.bump(job.id, { generated: 1 });
      }

      if (!post.image_url) post = await generateImageForPost(post);

      await publishPost(post, {
        groupIds: [Number(item.group_id)],
        postAt: new Date(item.post_at),
      });
      await runs.setItemStatus(item.id, 'published');
      published += 1;
      await archive.bump(job.id, { published: 1 });
    } catch (error) {
      await runs.setItemStatus(item.id, 'failed', error.message);
      failed += 1;
      await archive.bump(job.id, { failed: 1 });
      if (!error.captured) {
        await captureError('слот наполнения', error, {
          runId: Number(job.run_id),
          groupId: Number(item.group_id),
          postId: item.post_id ? Number(item.post_id) : null,
          articleId: item.article_id ? Number(item.article_id) : null,
        });
      }
      logger.error(
        { задание: job.id, слот: item.slot_no, группа: item.group_name, ...errFields(error) },
        `Наполнение #${job.id}, слот ${item.slot_no} («${item.group_name}») не отработал: ${error.message}`,
      );
    }
  }

  if (stopped) {
    await runs.finishRun(job.run_id, {
      status: 'done',
      found: items.length,
      generated,
      published,
      error: 'Задание остановлено вручную',
    });
    return finishStopped(job.id, job.run_id);
  }

  const status = published === 0 && failed > 0 ? 'failed' : 'done';
  await runs.finishRun(job.run_id, {
    status,
    found: items.length,
    generated,
    published,
    error: failed ? `слотов со сбоем: ${failed}` : null,
  });
  await archive.finish(job.id, {
    status,
    stage: 'готово',
    error: failed ? `Слотов со сбоем: ${failed}` : null,
  });

  logger.info(
    { задание: job.id, прогон: job.run_id, слотов: items.length, сгенерировано: generated,
      опубликовано: published, сбоев: failed },
    `Наполнение #${job.id} завершено: опубликовано ${published} из ${items.length}` +
      (failed ? `, сбоев ${failed}` : ''),
  );
  return { published, generated, failed };
}

/**
 * Остановка: недоделанные слоты гасятся, уже созданные посты остаются в базе.
 *
 * Слот в статусе `skipped` освобождает материал: он снова становится кандидатом для
 * обычного прогона (`plannedArticleIds` учитывает только planned/generated/published).
 */
async function finishStopped(jobId, runId) {
  let skipped = 0;
  if (runId) {
    const { rowCount } = await query(
      `UPDATE run_items SET status = 'skipped', updated_at = now()
        WHERE run_id = $1 AND status IN ('planned', 'generated')`,
      [runId],
    );
    skipped = rowCount;
    await query(
      `UPDATE runs SET status = 'done', finished_at = COALESCE(finished_at, now())
        WHERE id = $1 AND status = 'running'`,
      [runId],
    );
  }
  await archive.finish(jobId, {
    status: 'stopped',
    stage: 'остановлено',
    error: skipped ? `Остановлено вручную, не опубликовано слотов: ${skipped}` : 'Остановлено вручную',
  });
  logger.warn(
    { задание: jobId, погашено: skipped },
    `Наполнение #${jobId} остановлено: снято с публикации слотов ${skipped}, ` +
      'уже созданные посты остались в базе',
  );
  return { stopped: true, skipped };
}

/** «2026-07-27» из значения date/timestamp, пришедшего из БД. */
function dayText(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Точка отсчёта для дня раскладки. Для сегодня — «сейчас» (слоты не должны попасть
 * в прошлое), для будущих дней — начало суток, чтобы `slotTimes` разложил их по всему
 * окну публикаций, а не от текущего часа.
 */
function dayBase(now, offset) {
  if (offset === 0) return now;
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  date.setHours(0, 5, 0, 0);
  return date;
}

function windowClosed(now, windowEnd, leadMinutes) {
  const end = new Date(now);
  const { hours, minutes } = parseHhMm(windowEnd, '21:00');
  end.setHours(hours, minutes, 0, 0);
  return now.getTime() + leadMinutes * 60_000 >= end.getTime();
}
