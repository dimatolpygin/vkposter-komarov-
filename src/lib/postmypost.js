import { request, HttpError } from './http-client.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('postmypost');

/**
 * Клиент postmypost v4.1 — через него пост уходит на стену группы ВК.
 *
 * Особенности API, из-за которых нужен свой клиент:
 *
 * 1. **Ответ всегда JSON-массив**, даже на одиночный объект: `[{...}]`. Забыл `[0]` —
 *    получил `undefined` в `id` и непонятную ошибку дальше по коду.
 * 2. **Картинку нельзя приложить к посту напрямую.** Сначала `POST /upload/init`
 *    с публичным URL, потом поллинг `GET /upload/status` до `file_id`, и только он
 *    идёт в публикацию. `id` из `init` — это id задачи загрузки, а не `file_id`.
 * 3. **`project_id` обязателен почти везде** — в теле (POST) или в query (GET/DELETE).
 * 4. **Время только с оффсетом МСК.** `post_at` без `+03:00` или в UTC уедет на три часа.
 * 5. **`POST /publications` не ретраится.** Повтор после фактически созданной публикации
 *    даёт дубль на стене группы, а это видит подписчик. Ретраятся только GET и `/upload/*`.
 */

/** Ошибки, которые повтором не лечатся: токен, права, валидация тела. */
const FATAL_STATUS = new Set([400, 401, 403, 404, 422]);

/** chanel_id соцсети. В API опечатка — поле называется именно `chanel_id`. */
export const CHANEL_VK = 2;
export const CHANEL_OK = 5;

/**
 * Соцсети, в которые постим. Список — единственное место, где это задано: раздача
 * материалов по группам, дневные лимиты, слоты и сама публикация про соцсеть ничего
 * не знают и работают с любым аккаунтом postmypost. Новая сеть — строка здесь.
 */
export const NETWORKS = new Map([
  [CHANEL_VK, { code: 'vk', title: 'ВКонтакте', short: 'ВК' }],
  [CHANEL_OK, { code: 'ok', title: 'Одноклассники', short: 'ОК' }],
]);

export function networkOf(chanelId) {
  return NETWORKS.get(Number(chanelId)) ?? { code: 'other', title: 'Другая сеть', short: '-' };
}

/** publication_status при создании: 4 — черновик, 5 — в очередь на реальную публикацию. */
export const STATUS_DRAFT = 4;
export const STATUS_QUEUED = 5;

/** Статусы загрузки файла из /upload/status. */
const UPLOAD_OK = 1;
const UPLOAD_FAILED = 2;

/** connection_status аккаунта: 1 — подключён. Прочее считаем проблемным. */
export const CONNECTION_OK = 1;

export class PmpError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PmpError';
    this.status = status;
    this.body = body;
    this.fatal = FATAL_STATUS.has(Number(status));
  }
}

export function isConfigured() {
  return Boolean(config.postmypost.token && config.postmypost.projectId);
}

function projectId() {
  return config.postmypost.projectId;
}

