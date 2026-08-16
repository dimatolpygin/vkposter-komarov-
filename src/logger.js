import pino from 'pino';
import { config } from './config.js';
import { getContext } from './context.js';

const transport = config.log.pretty
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'dd.mm.yyyy HH:MM:ss',
        ignore: 'pid,hostname',
        messageKey: 'msg',
      },
    }
  : undefined;

/**
 * Базовый логгер. Все сообщения — на русском (требование проекта).
 * mixin подмешивает сквозные поля контекста (request-id, id прогона) в каждую строку,
 * поэтому в коде их передавать руками не нужно.
 */
export const logger = pino({
  level: config.log.level,
  transport,
  base: undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  mixin() {
    const { requestId, runId, source } = getContext();
    const extra = {};
    if (requestId) extra.rid = requestId;
    if (runId) extra.run = runId;
    if (source) extra.src = source;
    return extra;
  },
});

/** Логгер с постоянным префиксом подсистемы: log('парсер').info('...'). */
export function log(component) {
  return logger.child({ mod: component });
}

/** Ошибку в лог кладём с типом, сообщением и стеком — без потери контекста. */
export function errFields(error) {
  if (!(error instanceof Error)) return { err: { message: String(error) } };
  return {
    err: {
      type: error.constructor?.name ?? 'Error',
      message: error.message,
      stack: error.stack,
      ...(error.cause ? { cause: String(error.cause) } : {}),
    },
  };
}
