import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Сквозной контекст запроса/прогона. Задача — чтобы request-id, поставленный на входе
 * (HTTP-запрос, тик планировщика, ручной запуск), автоматически попадал в каждую строку
 * лога по всему пути: парсинг → ИИ → картинка → публикация. Без этого связать сбой
 * внешнего API с конкретным постом невозможно.
 */
const storage = new AsyncLocalStorage();

/** Короткий id, удобный для глаз в логе и для поиска в панели. */
export function newRequestId(prefix = 'req') {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Выполнить fn внутри нового контекста. Всё асинхронное внутри увидит тот же requestId. */
export function runWithContext(ctx, fn) {
  const requestId = ctx.requestId ?? newRequestId();
  return storage.run({ ...ctx, requestId }, fn);
}

/** Текущий контекст или пустой объект, если код выполняется вне контекста. */
export function getContext() {
  return storage.getStore() ?? {};
}

export function getRequestId() {
  return getContext().requestId;
}

/** Дописать поля в текущий контекст (например, id прогона, когда он появился). */
export function extendContext(fields) {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}