async function call(method, path, { json, retries = 2 } = {}) {
  if (!isConfigured()) {
    throw new PmpError(
      'Не заданы POSTMYPOST_TOKEN и POSTMYPOST_PROJECT_ID — публикация недоступна',
      { status: 401 },
    );
  }

  let body;
  try {
    body = await request(`${config.postmypost.baseUrl}${path}`, {
      method,
      label: 'postmypost',
      json,
      retries,
      timeoutMs: config.postmypost.timeoutMs,
      headers: {
        Authorization: `Bearer ${config.postmypost.token}`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      // cause сохраняем ради журнала ошибок: в HttpError есть ещё и адрес запроса,
      // а по нему в панели видно, на каком именно вызове API всё встало.
      throw new PmpError(`postmypost ${error.status}: ${describeBody(error.body)}`, {
        status: error.status,
        body: error.body,
        cause: error,
      });
    }
    throw error;
  }

  const parsed = typeof body === 'string' ? safeJson(body) : body;
  return unwrap(parsed);
}

/**
 * Живой API отдаёт не то, что обещает справочник: `/accounts` приходит как
 * `{"data": [...], "pages": {...}}`, а не голым массивом. Поддерживаем оба варианта —
 * иначе «нет ни одной группы ВК» вместо трёх подключённых.
 */
function unwrap(parsed) {
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && 'data' in parsed) {
    return parsed.data;
  }
  return parsed;
}

/** Ответ-массив → первый элемент. Одиночный объект тоже принимаем. */
function first(parsed) {
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

/** Список аккаунтов проекта. Здесь массив нужен целиком. */
export async function accounts() {
  const parsed = await call('GET', `/accounts?project_id=${projectId()}`);
  return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
}

/**
 * Аккаунты тех сетей, в которые мы постим. Никогда не «первый аккаунт с chanel_id=2» —
 * групп бывает несколько, и работаем всегда с конкретным `id`.
 */
export async function postingAccounts() {
  return (await accounts()).filter((item) => NETWORKS.has(Number(item?.chanel_id)));
}

/** Шаг 1: поставить картинку в очередь загрузки. Возвращает id задачи, НЕ file_id. */
export async function uploadInit(url) {
  const response = first(await call('POST', '/upload/init', {
    json: { project_id: projectId(), url },
    // Загрузка идемпотентна по сути (дубль файла безвреден), но повторять больше раза
    // незачем: истинная причина сбоя обычно в недоступности URL.
    retries: 1,
  }));
  const id = response?.id;
  if (!id) {
    throw new PmpError(`upload/init не вернул id: ${JSON.stringify(response).slice(0, 300)}`);
  }
  return id;
}

export async function uploadStatus(uploadId) {
  return first(await call('GET', `/upload/status?id=${encodeURIComponent(uploadId)}`));
}

/**
 * Шаги 1–2: публичный URL картинки → `file_id`.
 *
 * `file_id` живёт в рамках проекта и переиспользуется: одна обложка заливается один раз
 * и вставляется в несколько групп.
 */
export async function uploadImage(url, { pollMs = 3000, waitMs = 120_000 } = {}) {
  const startedAt = Date.now();
  const uploadId = await uploadInit(url);
  logger.info({ загрузка: uploadId, url }, `postmypost: загрузка ${uploadId} начата`);

  const deadline = startedAt + waitMs;
  let polls = 0;
  while (Date.now() < deadline) {
    const state = await uploadStatus(uploadId);
    polls += 1;
    const status = Number(state?.status);

    if (status === UPLOAD_OK && state?.file_id) {
      const ms = Date.now() - startedAt;
      logger.info(
        { загрузка: uploadId, file_id: state.file_id, опросов: polls, ms },
        `postmypost: картинка залита, file_id ${state.file_id} (${Math.round(ms / 1000)} c)`,
      );
      return { fileId: state.file_id, uploadId, latencyMs: ms };
    }
    if (status === UPLOAD_FAILED) {
      throw new PmpError(
        `postmypost не смог скачать картинку ${url} (загрузка ${uploadId}). ` +
          'Проверьте, что адрес доступен из интернета.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new PmpError(
    `Таймаут загрузки картинки в postmypost: ${Math.round(waitMs / 1000)} c ` +
      `(загрузка ${uploadId}, ${url})`,
  );
}

/**
 * Шаг 3: создать публикацию. По умолчанию — черновик.
 *
 * Одна публикация на один аккаунт (а не общий `account_ids: [a, b]`): у каждой группы
 * свой `publication_id` в БД, а сбой одной группы не роняет остальные.
 */
export async function createPublication({
  accountId,
  content,
  title,
  fileIds = [],
  postAt = moscowIso(),
  status = STATUS_DRAFT,
  type = 1,
}) {
  if (!accountId) throw new PmpError('Не задан accountId для публикации');
  // Number(): id аккаунта и file_id приходят из БД (bigint → строка в node-pg), а API
  // валидирует тип строго — «Value expected to be 'integer', but 'string' given».
  const account = Number(accountId);
  const files = fileIds.map(Number).filter((value) => !Number.isNaN(value));

  const detail = { publication_type: type };
  if (files.length) detail.file_ids = files;
  if (content) detail.content = content;
  if (title) detail.title = title;

  // retries: 0 — осознанно. Повтор после уже созданной публикации = второй пост в группе,
  // и это увидят подписчики. Сеть тут ретраить нельзя.
  const response = first(await call('POST', '/publications', {
    json: {
      project_id: projectId(),
      post_at: postAt,
      account_ids: [account],
      publication_status: status,
      details: [detail],
    },
    retries: 0,
  }));

  const id = response?.id;
  if (!id) {
    throw new PmpError(`publications не вернул id: ${JSON.stringify(response).slice(0, 300)}`);
  }
  logger.info(
    { публикация: id, аккаунт: account, статус: response.publication_status ?? status, post_at: postAt },
    `postmypost: публикация ${id} создана (${status === STATUS_DRAFT ? 'черновик' : 'в очередь'})`,
  );
  return {
    id,
    status: Number(response.publication_status ?? status),
    postAt: response.post_at ?? postAt,
  };
}

/**
 * Публикация целиком, как её видит postmypost. Нужна разделу «Опубликовано»:
 * ссылки на пост в ВК в ответе на создание нет и быть не может (в момент создания
 * записи на стене ещё не существует), а после реальной публикации адрес где-то
 * в объекте появляется.
 */
export async function publication(publicationId) {
  return first(
    await call('GET', `/publications/${publicationId}?project_id=${projectId()}`),
  );
}

/**
 * Найти в ответе адрес опубликованной записи. Имя поля в справочнике не описано и у
 * разных соцсетей разное, поэтому ищем по самому адресу: он опознаётся однозначно,
 * а промахнуться мимо неизвестного поля так нельзя.
 */
export function postUrlFrom(payload) {
  if (!payload) return null;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  // ВК: vk.com/wall-123_456. Одноклассники: ok.ru/group/123/topic/456.
  const match = text.match(
    /https?:\\?\/\\?\/(?:m\.)?(?:vk\.com\/wall-?\d+_\d+|ok\.ru\/(?:group\/)?\d+\/topic\/\d+)/i,
  );
  if (!match) return null;
  return match[0].replaceAll('\\/', '/');
}

/**
 * Удаление/отмена публикации, в том числе черновика.
 *
 * Известный баг postmypost: в ответ прилетает `422 Response validation error … publication_status`,
 * хотя удаление прошло. Такой текст считаем успехом.
 */
export async function deletePublication(publicationId, accountIds = [], deleteOption = 1) {
  const qs = new URLSearchParams({
    delete_option: String(deleteOption),
    project_id: String(projectId()),
  });
  for (const id of accountIds) qs.append('account_ids', String(id));

  try {
    await call('DELETE', `/publications/${publicationId}?${qs}`, { retries: 0 });
  } catch (error) {
    if (!/Response validation error/i.test(String(error.body ?? error.message))) throw error;
    logger.warn(
      { публикация: publicationId },
      `postmypost: 422 на удалении ${publicationId} — известный баг, удаление считаем прошедшим`,
    );
  }
  return { deleted: publicationId };
}

/**
 * ISO-время с оффсетом МСК. `new Date().toISOString()` даёт UTC — отдать его как есть
 * значит уехать на три часа назад.
 *
 * @param {Date|number} [when] момент времени (по умолчанию сейчас)
 */
export function moscowIso(when = Date.now()) {
  const ms = when instanceof Date ? when.getTime() : Number(when);
  const shifted = new Date(ms + 3 * 3600_000);
  return `${shifted.toISOString().slice(0, 19)}+03:00`;
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeBody(text) {
  if (!text) return 'без тела';
  const parsed = safeJson(text);
  return parsed?.message ?? parsed?.status ?? String(text).slice(0, 300);
}
