import * as pmp from '../lib/postmypost.js';
import { publicUrlFor, publicBaseReachable } from '../lib/media.js';
import * as groups from '../repo/groups.js';
import * as posts from '../repo/posts.js';
import * as publications from '../repo/publications.js';
import * as settings from '../repo/settings.js';
import { config } from '../config.js';
import { captureError } from './capture-error.js';
import { getRequestId } from '../context.js';
import { log, errFields } from '../logger.js';

const logger = log('публикация');

/**
 * Публикация поста в группы ВК через postmypost.
 *
 * Три вещи, которые задают форму этого кода:
 *
 * 1. **Картинка заливается один раз.** `file_id` живёт в проекте postmypost и годится
 *    для любого числа групп, поэтому он сохраняется в `publications` и переиспользуется
 *    при следующей группе и при повторе после сбоя.
 * 2. **Состояние аккаунта проверяется до попытки.** У ВК токен подключения истекает
 *    (по брифу — раз в три месяца), и без проверки клиент видел бы невнятную ошибку
 *    от API вместо «группа отвалилась, переподключите в postmypost».
 * 3. **Сбой одной группы не роняет остальные.** Каждая группа — своя публикация,
 *    своя строка в `publications`, своя ошибка.
 * 4. **Дневной лимит группы соблюдается здесь, а не только в планировщике.** `posts_per_day`
 *    задаёт клиент в разделе «Группы», и значение должно работать сразу — иначе поле
 *    в панели врёт до этапа 8. Считаются успешные публикации за сегодня по МСК.
 *
 * Режим по умолчанию — `draft` (черновик, настройка `publish_mode`): на стену ничего
 * не уходит, но результат виден в интерфейсе postmypost. `live` включается осознанно.
 */

/**
 * @param {object} post строка posts (нужны id, title, body, image_url)
 * @param {object} [options]
 * @param {number[]} [options.groupIds] куда публиковать; по умолчанию — все активные группы
 * @param {'draft'|'live'} [options.mode] переопределить режим из настроек
 * @param {Date|number} [options.postAt] время публикации; по умолчанию «через N минут»
 * @param {boolean} [options.ignoreDailyLimit] опубликовать сверх `posts_per_day` (ручной режим)
 */
