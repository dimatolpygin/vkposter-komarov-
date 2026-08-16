import * as kie from '../lib/kie.js';
import { savePostImage } from '../lib/media.js';
import * as prompts from '../repo/prompts.js';
import * as posts from '../repo/posts.js';
import * as settings from '../repo/settings.js';
import { captureError } from './capture-error.js';
import { log, errFields } from '../logger.js';

const logger = log('обложка');

/**
 * Обложка поста через kie.ai.
 *
 * Промт обложки — версионный `image_prompt` из панели; в него подставляется тема поста.
 * Плейсхолдеры промта: `{{тема}}` (название проекта) и `{{заголовок}}` (заголовок поста).
 * Если плейсхолдера в промте нет, тема добавляется отдельной строкой — клиент правит
 * промт сам, и молча генерировать картинку «ни о чём» из-за забытых фигурных скобок нельзя.
 */

function fillPrompt(template, { topic, title }) {
  const filled = String(template)
    .replaceAll('{{тема}}', topic)
    .replaceAll('{{topic}}', topic)
    .replaceAll('{{заголовок}}', title ?? topic)
    .replaceAll('{{title}}', title ?? topic);

  if (filled.includes(topic)) return filled;
  return `${filled}\n\nТема обложки: ${topic}`;
}

/**
 * Отказ генератора картинок по контент-политике: задача создана, но модель отказалась
 * рисовать. Тема проекта («развод», «мошенники», имя человека в заголовке) для
 * OpenAI пограничная, и такой отказ прилетает почти ежедневно — 10, 11, 12, 13 и
 * 14 августа подряд. Слот при этом падал целиком, и готовый оплаченный текст оставался
 * без обложки до следующего прогона.
 */
const POLICY_MARKERS = ['content polic', 'violate', 'policy violation', 'safety'];

function blockedByPolicy(error) {
  const text = String(error?.message ?? '').toLowerCase();
  return POLICY_MARKERS.some((marker) => text.includes(marker));
}

/** Нейтральная тема для повтора: без имён и обвинений, но по смыслу та же обложка. */
const NEUTRAL_TOPIC = 'обзор сомнительного интернет-проекта, деловая иллюстрация без текста';

function topicOf(post) {
  return post.topic_name || post.title || post.topic_key || 'обзор проекта';
}

/**
 * @param {object} post строка из posts (нужны id, title, topic_name, image_task_id)
 * @returns {Promise<object>} обновлённая строка поста
 */
export async function generateImageForPost(post) {
  const prompt = await prompts.getActive('image_prompt');
  if (!prompt) throw new Error('В БД нет активного промта image_prompt');

  const aspectRatio = await settings.get('kie_aspect_ratio', '16:9');
  const resolution = await settings.get('kie_resolution', '2K');
  const pollMs = await settings.getInt('kie_poll_ms', 5000);
  const waitMs = await settings.getInt('kie_wait_ms', 300_000);
  const minCredits = await settings.getInt('kie_min_credits', 20);

  const topic = topicOf(post);
  const text = fillPrompt(prompt.body, { topic, title: post.title });

  try {
    // Проверка остатка ДО задачи: 402 посреди прогона оставляет пост без картинки
    // и выглядит как случайный сбой. Явная ошибка понятнее.
    const left = await kie.credits();
    if (left !== null && left < minCredits) {
      throw new kie.KieError(
        `На kie.ai осталось ${left} кредитов, минимум для генерации ${minCredits}. ` +
          'Пополните баланс аккаунта kie.ai.',
        { code: 402 },
      );
    }
    logger.info({ пост: post.id, кредитов: left, тема: topic }, `Кредитов на kie.ai: ${left ?? '?'}`);

    let result;
    if (post.image_task_id && !post.image_path) {
      // Задача от прошлого прогона уже оплачена — дочитываем её, а не создаём новую.
      logger.warn(
        { пост: post.id, задача: post.image_task_id },
        `У поста #${post.id} есть незавершённая задача ${post.image_task_id} — дочитываем её`,
      );
      result = await kie.waitForTask(post.image_task_id, { pollMs, waitMs });
    } else {
      const start = (value) => kie.generateImage({
        prompt: value,
        aspectRatio,
        resolution,
        pollMs,
        waitMs,
        onTask: (taskId) => posts.setImageTask(post.id, taskId, prompt.version),
      });

      try {
        result = await start(text);
      } catch (error) {
        // Отказ по контент-политике: повторяем один раз с обезличенной темой. Пост
        // и текст уже оплачены, а разница на картинке — только в том, что на ней нет
        // имени проекта. Терять из-за этого весь слот незачем.
        if (!blockedByPolicy(error)) throw error;
        const neutral = fillPrompt(prompt.body, { topic: NEUTRAL_TOPIC, title: NEUTRAL_TOPIC });
        logger.warn(
          { пост: post.id, тема: topic, причина: error.message },
          `Генератор картинок отказал по контент-политике — повтор на обезличенной теме`,
        );
        result = await start(neutral);
      }
    }

    const file = await kie.downloadImage(result.urls[0]);
    const saved = await savePostImage({
      postId: post.id,
      buffer: file.buffer,
      contentType: file.contentType,
      sourceUrl: result.urls[0],
    });

    const updated = await posts.setImage(post.id, {
      url: saved.url,
      path: saved.path,
      credits: result.creditsConsumed,
      latencyMs: result.latencyMs,
    });

    logger.info(
      {
        пост: post.id,
        задача: result.taskId,
        ms: result.latencyMs,
        кредитов: result.creditsConsumed,
        файл: saved.path,
        url: saved.url,
      },
      `Обложка поста #${post.id} готова: задача ${result.taskId}, ` +
        `${Math.round(result.latencyMs / 1000)} c, файл ${saved.path}`,
    );
    return updated;
  } catch (error) {
    // Провалившуюся задачу забываем: дочитывать нечего, а её id заблокировал бы
    // все следующие попытки. Таймаут — другое дело, там id остаётся.
    await posts.setImageError(post.id, error.message, { clearTask: error.taskDead === true });
    await captureError('генерация обложки', error, { service: 'kie.ai', postId: post.id });
    logger.error(
      { пост: post.id, тема: topic, ...errFields(error) },
      `Обложка поста #${post.id} не сделана: ${error.message}`,
    );
    throw error;
  }
}

/** Первый готовый пост без обложки → картинка. Кнопка в панели и cron (этап 9). */
export async function generateImageForNext() {
  const post = await posts.nextWithoutImage();
  if (!post) throw new Error('Нет готовых постов без обложки');
  return generateImageForPost(post);
}
