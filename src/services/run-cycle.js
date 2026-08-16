import { withAdvisoryLock } from '../db/pool.js';
import * as posts from '../repo/posts.js';
import * as runs from '../repo/runs.js';
import { publicBaseReachable } from '../lib/media.js';
import { buildPlan } from './plan-run.js';
import { backfillArticles } from './backfill.js';
import { refreshSources } from './refresh-sources.js';
import { generatePost } from './generate-post.js';
import { generateImageForPost } from './generate-image.js';
import { publishPost, usingLocalPmpStub } from './publish-post.js';
import { captureError } from './capture-error.js';
import { getRequestId, extendContext } from '../context.js';
import { log, errFields } from '../logger.js';

const logger = log('прогон');

/**
 * Прогон: план → текст → обложка → публикация, по слотам.
 *
 * Три свойства, которые здесь важнее скорости:
 *
 * 1. **Один прогон в моменте.** Второй запуск не ждёт в очереди и не работает параллельно,
 *    а отклоняется: два прогона на одних и тех же материалах — это дубли на стене.
 *    Замок — advisory lock в Postgres (Redis в проекте нет), живёт на время соединения,
 *    поэтому упавший контейнер не оставляет вечную блокировку.
 * 2. **План лежит в БД.** Прерванный прогон при следующем запуске продолжается с того
 *    слота, где встал: уже опубликованные слоты помечены `published` и повторно не уходят.
 * 3. **Сбой слота не роняет прогон.** Каждый слот — своя запись с ошибкой; остальные
 *    посты доезжают.
 */

/** Ключ advisory lock прогона. Произвольная константа, но одна на весь проект. */
const RUN_LOCK_KEY = 815_240_801;

/**
 * Текущий фоновый прогон в этом процессе. Хранится в памяти — панели этого достаточно,
 * чтобы сразу сказать «уже идёт»; межпроцессная защита всё равно на advisory lock.
 */
let current = null;

/** Последняя ошибка фонового прогона (в фоне её некому вернуть в HTTP-ответе). */
let lastError = null;

/**
 * Момент падения фонового прогона. Планировщик считает запуск удавшимся сразу после
 * старта, а прогон падает уже в фоне, минуту-две спустя. Без этой отметки он видел
 * «прогон стартовал», а прогон, упавший до записи плана, не обновлял и точку отсчёта
 * расписания — и запуск повторялся каждую минуту, наполняя журнал одинаковыми сбоями.
 */
let lastFailureAt = null;

/**
 * @param {object} [options]
 * @param {'cron'|'manual'|'backfill'} [options.kind] чем инициирован прогон
 * @param {number[]} [options.groupIds] ограничить группами (ручной прогон)
 * @param {number} [options.limitPerGroup] потолок постов на группу (проверка, демо)
 */
export async function runCycle({ kind = 'manual', groupIds, limitPerGroup, stepMinutes } = {}) {
  const { acquired, result } = await withAdvisoryLock(RUN_LOCK_KEY, () =>
    executeCycle({ kind, groupIds, limitPerGroup, stepMinutes }),
  );
  if (!acquired) {
    throw new Error(
      'Прогон уже идёт — второй запуск отклонён. Дождитесь окончания текущего прогона.',
    );
  }
  return result;
}

/**
 * Тот же прогон, но в фоне: HTTP-ответ не ждёт ни генерации, ни обложек.
 *
 * Прогон из шести слотов на живых провайдерах — это 6-8 минут, столько держать
 * страницу нельзя: человек закроет вкладку, запрос оборвётся. Здесь запуск только
 * стартует работу, а прогресс виден в таблице слотов по обновлению страницы.
 * Планировщик на этапе 9 будет вызывать ровно это.
 *
 * @returns {{started: boolean, reason?: string}} `started: false` — прогон уже идёт
 */
export function startCycleInBackground(options = {}) {
  if (current) {
    return { started: false, reason: 'Прогон уже идёт — дождитесь его окончания' };
  }

  // Дешёвые проверки делаем синхронно, до ухода в фон: иначе человек увидит
  // «прогон запущен», а причина отказа останется только в логе.
  const reachable = publicBaseReachable();
  if (!reachable.ok && !usingLocalPmpStub()) {
    lastError = reachable.hint;
    return { started: false, reason: reachable.hint };
  }

  const startedAt = Date.now();
  lastError = null;
  lastFailureAt = null;
  const task = runCycle(options)
    .then((result) => {
      logger.info({ прогон: result.runId }, `Фоновый прогон #${result.runId} завершён`);
      return result;
    })
    .catch((error) => {
      // Прогон в фоне: ошибку некому вернуть в ответе, поэтому она оседает здесь
      // и показывается в карточке прогона до следующего запуска.
      lastError = error.message;
      lastFailureAt = Date.now();
      // Прогон в фоне: ответа с ошибкой нет, поэтому кроме карточки на «Обзоре»
      // сбой должен остаться в журнале — иначе после следующего запуска о нём
      // не останется следа нигде, кроме логов контейнера.
      if (!error.captured) captureError('прогон', error).catch(() => {});
      logger.error(errFields(error), `Фоновый прогон упал: ${error.message}`);
      return null;
    })
    .finally(() => {
      current = null;
    });
  current = { startedAt, task };
  return { started: true };
}