export async function publishPost(post, { groupIds, mode, postAt, ignoreDailyLimit = false } = {}) {
  if (!post) throw new Error('Пост не передан');
  if (!post.image_url) {
    throw new Error(`У поста #${post.id} нет обложки — сначала сгенерируйте картинку`);
  }
  if (post.status === 'failed') {
    throw new Error(`Пост #${post.id} помечен как сбойный, публиковать его нельзя`);
  }

  const publishMode = (mode ?? (await settings.get('publish_mode', 'draft'))) === 'live'
    ? 'live'
    : 'draft';
  const pmpStatus = publishMode === 'live' ? pmp.STATUS_QUEUED : pmp.STATUS_DRAFT;
  const pollMs = await settings.getInt('pmp_upload_poll_ms', 3000);
  const waitMs = await settings.getInt('pmp_upload_wait_ms', 120_000);
  const delayMinutes = await settings.getInt('publish_delay_minutes', 3);
  const requestId = getRequestId() ?? null;

  const targets = groupIds?.length ? await groups.findByIds(groupIds) : await groups.listActive();
  if (targets.length === 0) {
    throw new Error(
      'Нет групп для публикации. Обновите список групп из postmypost и включите нужные.',
    );
  }

  // Состояние подключения берём живым запросом, а не из БД: строка могла быть
  // синхронизирована неделю назад, а токен ВК истёк вчера.
  const accounts = new Map((await pmp.postingAccounts()).map((item) => [String(item.id), item]));

  const when = postAt ?? Date.now() + delayMinutes * 60_000;
  const postAtIso = pmp.moscowIso(when);

  // Заливка ровно одна на пост: если file_id уже известен, повторно картинку не грузим.
  let fileId = await publications.fileIdForPost(post.id);
  const reused = Boolean(fileId);
  if (!fileId) {
    // Проверка до заливки: локальный адрес postmypost не откроет, и вместо понятной
    // причины мы получили бы «422 Не удалось загрузить файл по ссылке».
    const reachable = publicBaseReachable();
    if (!reachable.ok && !usingLocalPmpStub()) throw new Error(reachable.hint);

    // Адрес собирается заново из PUBLIC_BASE_URL: сохранённый в posts.image_url мог быть
    // записан, когда система жила на другом адресе (dev → туннель → домен на проде).
    const imageUrl = publicUrlFor(post) ?? post.image_url;
    const upload = await pmp.uploadImage(imageUrl, { pollMs, waitMs });
    fileId = upload.fileId;
  } else {
    logger.info(
      { пост: post.id, file_id: fileId },
      `Картинка поста #${post.id} уже залита в postmypost (file_id ${fileId}) — заливаем один раз`,
    );
  }

  const done = [];
  const failed = [];

  for (const group of targets) {
    const account = accounts.get(String(group.pmp_account_id));
    try {
      // Выключенная группа не получает посты — ни в прогоне, ни при явном выборе
      // в панели. Иначе переключатель «включена/выключена» ничего не значил бы.
      if (!group.is_active) {
        throw new Error(
          `Группа «${group.name}» выключена в разделе «Группы» — посты в неё не уходят`,
        );
      }
      if (!account) {
        throw new Error(
          `Группа «${group.name}» (аккаунт ${group.pmp_account_id}) не найдена в postmypost — ` +
            'возможно, её удалили из проекта. Обновите список групп.',
        );
      }
      if (Number(account.connection_status) !== pmp.CONNECTION_OK) {
        await groups.setConnectionStatus(group.id, account.connection_status ?? null);
        throw new Error(
          `Аккаунт группы «${group.name}» отключён в postmypost ` +
            `(connection_status ${account.connection_status ?? '—'}). ` +
            'Переподключите группу в postmypost и повторите.',
        );
      }
      await groups.setConnectionStatus(group.id, account.connection_status);

      // Дневной лимит группы. Считается на день слота (`post_at`), а не на сегодня:
      // наполнение из архива создаёт публикации пачкой, но расписывает их на разные дни,
      // и лимит должен ограничивать стену в конкретный день, а не темп создания.
      // Уже опубликованный в эту группу пост лимит не расходует повторно: повтор
      // обновляет ту же строку в publications, а не добавляет новую.
      if (!ignoreDailyLimit) {
        const limit = Number(group.posts_per_day);
        const alreadyThatDay = await groups.publishedOn(group.id, when);
        const isRepeat = await publications.isPublished(post.id, group.id);
        if (!isRepeat && alreadyThatDay >= limit) {
          const dayText = new Date(when).toLocaleDateString('ru-RU');
          throw new Error(
            `Дневной лимит группы «${group.name}» исчерпан: ${alreadyThatDay} из ${limit} ` +
              `на ${dayText}. Поменяйте «постов в день» в разделе «Группы» или выберите другой день.`,
          );
        }
      }

      const publication = await pmp.createPublication({
        accountId: group.pmp_account_id,
        content: post.body,
        fileIds: [fileId],
        postAt: postAtIso,
        status: pmpStatus,
      });

      const row = await publications.record({
        postId: post.id,
        groupId: group.id,
        pmpPublicationId: publication.id,
        pmpFileId: fileId,
        postAt: postAtIso,
        pmpStatus: publication.status,
        mode: publishMode,
        requestId,
      });

      done.push({ group, publication, row });
      logger.info(
        {
          пост: post.id,
          группа: group.name,
          аккаунт: group.pmp_account_id,
          публикация: publication.id,
          режим: publishMode,
          post_at: postAtIso,
          file_id: fileId,
        },
        `Пост #${post.id} → «${group.name}»: публикация ${publication.id} ` +
          `(${publishMode === 'live' ? 'реальная' : 'черновик'}) на ${postAtIso}`,
      );
    } catch (error) {
      await publications.recordError({
        postId: post.id,
        groupId: group.id,
        message: error.message,
        mode: publishMode,
        requestId,
        pmpFileId: fileId,
      });
      await captureError('публикация', error, {
        service: 'postmypost',
        postId: post.id,
        groupId: group.id,
      });
      failed.push({ group, error });
      logger.error(
        { пост: post.id, группа: group.name, ...errFields(error) },
        `Пост #${post.id} не ушёл в «${group.name}»: ${error.message}`,
      );
    }
  }

  // Пост считается опубликованным, если уехал хоть куда-то: тема закрыта, повторно
  // генерировать её не надо. Провалившиеся группы видны в publications.
  if (done.length > 0) await posts.markPublished(post.id);

  const result = {
    postId: post.id,
    mode: publishMode,
    fileId,
    fileReused: reused,
    postAt: postAtIso,
    published: done,
    failed,
  };

  if (done.length === 0) {
    const reasons = failed.map((item) => `${item.group.name}: ${item.error.message}`).join('; ');
    const aggregate = new Error(reasons || 'Публикация не удалась ни в одну группу');
    // Сбой по каждой группе уже записан в журнал выше — вместе с сервисом, телом
    // ответа и номером группы. Эта ошибка только сводная: без пометки прогон записал бы
    // её вторым, более бедным дублем.
    aggregate.captured = failed.length > 0;
    throw aggregate;
  }
  return result;
}

/**
 * Работаем ли против локальной заглушки postmypost. Ей `localhost` в адресе картинки
 * не мешает: она ничего не скачивает, а проверять цикл на заглушке нужно уметь.
 */
export function usingLocalPmpStub() {
  return /(^|\/\/)(localhost|127\.0\.0\.1)/.test(config.postmypost.baseUrl);
}

/** Первый готовый пост с обложкой → в группы. Кнопка в панели, дальше cron (этап 8). */
export async function publishNext(options = {}) {
  const post = await posts.nextForPublishing();
  if (!post) throw new Error('Нет готовых постов с обложкой, ожидающих публикации');
  return publishPost(post, options);
}
