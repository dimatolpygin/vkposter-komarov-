import * as openrouter from '../lib/openrouter.js';
import { cleanPostText, validatePost, trimBulletLists } from '../lib/text-clean.js';
import { projectDisplayName } from '../lib/topic.js';
import { collectMaterial } from './research.js';
import * as prompts from '../repo/prompts.js';
import * as posts from '../repo/posts.js';
import * as articles from '../repo/articles.js';
import * as settings from '../repo/settings.js';
import { captureError } from './capture-error.js';
import { log, errFields } from '../logger.js';
import { getRequestId } from '../context.js';

const logger = log('генерация');

/** Сколько полных провалов генерации терпит один материал, прежде чем уйти из очереди. */
const GIVE_UP_AFTER = 2;

/**
 * Схема ответа модели. В коде живёт только каркас — сам промт целиком в БД и правится
 * клиентом в панели. Формат поста (заголовок отдельно от тела) нужен потому, что
 * в postmypost заголовок отдельным полем не идёт, но нам он нужен для панели и обложки.
 */
const POST_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Короткий цепляющий заголовок поста' },
    body: { type: 'string', description: 'Полный текст поста для стены ВК' },
  },
  required: ['title', 'body'],
  additionalProperties: false,
};

/** Сколько заходов сокращения делаем, прежде чем сдаться. */
const SHRINK_ROUNDS = 3;

/** Сколько исходного текста отдаём модели: больше 12 тысяч символов смысла не добавляет. */
const MAX_SOURCE_CHARS = 12_000;

/**
 * Пользовательская часть запроса. Системная часть — промт клиента из БД, она стабильна
 * и идёт первой (порядок «стабильное начало → переменная часть в конце» — на случай,
 * когда провайдеры включат кеш промта).
 */
function buildUserMessage(article, { researched = false, maxChars = 2200 } = {}) {
  // Название чистим: при обнаружении через sitemap тема равна slug'у адреса
  // («xrp-turbo-io-razoblachenie»), и в промт уходил жанровый хвост. Модель начинала
  // выкручиваться и склоняла «разоблачение» как часть имени проекта.
  const project = projectDisplayName(article.topic_name)
    || article.title
    || article.topic_key;
  const lines = [`Проект: ${project}`];
  if (article.url) lines.push(`Источник: ${article.url}`);

  if (article.content && article.content.trim().length > 200) {
    lines.push(
      '',
      researched
        // Найденное поиском — не одна статья, а выдержки с чужих сайтов. Просить
        // «рерайт» такого текста нельзя: получится пересказ навигации трёх сайтов.
        ? 'Собранная фактура из открытых источников (пиши свой текст по ней, ' +
          'адреса и названия чужих сайтов в пост не переноси):'
        : 'Материал для рерайта (не копировать дословно):',
      '',
      article.content.slice(0, MAX_SOURCE_CHARS),
    );
  } else {
    // Режим «только тема»: у all-comment и scama.net текста нет, статью пишет модель сама.
    lines.push(
      '',
      'Готового материала нет — есть только название проекта и то, что на него поступают ' +
        'жалобы. Напиши обзор-отзыв сам, опираясь на типичные схемы таких проектов. ' +
        'Не выдумывай конкретных сумм, дат и имён, которых не знаешь.',
    );
    if (article.title) lines.push('', `Известно о проекте: ${article.title}`);
  }

  // Лимит длины есть и в промте клиента, но в самом его конце, среди прочих правил,
  // и модель о нём забывает: живой прогон дал подряд 2534, 2918 и 3426 символов.
  // Повтор рядом с задачей стоит одну строку и экономит переделки. При нулевом
  // потолке (ограничение снято) не напоминаем ничего: пусть пишет сколько напишет.
  if (maxChars > 0) {
    lines.push(
      '',
      `Длина поста строго до ${maxChars} символов вместе с рекламным блоком, ` +
        `целься в ${targetChars(maxChars)}. Это жёсткое требование площадки.`,
    );
  }

  return lines.join('\n');
}

