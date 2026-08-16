import { request, HttpError } from './http-client.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('kie.ai');

/**
 * Клиент kie.ai `gpt-image-2` (text-to-image).
 *
 * Четыре особенности провайдера, из-за которых нельзя обойтись «просто fetch»:
 *
 * 1. **API асинхронный.** Нет варианта «запрос → картинка»: `createTask` отдаёт `taskId`,
 *    дальше поллинг `recordInfo` до `state=success`. Генерация 30-90 секунд.
 * 2. **`code` в теле важнее HTTP-статуса.** HTTP 200 с `"code": 402` = кредиты кончились.
 *    Проверяем оба, иначе «успешный» ответ уедет дальше как валидный.
 * 3. **`resultJson` — строка с JSON внутри.** Нужен второй `JSON.parse`. То же с `param`.
 * 4. **Ответ бывает массивом** `[{...}]` вместо объекта.
 *
 * Про деньги: кредиты списываются за задачу. Поэтому `createTask` не повторяется агрессивно
 * (повтор после фактически созданной задачи = вторая оплаченная генерация), а `taskId`
 * вызывающий код обязан записать в БД до поллинга.
 */

const MODEL_SUFFIX_T2I = '-text-to-image';

/** Ошибки, которые повтором не лечатся: ключ, кредиты, валидация, отключённая функция. */
const FATAL_CODES = new Set([401, 402, 422, 505]);

const DONE_STATES = new Set(['success', 'succeeded', 'completed', 'complete']);
const FAILED_STATES = new Set(['fail', 'failed', 'error']);

export class KieError extends Error {
  /**
   * @param {object} [meta]
   * @param {number|string} [meta.code]
   * @param {string} [meta.taskId]
   * @param {boolean} [meta.taskDead] задача мертва окончательно — дочитывать нечего.
   *   Отличать от таймаута: там задача жива и результат ещё может появиться, поэтому
   *   taskId нужно сохранить и дочитать, а не платить за новую генерацию.
   */
  constructor(message, { code, taskId, taskDead = false, cause } = {}) {
    // cause держим ради журнала ошибок: в исходном HttpError лежит тело ответа
    // провайдера, а по нему и видно, за что kie.ai отказал.
    super(message, cause ? { cause } : undefined);
    this.name = 'KieError';
    this.code = code;
    this.taskId = taskId;
    this.taskDead = taskDead;
    this.fatal = FATAL_CODES.has(Number(code));
  }
}

export function isConfigured() {
  return Boolean(config.kie.apiKey);
}

/** Полное имя модели: в .env лежит короткое `gpt-image-2`, API ждёт суффикс режима. */
export function textToImageModel() {
  const model = config.kie.model;
  return model.endsWith(MODEL_SUFFIX_T2I) ? model : `${model}${MODEL_SUFFIX_T2I}`;
}