/** Идёт ли прогон прямо сейчас в этом процессе (для панели). */
export function runningSince() {
  return current ? new Date(current.startedAt) : null;
}

/** Ошибка последнего фонового прогона: ответа с ней не было, показываем в панели. */
export function lastBackgroundError() {
  return lastError;
}

/** Когда фоновый прогон упал в последний раз (для паузы перед повтором). */
export function lastBackgroundFailureAt() {
  return lastFailureAt;
}

async function executeCycle({ kind, groupIds, limitPerGroup, stepMinutes }) {
  const requestId = getRequestId() ?? null;
  const startedAt = Date.now();

  // Предполёт. Генерация текста и обложек стоит денег, а публикация с локальным
  // PUBLIC_BASE_URL не пройдёт никогда: postmypost скачивает картинку сам. Проверяем
  // до первой траты, а не после шести.
  const reachable = publicBaseReachable();
  if (!reachable.ok && !usingLocalPmpStub()) throw new Error(reachable.hint);

  // Продолжение прерванного прогона имеет приоритет над новым планом: сначала доезжает
  // то, что уже распределено по группам и слотам.
  let run = await runs.unfinishedCycle();
  const resumed = Boolean(run);
  let planReason = null;
  let backfilled = null;
  let refreshed = null;

  if (run) {
    logger.warn(
      { прогон: run.id, начат: run.started_at },
      `Найден незаконченный прогон #${run.id} — продолжаем его, новый план не строим`,
    );
  } else {
    // Свежее с сайтов забираем до плана. Иначе прогон публикует накопленное в базе,
    // а вышедшее сегодня попадёт в очередь только тогда, когда запас кончится.
    refreshed = await refreshSources();
    if (refreshed.skipped) {
      logger.info({ причина: refreshed.skipped }, `Источники не обновлялись: ${refreshed.skipped}`);
    }

    let plan = await buildPlan({ groupIds, limitPerGroup, stepMinutes });

    // Свежих материалов меньше, чем мест в группах — дочерпываем архив и строим план
    // заново. Без этого прогон при исчерпании свежих тем просто отдавал бы «нечего
    // публиковать», хотя на сайтах материала ещё много.
    if (plan.shortfall > 0) {
      const backfill = await backfillArticles(plan.shortfall);
      if (backfill.added > 0) {
        plan = await buildPlan({ groupIds, limitPerGroup, stepMinutes });
        backfilled = backfill;
      } else if (backfill.skipped) {
        logger.info({ причина: backfill.skipped }, `Добор не выполнялся: ${backfill.skipped}`);
      }
    }

    planReason = plan.reason;
    if (plan.items.length === 0) {
      throw new Error(plan.reason ?? 'Планировать нечего');
    }
    const runId = await runs.startRun({
      requestId,
      kind,
      meta: {
        слотов: plan.items.length,
        групп: plan.groups.length,
        окно: plan.items.length
          ? `${formatTime(plan.items[0].postAt)}-${formatTime(plan.items.at(-1).postAt)}`
          : null,
        добор: backfilled
          ? `${backfilled.added} материалов за ${backfilled.days} дней`
          : null,
        обновление: refreshed?.checked
          ? `${refreshed.checked} источников, ${refreshed.added} новых материалов`
          : (refreshed?.skipped ?? null),
      },
    });
    // Запись плана — единственный шаг между «прогон начат» и «прогон исполняется».
    // Если она упадёт, прогон навсегда останется в статусе «идёт»: цикла ещё нет,
    // finishRun не позовут, а панель будет показывать вечно работающий прогон.
    // Ровно так 03.08 повис прогон #59, отбитый уникальным индексом run_items.
    try {
      await runs.addItems(runId, plan.items);
    } catch (error) {
      await runs.finishRun(runId, { status: 'failed', error: error.message });
      throw error;
    }
    run = { id: runId };
    logger.info(
      { прогон: runId, слотов: plan.items.length },
      `Прогон #${runId} начат: ${plan.items.length} слотов`,
    );
  }

  // Номер прогона — в сквозной контекст: он попадёт и в каждую строку лога (поле `run`),
  // и в записи журнала ошибок, сделанные глубже по конвейеру, без ручной передачи.
  extendContext({ runId: run.id });

  const items = (await runs.listItems(run.id)).filter((item) =>
    ['planned', 'generated'].includes(item.status),
  );

  let generated = 0;
  let published = 0;
  const failures = [];

  for (const item of items) {
    // Шаг конвейера, на котором слот находится прямо сейчас. Нужен журналу ошибок:
    // «слот 3 упал» не говорит ничего, «слот 3 упал на обложке» — говорит всё.
    let step = 'подготовка слота';
    try {
      let post = item.post_id ? await posts.findById(Number(item.post_id)) : null;

      if (!post) {
        step = 'генерация текста';
        const article = await posts.findArticleForGeneration(Number(item.article_id));
        if (!article) throw new Error(`Материал #${item.article_id} исчез из базы`);
        post = await generatePost(article);
        generated += 1;
        await runs.setItemPost(item.id, post.id);
      }

      if (!post.image_url) {
        step = 'генерация обложки';
        post = await generateImageForPost(post);
      }
      step = 'публикация';

      // postAt берётся из плана, а не «сейчас + N минут»: именно план разносит публикации
      // по слотам, и продолжение прерванного прогона должно попадать в свои же времена.
      await publishPost(post, {
        groupIds: [Number(item.group_id)],
        postAt: new Date(item.post_at),
      });
      await runs.setItemStatus(item.id, 'published');
      published += 1;
    } catch (error) {
      await runs.setItemStatus(item.id, 'failed', error.message);
      // `captured` ставит тот, кто поймал сбой ближе к месту — в нём и сервис, и тело
      // ответа, и группа. Второй записи об одном и том же в журнале быть не должно.
      if (!error.captured) {
        await captureError(step, error, {
          runId: run.id,
          groupId: Number(item.group_id),
          postId: item.post_id ? Number(item.post_id) : null,
          articleId: item.article_id ? Number(item.article_id) : null,
        });
      }
      failures.push({ slot: item.slot_no, group: item.group_name, error });
      logger.error(
        { прогон: run.id, слот: item.slot_no, группа: item.group_name, ...errFields(error) },
        `Слот ${item.slot_no} («${item.group_name}») не отработал: ${error.message}`,
      );

      // Кончились кредиты на обложки — остальные слоты упрутся ровно в это же.
      // Прогон 01.08 получил двадцать пять одинаковых отказов подряд и двадцать пять
      // одинаковых записей в журнале. Останавливаемся: посты остаются готовыми и
      // уйдут следующим прогоном, как только баланс пополнят.
      if (error.code === 402) {
        const rest = items.slice(items.indexOf(item) + 1);
        // Слоты нельзя оставить в статусе «запланирован»: их материалы считаются
        // занятыми этим прогоном и в новый план не попадут вообще. Закрываем их
        // с понятной причиной — посты при этом остаются готовыми и уедут потом.
        for (const skipped of rest) {
          await runs.setItemStatus(skipped.id, 'failed',
            'Пропущен: на kie.ai кончились кредиты на обложки');
        }
        logger.warn(
          { прогон: run.id, пропущено: rest.length },
          `Кредиты на обложки кончились — прогон остановлен, ${rest.length} слотов ждут пополнения`,
        );
        break;
      }
    }
  }

  const status = published === 0 && failures.length > 0 ? 'failed' : 'done';
  await runs.finishRun(run.id, {
    status,
    found: items.length,
    generated,
    published,
    error: failures.length
      ? failures.map((item) => `слот ${item.slot}: ${item.error.message}`).join('; ')
      : null,
  });

  const ms = Date.now() - startedAt;
  logger.info(
    { прогон: run.id, слотов: items.length, сгенерировано: generated, опубликовано: published,
      сбоев: failures.length, продолжение: resumed, ms },
    `Прогон #${run.id} завершён: опубликовано ${published} из ${items.length}` +
      (generated ? `, сгенерировано ${generated}` : '') +
      (failures.length ? `, сбоев ${failures.length}` : '') +
      `, ${Math.round(ms / 1000)} c`,
  );

  return {
    runId: run.id,
    resumed,
    backfilled,
    planned: items.length,
    generated,
    published,
    failed: failures.length,
    failures,
    planReason,
    ms,
  };
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
