import 'dotenv/config';

/**
 * Читает переменную окружения, падает на старте, если обязательная не задана.
 *
 * trim обязателен: .env, отредактированный на Windows, приходит с CRLF, и значение
 * получает хвостовой \r. Пароль с невидимым \r перестаёт совпадать, а API-ключ даёт
 * загадочный 401 от провайдера — искать такое потом крайне неприятно.
 */
function env(name, { required = false, fallback = undefined } = {}) {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    if (required) {
      throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
    }
    return fallback;
  }
  return raw;
}

function envInt(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Переменная окружения ${name} должна быть целым числом, получено: ${raw}`);
  }
  return parsed;
}

function envBool(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'да'].includes(raw.toLowerCase());
}

export const config = {
  nodeEnv: env('NODE_ENV', { fallback: 'development' }),
  get isProd() {
    return this.nodeEnv === 'production';
  },

  http: {
    port: envInt('PORT', 3000),
  },

  log: {
    level: env('LOG_LEVEL', { fallback: 'info' }),
    pretty: envBool('LOG_PRETTY', true),
  },

  db: {
    // В докере хост — имя сервиса postgres; локально — localhost.
    host: env('POSTGRES_HOST', { fallback: 'postgres' }),
    port: envInt('POSTGRES_PORT', 5432),
    user: env('POSTGRES_USER', { required: true }),
    password: env('POSTGRES_PASSWORD', { required: true }),
    database: env('POSTGRES_DB', { required: true }),
    // Ждём готовности БД на старте: контейнер app может подняться раньше postgres.
    connectRetries: envInt('DB_CONNECT_RETRIES', 30),
    connectRetryDelayMs: envInt('DB_CONNECT_RETRY_DELAY_MS', 2000),
  },

  session: {
    secret: env('SESSION_SECRET', { required: true }),
  },

  firecrawl: {
    apiKey: env('FIRECRAWL_API_KEY'),
    baseUrl: env('FIRECRAWL_BASE_URL', { fallback: 'https://api.firecrawl.dev/v2' }),
    timeoutMs: envInt('FIRECRAWL_TIMEOUT_MS', 90_000),
  },

  openrouter: {
    apiKey: env('OPENROUTER_API_KEY'),
    // baseUrl вынесен в переменную не для красоты: в dev на него можно подставить
    // локальную заглушку (/_debug/openrouter) и проверить весь конвейер генерации,
    // не расходуя кредиты и не завися от доступности провайдера.
    baseUrl: env('OPENROUTER_BASE_URL', { fallback: 'https://openrouter.ai/api/v1' }),
    model: env('OPENROUTER_MODEL', { fallback: 'google/gemini-2.5-flash-lite' }),
    fallbackModel: env('OPENROUTER_FALLBACK_MODEL', { fallback: 'deepseek/deepseek-v4-flash:nitro' }),
    timeoutMs: envInt('OPENROUTER_TIMEOUT_MS', 120_000),
  },

  kie: {
    apiKey: env('KIE_API_KEY'),
    // baseUrl вынесен по той же причине, что у openrouter: в dev на него подставляется
    // локальная заглушка (/_debug/kie) — можно проверить таймауты, 402 и провал задачи,
    // не расходуя кредиты.
    baseUrl: env('KIE_BASE_URL', { fallback: 'https://api.kie.ai/api/v1' }),
    // В .env лежит короткое имя (gpt-image-2), а API ждёт полное с суффиксом режима.
    model: env('KIE_MODEL', { fallback: 'gpt-image-2' }),
    timeoutMs: envInt('KIE_TIMEOUT_MS', 60_000),
  },

  postmypost: {
    token: env('POSTMYPOST_TOKEN'),
    projectId: envInt('POSTMYPOST_PROJECT_ID', 0),
    // baseUrl вынесен по той же причине, что у kie.ai: в dev на него подставляется
    // локальная заглушка (/_debug/pmp), чтобы гонять публикацию без реальных постов в ВК.
    baseUrl: env('POSTMYPOST_BASE_URL', { fallback: 'https://api.postmypost.io/v4.1' }),
    timeoutMs: envInt('POSTMYPOST_TIMEOUT_MS', 30_000),
  },

  // Куда складываем обложки. Том media примонтирован сюда в обоих режимах compose.
  mediaDir: env('MEDIA_DIR', { fallback: '/app/media' }),

  // Общий User-Agent для прямых запросов к источникам: часть сайтов режет пустой UA.
  userAgent: env(
    'HTTP_USER_AGENT',
    { fallback: 'Mozilla/5.0 (compatible; vkposter/1.0; +https://vktop545.com)' },
  ),

  // Первичная установка аккаунта панели. Дальше пароль живёт в БД и меняется в панели.
  admin: {
    login: env('ADMIN_LOGIN', { fallback: 'admin' }),
    initialPassword: env('ADMIN_PASSWORD'),
  },

  // Публичный базовый URL — нужен на этапе 5, чтобы отдавать картинки в postmypost.
  publicBaseUrl: env('PUBLIC_BASE_URL', { fallback: 'http://localhost:3000' }),

  // Короткий хеш выкаченного коммита: его подставляет deploy/deploy.sh перед
  // `docker compose up`. Показывается в подвале панели — по нему видно, доехал ли
  // автодеплой, не заходя на сервер. Локально пусто, и это нормально.
  revision: env('APP_REVISION'),
};