async function call(method, path, { json, retries = 2 } = {}) {
  if (!isConfigured()) {
    throw new KieError('Не задан KIE_API_KEY — генерация обложек недоступна', { code: 401 });
  }

  let body;
  try {
    body = await request(`${config.kie.baseUrl}${path}`, {
      method,
      label: 'kie.ai',
      json,
      retries,
      timeoutMs: config.kie.timeoutMs,
      headers: {
        Authorization: `Bearer ${config.kie.apiKey}`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw new KieError(`kie.ai ${error.status}: ${describeBody(error.body)}`, {
        code: error.status,
        cause: error,
      });
    }
    throw error;
  }

  // Ответ бывает массивом из одного элемента — поддерживаем оба варианта.
  let parsed = typeof body === 'string' ? safeJson(body) : body;
  if (Array.isArray(parsed)) parsed = parsed[0];

  const code = parsed?.code;
  if (code != null && Number(code) !== 200) {
    throw new KieError(`kie.ai code ${code}: ${parsed?.msg ?? 'без описания'}`, { code });
  }
  return parsed;
}

/** Шаг 1: создать задачу. Возвращает taskId — записать его в БД ДО поллинга. */
export async function createTask({ prompt, aspectRatio = '16:9', resolution }) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new KieError('Промт обложки пустой', { code: 422 });
  if (text.length > 20_000) throw new KieError('Промт обложки длиннее 20000 символов', { code: 422 });

  const input = { prompt: text, aspect_ratio: aspectRatio };
  // resolution выше 1K требует явного aspect_ratio: при auto запрос падает на создании.
  if (resolution) input.resolution = resolution;

  // retries: 1 — компромисс. Повтор нужен от сетевых обрывов, но таймаут на createTask
  // может означать, что задача всё-таки создалась, и повтор оплатит вторую генерацию.
  // Больше одного повтора здесь недопустимо.
  const response = await call('POST', '/jobs/createTask', {
    json: { model: textToImageModel(), input },
    retries: 1,
  });

  const taskId = response?.data?.taskId ?? response?.data?.recordId;
  if (!taskId) {
    throw new KieError(`createTask не вернул taskId: ${JSON.stringify(response).slice(0, 300)}`);
  }
  logger.info(
    { задача: taskId, модель: textToImageModel(), формат: aspectRatio, разрешение: resolution ?? '1K' },
    `Задача kie.ai создана: ${taskId}`,
  );
  return taskId;
}

/** Шаг 2: статус задачи. GET идемпотентен, повторы безопасны. */
export async function recordInfo(taskId) {
  const response = await call('GET', `/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
  const data = response?.data;
  if (!data || typeof data !== 'object') {
    throw new KieError(`recordInfo без data по задаче ${taskId}`, { taskId });
  }
  return data;
}

/** resultJson приходит СТРОКОЙ с JSON внутри — отсюда второй разбор. */
export function resultUrls(record) {
  let raw = record?.resultJson ?? {};
  if (typeof raw === 'string') raw = raw.trim() ? safeJson(raw) ?? {} : {};
  const urls = raw.resultUrls ?? raw.urls ?? raw.images ?? [];
  return (Array.isArray(urls) ? urls : [urls]).map(String).filter(Boolean);
}

/**
 * Полный цикл: промт → ссылки на картинки. Ссылки временные, скачивать сразу.
 *
 * @param {object} params
 * @param {string} params.prompt
 * @param {string} [params.aspectRatio]
 * @param {string} [params.resolution]
 * @param {number} [params.pollMs]
 * @param {number} [params.waitMs]     общий таймаут ожидания
 * @param {(taskId: string) => Promise<void>} [params.onTask]  вызывается сразу после createTask
 */
export async function generateImage({
  prompt,
  aspectRatio = '16:9',
  resolution,
  pollMs = 5000,
  waitMs = 300_000,
  onTask,
}) {
  const startedAt = Date.now();
  const taskId = await createTask({ prompt, aspectRatio, resolution });
  // Записать taskId до первого опроса: упавший воркер не потеряет оплаченную генерацию.
  if (onTask) await onTask(taskId);
  return waitForTask(taskId, { pollMs, waitMs, startedAt });
}

/**
 * Ожидание уже созданной задачи. Отдельно от generateImage, чтобы можно было дочитать
 * результат по taskId из БД — задача оплачена, повторять её создание нельзя.
 */
export async function waitForTask(taskId, { pollMs = 5000, waitMs = 300_000, startedAt = Date.now() } = {}) {
  const deadline = startedAt + waitMs;
  let polls = 0;

  while (Date.now() < deadline) {
    const record = await recordInfo(taskId);
    polls += 1;
    const state = String(record.state ?? '').toLowerCase();

    if (DONE_STATES.has(state)) {
      const urls = resultUrls(record);
      if (urls.length === 0) {
        throw new KieError(`Задача ${taskId} успешна, но resultUrls пуст`, { taskId, taskDead: true });
      }
      const latencyMs = Date.now() - startedAt;
      logger.info(
        {
          задача: taskId,
          опросов: polls,
          ms: latencyMs,
          кредитов: record.creditsConsumed,
          costTime: record.costTime,
          картинок: urls.length,
        },
        `Обложка готова: задача ${taskId}, ${Math.round(latencyMs / 1000)} c, ` +
          `кредитов ${record.creditsConsumed ?? '?'}`,
      );
      return {
        taskId,
        urls,
        creditsConsumed: record.creditsConsumed ?? null,
        costTime: record.costTime ?? null,
        latencyMs,
      };
    }

    if (FAILED_STATES.has(state)) {
      throw new KieError(
        `Задача ${taskId} провалилась: ${record.failMsg ?? record.failCode ?? 'без причины'}`,
        { taskId, code: record.failCode, taskDead: true },
      );
    }

    logger.debug({ задача: taskId, состояние: state, опрос: polls }, `Задача ${taskId}: ${state}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new KieError(
    `Таймаут ожидания задачи ${taskId}: ${Math.round(waitMs / 1000)} c. ` +
      'Задача оплачена — результат можно дочитать по этому id.',
    { taskId },
  );
}

/** Скачивание результата. Отдельно от generateImage: ссылка живёт минуты. */
export async function downloadImage(url) {
  const response = await request(url, {
    label: 'kie.ai-файл',
    raw: true,
    retries: 2,
    timeoutMs: config.kie.timeoutMs,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new KieError('Скачан пустой файл обложки');
  return {
    buffer,
    contentType: response.headers.get('content-type') ?? 'image/png',
  };
}

/** Остаток кредитов. Проверяем перед пачкой: 402 посреди цикла дороже одной проверки. */
export async function credits() {
  const response = await call('GET', '/chat/credit', { retries: 1 });
  const value = Number(response?.data);
  return Number.isNaN(value) ? null : value;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeBody(text) {
  if (!text) return 'без тела';
  const parsed = safeJson(text);
  return parsed?.msg ?? parsed?.message ?? String(text).slice(0, 300);
}
