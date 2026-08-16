import { log, errFields } from '../logger.js';
import { getRequestId } from '../context.js';

const logger = log('внешний-запрос');

/**
 * Единая точка исходящих HTTP-запросов. Через неё пойдут firecrawl, openrouter, kie.ai
 * и postmypost — все четыре провайдера нестабильны (таймауты, 429, 5xx), поэтому
 * ретраи и логирование живут здесь, а не в каждом клиенте.
 *
 * Логируется: метод, URL, статус, латентность, номер попытки, request-id.
 * Тело ответа — только при ошибке (чтобы не заваливать лог успешными телами).
 */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;

export class HttpError extends Error {
  constructor({ method, url, status, body, attempt, label }) {
    super(`${method} ${url} → HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.url = url;
    this.attempt = attempt;
    // Имя провайдера из вызова (kie.ai / postmypost / …). Нужно журналу ошибок:
    // по хосту сервис не определить, в dev там заглушка на localhost.
    this.label = label;
  }
}

/** Сколько ждать перед повтором: Retry-After провайдера в приоритете над нашим бэкоффом. */
function retryDelayMs(response, attempt, baseDelayMs) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  }
  // Экспоненциальный бэкофф с джиттером, чтобы не долбить провайдера в такт.
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential, 30_000) + Math.floor(Math.random() * 400);
}

function shortBody(text, limit = 800) {
  if (typeof text !== 'string') return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…(обрезано)` : text;
}

/**
 * @param {string} url
 * @param {object} options
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {any}    [options.json]        тело как объект — сериализуется и ставит Content-Type
 * @param {string} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]    число ПОВТОРОВ (0 = одна попытка)
 * @param {number} [options.baseDelayMs]
 * @param {string} [options.label]      имя провайдера для лога (firecrawl / kie.ai / …)
 * @param {boolean}[options.raw]        true — вернуть Response, не парсить
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    json,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    baseDelayMs = 1000,
    label = 'http',
    raw = false,
  } = options;

  const finalHeaders = { ...headers };
  let finalBody = body;
  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(json);
  }
  const rid = getRequestId();
  if (rid) finalHeaders['X-Request-Id'] = rid;

  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const startedAt = process.hrtime.bigint();
    const controller = new AbortController();
    // Свой флаг, а не error.name: при abort(reason) fetch отдаёт наш reason, у которого
    // name === 'Error', и таймаут в логе выглядел бы как «сетевая ошибка».
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`таймаут ${timeoutMs} мс`));
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: finalHeaders,
        body: finalBody,
        signal: controller.signal,
      });
      const ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const retryable = RETRYABLE_STATUS.has(response.status) && attempt <= retries;
        logger.warn(
          {
            провайдер: label,
            method,
            url,
            status: response.status,
            ms,
            попытка: attempt,
            тело: shortBody(text),
          },
          retryable
            ? `${label}: ответил ${response.status}, будет повтор`
            : `${label}: ответил ${response.status} — без повтора`,
        );
        const error = new HttpError({
          method, url, status: response.status, body: text, attempt, label,
        });
        if (!retryable) throw error;
        lastError = error;
        const delay = retryDelayMs(response, attempt, baseDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      logger.info(
        { провайдер: label, method, url, status: response.status, ms, попытка: attempt },
        `${label}: запрос выполнен (${response.status}, ${ms} мс)`,
      );

      if (raw) return response;
      const contentType = response.headers.get('content-type') ?? '';
      return contentType.includes('application/json') ? response.json() : response.text();
    } catch (error) {
      const ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
      if (error instanceof HttpError) throw error;

      const isAbort = timedOut || error.name === 'AbortError';
      const retryable = attempt <= retries;
      logger.warn(
        { провайдер: label, method, url, ms, попытка: attempt, ...errFields(error) },
        retryable
          ? `${label}: ${isAbort ? 'таймаут' : 'сетевая ошибка'}, будет повтор`
          : `${label}: ${isAbort ? 'таймаут' : 'сетевая ошибка'} — попытки исчерпаны`,
      );
      if (!retryable) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(null, attempt, baseDelayMs)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error(`${label}: запрос не выполнен`);
}