/**
 * Указание к переделке. Сам список нарушений модель понимает плохо: на «длинно: 2534
 * символов, нужно до 2200» она возвращает такой же длинный текст три раза подряд —
 * поймано на живом прогоне. Помогает не констатация, а задание: на сколько сократить,
 * за счёт чего и что трогать нельзя.
 */
function fixInstruction(problems, { minChars, maxChars, length }) {
  const lines = [
    'Предыдущий вариант не прошёл проверку. Исправь ровно это и верни пост заново:\n— ' +
      problems.join('\n— '),
  ];
  const tooLong = maxChars > 0 && length > maxChars;
  const tooShort = minChars > 0 && length < minChars;
  if (tooLong) {
    lines.push(
      `Сократи текст на ${length - targetChars(maxChars)} символов и уложись в ${targetChars(maxChars)}. ` +
        'Режь общие рассуждения и повторы, а не факты. Структуру (пункты списка, заключительный блок) ' +
        'и рекламный блок со ссылкой оставь как есть.',
    );
  } else if (tooShort) {
    lines.push(
      `Добавь примерно ${minChars - length + 150} символов по существу проекта: ` +
        'признаки, детали жалоб, что теряет человек. Воду не лей.',
    );
  }
  return lines.join('\n\n');
}

/** Цель по длине: с запасом от потолка, иначе модель снова упирается в границу. */
function targetChars(maxChars) {
  return Math.max(200, maxChars - Math.max(100, Math.round(maxChars * 0.05)));
}

/**
 * Последняя попытка спасти пост, который забракован ТОЛЬКО длиной. Отдельный вызов
 * с одной задачей «сократи» работает там, где переписывание с нуля не помогает:
 * модель уже не сочиняет заново, а режет готовый текст.
 */
async function shrinkBody(body, { maxChars, temperature, serviceTier }) {
  const target = targetChars(maxChars);
  // Доля, а не только абсолютное число: «убери примерно четверть текста» модель
  // выполняет заметно точнее, чем «уложись в 2090 символов» — считать символы она
  // не умеет и на голое число отвечает текстом прежней длины.
  const cutPercent = Math.max(10, Math.round((1 - target / body.length) * 100));
  const result = await openrouter.chat({
    messages: [
      {
        role: 'system',
        content:
          'Ты редактор. Сокращаешь готовый пост, ничего не дописывая и не выдумывая. ' +
          'Сохраняешь структуру, пункты списка, заключительный блок и рекламный блок со ссылкой ' +
          'дословно. Убираешь только повторы и общие рассуждения.',
      },
      {
        role: 'user',
        content:
          `Сократи этот текст примерно на ${cutPercent} процентов: сейчас ${body.length} ` +
          `символов, нужно около ${target}. Каждое предложение сделай короче, ` +
          'оставь по три пункта в каждом списке. Рекламный блок в конце и заключительный блок ' +
          `сохрани полностью.\n\n${body}`,
      },
    ],
    schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false },
    schemaName: 'vk_post_short',
    temperature: Math.min(temperature, 0.4),
    maxTokens: 1800,
    serviceTier,
  });
  return { body: cleanPostText(result.data?.body ?? ''), result };
}

/**
 * Ссылка рекламного блока из активного промта.
 *
 * Раньше ссылка жила отдельной настройкой `ad_link`, и это стоило клиенту дней работы:
 * 11 августа он поменял в промте адрес сайта на приглашение в телеграм, настройка
 * осталась прежней, и валидация браковала каждый пост с формулировкой «нет рекламного
 * блока со ссылкой https://proverka-zarabotka.online» — при том что блок в тексте был.
 * Правда о ссылке одна и лежит там же, где сам блок: в промте. Настройка остаётся
 * запасным значением на случай, если в промте ссылки нет вовсе.
 *
 * Берём именно ссылку внутри блока между рядами дефисов: в остальном тексте промта
 * могут стоять адреса-примеры, и принять их за рекламные нельзя.
 */
