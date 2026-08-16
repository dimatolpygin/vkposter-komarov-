import * as errorsRepo from '../repo/errors.js';
import { HttpError } from '../lib/http-client.js';
import { getContext } from '../context.js';
import { log, errFields } from '../logger.js';

const logger = log('журнал-ошибок');

/**
 * Записать сбой в журнал панели (раздел «Ошибки»).
 *
 * Три правила этого файла:
 *
 * 1. **Ничего не бросает.** Он вызывается из `catch`-блоков конвейера; упавшая запись
 *    в журнал не должна превращать обработанный сбой в необработанный. Худшее, что
 *    случится, — строка в логе о том, что не удалось записать ошибку.
 * 2. **Сервис и тело ответа достаются сами.** Провайдеры оборачивают ошибки
 *    (`PmpError`, `KieError`), поэтому цепочка `cause` разматывается до `HttpError` —
 *    у него есть имя провайдера, статус, адрес и тело ответа. Именно тело объясняет
 *    422 и 401, а в панели его сейчас нет вообще.
 * 3. **`request-id` и `run_id` берутся из контекста.** Их не надо передавать руками
 *    ни в одном месте вызова — они уже сквозные (AsyncLocalStorage, этап 0).
 */
export async function captureError(stage, error, extra = {}) {
  try {
    // Отметка на самой ошибке: сбой публикации ловится и в `publishPost`, и в слоте
    // прогона выше. Записываем ближайший к месту сбоя — там известны и группа, и пост.
    if (error && typeof error === 'object') error.captured = true;
    const ctx = getContext();
    const http = findHttpError(error);
    await errorsRepo.record({
      stage,
      service: extra.service ?? http?.label ?? null,
      message: error?.message ?? String(error),
      details: extra.details ?? shorten(http?.body),
      httpStatus: http?.status ?? null,
      url: extra.url ?? http?.url ?? null,
      requestId: ctx.requestId ?? null,
      runId: extra.runId ?? ctx.runId ?? null,
      postId: extra.postId ?? null,
      groupId: extra.groupId ?? null,
      articleId: extra.articleId ?? null,
      sourceId: extra.sourceId ?? null,
    });
  } catch (writeError) {
    logger.error(
      { шаг: stage, ...errFields(writeError) },
      `Не удалось записать сбой «${stage}» в журнал ошибок`,
    );
  }
}

/**
 * Развернуть цепочку `cause` до сетевой ошибки — там весь контекст провайдера.
 * `HttpError` в приоритете над ошибкой клиента: у него есть ещё и адрес запроса,
 * а клиенты (`PmpError`, `KieError`) переносят на себя только статус и тело.
 */
function findHttpError(error) {
  let fallback = null;
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof HttpError) return current;
    if (!fallback && current.status !== undefined && current.body !== undefined) {
      fallback = current;
    }
    current = current.cause;
  }
  return fallback;
}

function shorten(body) {
  if (body === undefined || body === null) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > 3000 ? `${text.slice(0, 3000)}…(обрезано)` : text;
}
