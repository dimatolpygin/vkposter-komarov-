import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('медиа');

/**
 * Своё хранилище картинок.
 *
 * Зачем не отдавать ссылку провайдера: результат kie.ai лежит на `tempfile.aiquickdraw.com`
 * и живёт минуты. Публикация в ВК отложенная — к моменту постинга ссылка мёртвая,
 * а postmypost скачивает картинку сам, по URL, в момент публикации. Поэтому файл
 * перекладывается в том `media` и отдаётся с нашего домена.
 *
 * Раскладка по месяцам (`media/2026-07/...`): чистить архив за старый месяц одной командой.
 */

const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/**
 * Виден ли наш публичный адрес из интернета.
 *
 * Дорогая грабля: `PUBLIC_BASE_URL=http://localhost:3000` в dev выглядит рабочим —
 * картинка открывается в браузере, потому что браузер тоже локальный. Но обложку
 * скачивает postmypost со своей стороны, и для него `localhost` — это он сам:
 * публикация падает на `422 Не удалось загрузить файл по ссылке` уже после того,
 * как потрачены кредиты на генерацию. Поэтому адрес проверяется до работы.
 *
 * @returns {{ok: boolean, host: string, hint?: string}}
 */
export function publicBaseReachable() {
  let host = '';
  try {
    host = new URL(config.publicBaseUrl).hostname;
  } catch {
    return { ok: false, host: config.publicBaseUrl, hint: 'PUBLIC_BASE_URL не похож на адрес' };
  }

  const local = host === 'localhost'
    || host === '::1'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (!local) return { ok: true, host };
  return {
    ok: false,
    host,
    hint:
      `PUBLIC_BASE_URL указывает на «${host}» — этот адрес доступен только с вашей машины. ` +
      'postmypost скачивает обложку сам, со своей стороны, и такую ссылку не откроет. ' +
      'Поднимите туннель (рецепт в CLAUDE.md) и подставьте его адрес в PUBLIC_BASE_URL, ' +
      'либо публикуйте с прода, где стоит домен.',
  };
}

/** Имя месяца в МСК — контейнер живёт в Europe/Moscow, отдельный формат не нужен. */
function monthDir(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function extensionFor(contentType, sourceUrl) {
  const byType = EXTENSIONS[String(contentType).split(';')[0].trim().toLowerCase()];
  if (byType) return byType;
  const fromUrl = sourceUrl ? path.extname(new URL(sourceUrl).pathname).toLowerCase() : '';
  return /^\.(png|jpe?g|webp)$/.test(fromUrl) ? fromUrl : '.png';
}

/**
 * Сохранить обложку поста.
 *
 * @returns {Promise<{path: string, relative: string, url: string, bytes: number}>}
 *          `path` — абсолютный путь на диске, `url` — публичный адрес для postmypost.
 */
export async function savePostImage({ postId, buffer, contentType, sourceUrl }) {
  const month = monthDir();
  const dir = path.join(config.mediaDir, month);
  await mkdir(dir, { recursive: true });

  // Имя со временем: повторная генерация обложки для того же поста не затирает прежнюю,
  // а браузер не показывает старую картинку из кеша по прежнему адресу.
  const name = `post-${postId}-${Date.now()}${extensionFor(contentType, sourceUrl)}`;
  const absolute = path.join(dir, name);
  await writeFile(absolute, buffer);

  const relative = `${month}/${name}`;
  const url = `${config.publicBaseUrl.replace(/\/+$/, '')}/media/${relative}`;

  logger.info(
    { пост: postId, путь: absolute, байт: buffer.length, url },
    `Обложка сохранена: ${absolute} (${Math.round(buffer.length / 1024)} КБ)`,
  );

  return { path: absolute, relative, url, bytes: buffer.length };
}

export function mediaRoot() {
  return config.mediaDir;
}

/**
 * Публичный адрес обложки поста — собирается из `PUBLIC_BASE_URL` и пути файла на диске,
 * а не берётся из `posts.image_url` как есть.
 *
 * Зачем так: в `image_url` записан адрес на момент генерации. В dev это `localhost`,
 * на проде — домен. Сборка на лету означает, что смена одной переменной (этап 12 или
 * временный туннель для проверки) сразу лечит все уже сгенерированные посты, без UPDATE
 * по таблице. `image_url` остаётся как след того, куда картинка отдавалась изначально.
 */
export function publicUrlFor(post) {
  const base = config.publicBaseUrl.replace(/\/+$/, '');
  const filePath = post?.image_path;
  if (filePath) {
    const relative = path.relative(config.mediaDir, filePath).split(path.sep).join('/');
    // Файл вне mediaDir (path.relative начнётся с '..') — доверяем сохранённому URL.
    if (relative && !relative.startsWith('..')) return `${base}/media/${relative}`;
  }
  if (!post?.image_url) return null;
  // Запасной путь: подменяем только основу сохранённого адреса.
  const tail = post.image_url.replace(/^https?:\/\/[^/]+/, '');
  return `${base}${tail}`;
}