export function adLinkFromPrompt(promptBody) {
  if (!promptBody) return null;
  const lines = String(promptBody).split('\n');
  const isSeparator = (line) => /^\s*-{4,}\s*$/.test(line);

  let inside = false;
  for (const line of lines) {
    if (isSeparator(line)) { inside = !inside; continue; }
    if (!inside) continue;
    const found = line.match(/https?:\/\/[^\s)\]"'<>]+/);
    // Хвостовой слэш и знаки препинания режем: в промте ссылка обычно записана
    // markdown-ссылкой «[адрес](адрес/)», а в готовом посте остаётся голый адрес
    // без слэша, и точное сравнение со слэшем не сошлось бы.
    if (found) return found[0].replace(/[.,;:!?)\]]+$/, '').replace(/\/+$/, '');
  }
  return null;
}

/**
 * Рекламный блок клиента из активного промта: строки вокруг ссылки, ограниченные
 * рядами дефисов.
 *
 * Блок неизменный и дословный, поэтому забытый моделью блок — не повод переписывать
 * пост и класть в журнал ошибку: его достаточно дописать. Берём его из промта, а не
 * из отдельной настройки, чтобы правка промта клиентом не разъезжалась с кодом.
 */
export function adBlockFromPrompt(promptBody, adLink) {
  if (!promptBody || !adLink) return null;
  const lines = String(promptBody).split('\n');
  const isSeparator = (line) => /^\s*-{4,}\s*$/.test(line);

  // Ищем ссылку ТОЛЬКО внутри блока между рядами дефисов. Раньше бралось первое
  // вхождение в промте — а клиент упоминает ссылку и выше по тексту («после краткого
  // описания проекта добавляй рекламный блок: …»), поиск границ упирался в начало
  // файла и функция возвращала null. Из-за этого страховка «дописать забытый блок»
  // на живом промте не срабатывала ни разу.
  let inside = false;
  let from = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isSeparator(lines[i])) {
      if (!inside) { inside = true; from = i + 1; continue; }
      inside = false;
      const block = lines.slice(from, i);
      if (block.some((line) => line.includes(adLink))) {
        // Через ту же чистку, что и текст поста: в промте ссылка записана
        // markdown-ссылкой, а в посте она должна остаться голым адресом.
        return cleanPostText(['--------', ...block, '------'].join('\n'));
      }
      continue;
    }
  }
  return null;
}

/**
 * Спасение поста, забракованного ТОЛЬКО отсутствием названия проекта в первом абзаце.
 *
 * Случай тот же по смыслу, что и перебор по длине: текст правильный целиком, претензия
 * ровно одна и правится одной фразой. Переписывать пост с нуля из-за этого — терять
 * оплаченную генерацию и класть в журнал ошибку, которой клиент не может ничего
 * противопоставить. Просим вписать название в зачин, остальное не трогая.
 */
async function nameInLead(body, projectName, { temperature, serviceTier }) {
  const result = await openrouter.chat({
    messages: [
      {
        role: 'system',
        content:
          'Ты редактор. Правишь готовый пост минимально: меняешь только первый абзац, ' +
          'остальной текст, пункты списков, заключительный блок и рекламный блок переносишь дословно. ' +
          'Ничего не выдумываешь и не дописываешь от себя.',
      },
      {
        role: 'user',
        content:
          `В первом абзаце должно прямо звучать название проекта: «${projectName}». ` +
          'Перепиши только первый абзац так, чтобы название стояло в нём в именительном ' +
          'падеже, а смысл и длина остались прежними. Остальной текст верни без ' +
          `изменений.\n\n${body}`,
      },
    ],
    schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false },
    schemaName: 'vk_post_lead',
    temperature: Math.min(temperature, 0.4),
    maxTokens: 2400,
    serviceTier,
  });
  return { body: cleanPostText(result.data?.body ?? ''), result };
}

/**
 * Генерация поста по материалу.
 *
 * Повторы нужны не из-за сети (это забота http-client), а из-за качества: модель
 * регулярно отдаёт текст короче минимума или забывает рекламный блок. Валидация
 * возвращает список нарушений, и они передаются модели следующей попыткой —
 * это работает заметно лучше, чем просто повторить тот же запрос.
 *
 * @returns {Promise<object>} строка из posts
 */
export async function generatePost(article, { interactive = false } = {}) {
  const requestId = getRequestId() ?? 'no-rid';
  const prompt = await prompts.getActive('post_prompt');
  if (!prompt) throw new Error('В БД нет активного промта post_prompt');

  const minChars = await settings.getInt('post_min_chars', 1200);
  const maxChars = await settings.getInt('post_max_chars', 2200);
  const maxAttempts = await settings.getInt('generation_attempts', 3);
  // Ссылка рекламного блока — из активного промта; настройка `ad_link` только запасная
  // (см. adLinkFromPrompt: разъезд промта и настройки уже стоил клиенту дня публикаций).
  const adLink = adLinkFromPrompt(prompt.body)
    ?? (await settings.get('ad_link', 'https://proverka-zarabotka.ru'));
  const temperature = Number(await settings.get('openrouter_temperature', '0.85'));
  const maxTokens = await settings.getInt('openrouter_max_tokens', 1800);
  // flex вдвое дешевле, но может ждать в очереди — для крона это нормально.
  // Когда генерацию дёрнул человек из панели и ждёт ответ, берём priority.
  const serviceTier = interactive ? 'priority' : await settings.get('openrouter_service_tier', 'flex');

  const rules = { minChars, maxChars, adLink, topicName: article.topic_name || article.title };

  // Сбор материала поиском (этап 13). Идёт ДО генерации и только когда режим это
  // разрешает: у тем без своей статьи иначе получается обзор «вообще», без фактов
  // про конкретный проект. Не нашлось или упало — работаем как раньше, по теме.
  const research = await collectMaterial(article);
  const material = research ? { ...article, content: research.text } : article;
  const userMessage = buildUserMessage(material, { researched: Boolean(research), maxChars });

  let lastProblems = [];
  let lastError;
  let lastResult;
  let lastBody = '';
  let lastTitle = '';

  const savePost = async (title, body, result, attempt) => {
    const saved = await posts.create({
      articleId: article.id,
      title: title || article.topic_name || 'Без заголовка',
      body,
      model: result.model,
      provider: result.provider,
      promptVersion: prompt.version,
      tokensIn: result.usage?.prompt_tokens ?? null,
      tokensOut: result.usage?.completion_tokens ?? null,
      costUsd: result.usage?.cost ?? null,
      latencyMs: result.latencyMs,
      attempts: attempt,
      topicKey: article.topic_key,
      requestId,
    });
    await posts.markArticleQueued(article.id);
    logger.info(
      {
        пост: saved.id,
        материал: article.id,
        тема: article.topic_key,
        символов: body.length,
        попыток: attempt,
        модель: result.model,
      },
      `Пост #${saved.id} готов: ${body.length} символов, попыток ${attempt}, модель ${result.model}`,
    );
    return saved;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const messages = [
      { role: 'system', content: prompt.body },
      { role: 'user', content: userMessage },
    ];
    if (lastProblems.length > 0) {
      messages.push({
        role: 'user',
        content: fixInstruction(lastProblems, { minChars, maxChars, length: lastBody.length }),
      });
    }

    try {
      const result = await openrouter.chat({
        messages,
        schema: POST_SCHEMA,
        schemaName: 'vk_post',
        temperature,
        maxTokens,
        serviceTier,
        // липкость к одному эндпоинту: стабильная латентность вместо перескоков
        sessionId: `vkposter-post-${article.source_code ?? 'x'}`,
      });
      lastResult = result;

      const title = cleanPostText(result.data?.title ?? '').split('\n')[0];
      const body = cleanPostText(result.data?.body ?? '');
      const problems = validatePost(body, rules);

      if (problems.length > 0) {
        lastProblems = problems;
        lastBody = body;
        lastTitle = title;
        logger.warn(
          { материал: article.id, попытка: attempt, символов: body.length, нарушения: problems },
          `Пост не прошёл проверку (попытка ${attempt}/${maxAttempts}): ${problems.join('; ')}`,
        );
        continue;
      }

      return await savePost(title, body, result, attempt);
    } catch (error) {
      lastError = error;
      // 400/401/402/403 повторять бессмысленно — это ключ, кредиты или запрос
      if ([400, 401, 402, 403].includes(error.code)) break;
      logger.warn(
        { материал: article.id, попытка: attempt, ...errFields(error) },
        `Вызов ИИ упал на попытке ${attempt}/${maxAttempts}`,
      );
    }
  }

  // Забытый рекламный блок дописывается кодом: он неизменный и дословный, просить
  // модель повторить его — лишний вызов и лишний повод для брака.
  if (!lastError && lastBody && lastProblems.some((problem) => problem.startsWith('нет рекламного блока'))) {
    const block = adBlockFromPrompt(prompt.body, adLink);
    if (block) {
      const withAd = `${lastBody.trimEnd()}\n\n${block}`;
      const problems = validatePost(withAd, rules);
      if (!problems.some((problem) => problem.startsWith('нет рекламного блока'))) {
        logger.info(
          { материал: article.id, символов: withAd.length },
          'Рекламный блок отсутствовал в ответе модели — дописан из промта',
        );
        lastBody = withAd;
        lastProblems = problems;
        if (problems.length === 0) return await savePost(lastTitle, withAd, lastResult, maxAttempts + 1);
      }
    }
  }

  // Спасение поста, забракованного только длиной. Всё остальное в нём уже правильно:
  // структура, рекламный блок, название проекта. Выбрасывать такой текст и терять тему
  // из-за двух сотен лишних символов расточительно, а отдельный вызов «сократи» решает
  // задачу, с которой не справляется переписывание с нуля.
  const onlyLength = lastProblems.length > 0
    && lastProblems.every((problem) => problem.startsWith('длинно:'));
  if (!lastError && onlyLength && lastBody) {
    try {
      const original = lastBody.length;
      let body = lastBody;
      let result = lastResult;

      // Несколько заходов: модель сокращает, но недостаточно — с 3426 символов
      // за раз получилось 3042. Каждый следующий заход считает долю от новой длины,
      // поэтому текст сходится к лимиту, а не топчется около него.
      for (let round = 1; round <= SHRINK_ROUNDS && body.length > maxChars; round += 1) {
        const shrunk = await shrinkBody(body, { maxChars, temperature, serviceTier });
        if (!shrunk.body || shrunk.body.length >= body.length) break;
        body = shrunk.body;
        result = shrunk.result;
        logger.info(
          { материал: article.id, заход: round, символов: body.length },
          `Сокращение, заход ${round}: ${body.length} символов`,
        );
      }

      // Не помогло словами — убираем лишние пункты списков. Промт просит по три,
      // модель раздаёт по пять-шесть, и перебор обычно именно в них.
      if (body.length > maxChars) {
        const trimmed = trimBulletLists(body);
        if (trimmed.length < body.length) {
          logger.info(
            { материал: article.id, было: body.length, стало: trimmed.length },
            `Лишние пункты списков убраны: ${body.length} → ${trimmed.length} символов`,
          );
          body = trimmed;
        }
      }

      const problems = validatePost(body, rules);
      if (problems.length === 0) {
        logger.info(
          { материал: article.id, было: original, стало: body.length },
          `Пост был длиннее лимита (${original}) — сокращён до ${body.length} символов`,
        );
        return await savePost(lastTitle, body, result, maxAttempts + 1);
      }
      logger.warn(
        { материал: article.id, символов: body.length, нарушения: problems },
        `Сокращение не помогло: ${problems.join('; ')}`,
      );
    } catch (error) {
      logger.warn({ материал: article.id, ...errFields(error) }, 'Сокращение поста упало');
    }
  }

  // Та же логика спасения, но для единственной претензии «нет названия в первом абзаце».
  // На проде это самая частая запись в журнале, и почти всегда — при правильном посте.
  const onlyProject = lastProblems.length > 0
    && lastProblems.every((problem) => problem.startsWith('в первом абзаце нет названия'));
  if (!lastError && onlyProject && lastBody && rules.topicName) {
    try {
      const fixed = await nameInLead(lastBody, rules.topicName, { temperature, serviceTier });
      const problems = fixed.body ? validatePost(fixed.body, rules) : ['пустой ответ'];
      if (problems.length === 0) {
        logger.info(
          { материал: article.id, проект: rules.topicName },
          `Название проекта вписано в первый абзац отдельной правкой («${rules.topicName}»)`,
        );
        return await savePost(lastTitle, fixed.body, fixed.result, maxAttempts + 1);
      }
      logger.warn(
        { материал: article.id, нарушения: problems },
        `Правка первого абзаца не помогла: ${problems.join('; ')}`,
      );
    } catch (error) {
      logger.warn({ материал: article.id, ...errFields(error) }, 'Правка первого абзаца упала');
    }
  }

  const reason = lastError
    ? lastError.message
    : `валидация не прошла за ${maxAttempts} попыток: ${lastProblems.join('; ')}`;
  const failed = await posts.createFailed({
    articleId: article.id,
    title: article.topic_name ?? article.title,
    // Текст последней попытки — чтобы брак можно было посмотреть глазами, а не гадать.
    body: lastBody,
    model: lastResult?.model ?? openrouter.modelChain()[0],
    promptVersion: prompt.version,
    attempts: maxAttempts,
    topicKey: article.topic_key,
    requestId,
    error: reason,
  });
  logger.error({ материал: article.id, пост: failed.id, причина: reason }, `Генерация поста провалилась: ${reason}`);

  // Материал, который бракуется раз за разом, снимается с очереди.
  //
  // Забракованный пост тему не занимает (в очередь материал берётся, пока по нему нет
  // поста со статусом кроме failed), поэтому один неудачный материал возвращался каждый
  // день: жёг по три генерации, забирал слот у нормальной темы и каждый день клал
  // в журнал одну и ту же ошибку. Так материал «Mailbox Quarantine Alert» падал
  // 13, 14 и 15 августа подряд. После второго полного провала признаём его негодным:
  // он уходит в «Отклонённые материалы» с причиной, а слот достаётся другой теме.
  const failedBefore = await posts.countFailedByArticle(article.id);
  if (failedBefore >= GIVE_UP_AFTER) {
    await articles.markFailed(article.id, `текст не прошёл проверку ${failedBefore} раза: ${reason}`);
    logger.warn(
      { материал: article.id, провалов: failedBefore },
      `Материал #${article.id} снят с очереди: ${failedBefore} провала генерации подряд`,
    );
  }
  // Записываем именно `lastError`, если он был: в нём тело ответа провайдера, а в `reason`
  // только текст. Когда провайдер отвечал нормально, а брак дала валидация, сервиса нет.
  await captureError('генерация текста', lastError ?? new Error(reason), {
    service: lastError ? 'openrouter' : null,
    details: lastError ? undefined : `Валидация не прошла: ${lastProblems.join('; ')}`,
    articleId: article.id,
    postId: failed.id,
  });
  // Запись в журнал уже сделана строкой выше. Без этой пометки слот прогона поймает
  // ошибку и запишет её второй раз: в журнале каждая неудачная генерация двоилась,
  // и половина раздела «Ошибки» состояла из пар-близнецов.
  const failure = new Error(reason);
  failure.captured = true;
  throw failure;
}

/** Следующий материал в очереди → пост. Используется кнопкой в панели и cron'ом (этап 9). */
export async function generateNext({ sourceId = null, ...options } = {}) {
  const article = await posts.nextArticleForGeneration(sourceId);
  if (!article) throw new Error('Нет материалов, готовых к генерации');
  return generatePost(article, options);
}
