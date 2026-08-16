import { deflateSync } from 'node:zlib';
import { Router } from 'express';
import { config } from '../../config.js';
import { request, HttpError } from '../../lib/http-client.js';
import { getRequestId } from '../../context.js';
import { log, errFields } from '../../logger.js';

const logger = log('отладка');

/**
 * Только для dev. Нужен для приёмки этапа 0: даёт воспроизвести ошибку внешнего запроса
 * и убедиться, что в лог попали статус, тело ответа и request-id.
 * В production этот роутер не подключается (см. app.js).
 */
export function debugRouter() {
  const router = Router();

  // Заглушка провайдера: отдаёт заданный статус с телом. Локальная, чтобы проверка
  // не зависела от доступности внешних сервисов из контейнера.
  router.all('/_debug/echo/:status', (req, res) => {
    const status = Number.parseInt(req.params.status, 10) || 500;
    res
      .status(status)
      .json({ error: 'Заглушка провайдера', status, message: `Сымитирован ответ ${status}` });
  });

  // GET /_debug/http?status=503 — прогон через http-client с ретраями по локальной заглушке.
  // GET /_debug/http?url=... — произвольный URL.
  router.get('/_debug/http', async (req, res) => {
    const status = req.query.status ?? '503';
    const url =
      req.query.url ?? `http://127.0.0.1:${config.http.port}/_debug/echo/${encodeURIComponent(status)}`;
    const retries = Number.parseInt(req.query.retries ?? '1', 10);

    try {
      const body = await request(url, { label: 'отладка', retries, timeoutMs: 8000 });
      res.json({ ok: true, request_id: getRequestId(), body: String(body).slice(0, 300) });
    } catch (error) {
      logger.error(errFields(error), 'Отладочный внешний запрос упал — так и задумано');
      res.status(502).json({
        ok: false,
        request_id: getRequestId(),
        status: error instanceof HttpError ? error.status : null,
        body: error instanceof HttpError ? String(error.body).slice(0, 300) : null,
        message: error.message,
      });
    }
  });

  /**
   * Заглушка OpenRouter: OpenAI-совместимый /chat/completions с телом, которое проходит
   * (или намеренно не проходит) валидацию поста.
   *
   * Зачем: конвейер генерации нужно проверять целиком — промт из БД, схема, постобработка,
   * валидация, повторы, запись в posts — не расходуя кредиты и не завися от того, жив ли
   * провайдер. Подключается через OPENROUTER_BASE_URL=http://127.0.0.1:3000/_debug/openrouter.
   *
   * Режим задаётся сегментом пути, потому что клиент дописывает `/chat/completions`
   * к baseUrl и query-строка до него не доживёт:
   *   .../_debug/openrouter/fail2/chat/completions   первые 2 вызова отдают 503 (ретраи)
   *   .../_debug/openrouter/invalid1/chat/completions первый вызов не проходит валидацию
   *   .../_debug/openrouter/dirty/chat/completions    текст с markdown и тире в предложениях
   * Флаги можно сочетать через дефис: `fail1-invalid1-dirty`.
   */
  let debugCalls = 0;
  router.post(['/_debug/openrouter/chat/completions', '/_debug/openrouter/:flags/chat/completions'],
    (req, res) => {
    debugCalls += 1;
    const flags = String(req.params.flags ?? '');
    const failFirst = Number.parseInt(flags.match(/fail(\d+)/)?.[1] ?? '0', 10);
    const invalidFirst = Number.parseInt(flags.match(/invalid(\d+)/)?.[1] ?? '0', 10);
    const dirty = flags.includes('dirty');

    if (debugCalls <= failFirst) {
      logger.warn({ вызов: debugCalls }, 'Заглушка ИИ: отдаём 503, ожидается повтор');
      return res.status(503).json({ error: { code: 503, message: 'Заглушка: провайдер недоступен' } });
    }

    const project = String(req.body?.messages?.[1]?.content ?? '')
      .match(/Проект:\s*(.+)/)?.[1]
      ?.trim() ?? 'Проект';
    const invalid = debugCalls <= failFirst + invalidFirst;
    const post = invalid ? shortStubPost(project) : stubPost(project, dirty);

    // Заглушка подтверждает, что до модели дошёл именно промт из БД: если в него
    // добавить строку «[[маркер:ТЕКСТ]]», текст попадёт в заголовок поста. Так проверяется
    // критерий «правка промта в панели меняет следующую генерацию без перезапуска».
    const systemPrompt = String(req.body?.messages?.[0]?.content ?? '');
    const marker = systemPrompt.match(/\[\[маркер:([^\]]+)\]\]/)?.[1];
    if (marker && !invalid) post.title = `${marker.trim()} ${post.title}`;

    logger.info(
      {
        вызов: debugCalls,
        модели: req.body?.models,
        схема: req.body?.response_format?.json_schema?.name,
        тир: req.body?.service_tier,
        символов_промта: systemPrompt.length,
      },
      `Заглушка ИИ: вызов ${debugCalls}, моделей в запросе ${req.body?.models?.length ?? 0}`,
    );

    return res.json({
      id: `gen-debug-${debugCalls}`,
      model: 'debug/stub-model',
      provider: 'заглушка',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(post) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 700, total_tokens: 1900, cost: 0.000123 },
    });
  });

  router.get(['/_debug/openrouter/key', '/_debug/openrouter/:flags/key'], (req, res) => {
    res.json({ data: { limit: null, limit_remaining: null, usage: 0, label: 'заглушка' } });
  });

  /**
   * Заглушка kie.ai: асинхронный API генерации картинки.
   *
   * Зачем: проверять таймауты, нулевые кредиты и провал задачи на живом провайдере —
   * значит платить кредитами и ждать по минуте за попытку. Подключается через
   * KIE_BASE_URL=http://127.0.0.1:3000/_debug/kie
   *
   * Режим задаётся сегментом пути (клиент дописывает `/jobs/createTask` к baseUrl):
   *   .../_debug/kie/nocredit/...  на /chat/credit отдаёт 0 кредитов
   *   .../_debug/kie/fail2/...     первые 2 запроса создания задачи отдают 503 (ретраи)
   *   .../_debug/kie/hang1/...     первый запрос не отвечает вовсе (таймаут и повтор)
   *   .../_debug/kie/taskfail/...  задача создаётся и проваливается с failMsg
   *   .../_debug/kie/slowtask/...  задача висит в generating (проверка общего таймаута)
   * Флаги сочетаются через дефис.
   */
  let kieCalls = 0;
  const kieTasks = new Map();

  const kiePath = (tail) => [`/_debug/kie${tail}`, `/_debug/kie/:flags${tail}`];
  const kieFlags = (req) => String(req.params.flags ?? '');

  /** Запрос, который не отвечает: так воспроизводится таймаут, а не ошибка провайдера. */
  function hang(req, res) {
    const timer = setTimeout(() => res.status(504).end(), 120_000);
    req.on('close', () => clearTimeout(timer));
  }

  router.get(kiePath('/chat/credit'), (req, res) => {
    const left = kieFlags(req).includes('nocredit') ? 0 : 500;
    res.json({ code: 200, msg: 'success', data: left });
  });

  router.post(kiePath('/jobs/createTask'), (req, res) => {
    kieCalls += 1;
    const flags = kieFlags(req);
    const failFirst = Number.parseInt(flags.match(/fail(\d+)/)?.[1] ?? '0', 10);
    const hangFirst = Number.parseInt(flags.match(/hang(\d+)/)?.[1] ?? '0', 10);

    if (kieCalls <= hangFirst) {
      logger.warn({ вызов: kieCalls }, 'Заглушка kie.ai: не отвечаем, ожидается таймаут и повтор');
      return hang(req, res);
    }
    if (kieCalls <= hangFirst + failFirst) {
      logger.warn({ вызов: kieCalls }, 'Заглушка kie.ai: отдаём 503, ожидается повтор');
      return res.status(503).json({ code: 503, msg: 'Заглушка: провайдер недоступен' });
    }
    if (flags.includes('nocredit')) {
      // HTTP 200 с code 402 — ровно та ловушка, из-за которой проверяем code, а не статус.
      return res.json({ code: 402, msg: 'Insufficient credits' });
    }

    const taskId = `debug-task-${kieCalls}`;
    kieTasks.set(taskId, { polls: 0, flags, prompt: String(req.body?.input?.prompt ?? '') });
    logger.info(
      {
        задача: taskId,
        модель: req.body?.model,
        формат: req.body?.input?.aspect_ratio,
        разрешение: req.body?.input?.resolution,
        символов_промта: String(req.body?.input?.prompt ?? '').length,
      },
      `Заглушка kie.ai: задача ${taskId} создана`,
    );
    return res.json({ code: 200, msg: 'success', data: { taskId, recordId: taskId } });
  });

  router.get(kiePath('/jobs/recordInfo'), (req, res) => {
    const taskId = String(req.query.taskId ?? '');
    const task = kieTasks.get(taskId);
    if (!task) return res.json({ code: 404, msg: `Задачи ${taskId} нет` });

    task.polls += 1;
    if (task.flags.includes('taskfail')) {
      return res.json({
        code: 200,
        msg: 'success',
        data: { taskId, state: 'fail', failCode: 501, failMsg: 'Заглушка: генерация не удалась' },
      });
    }
    // Первый опрос всегда «в работе»: проверяем, что поллинг вообще работает.
    if (task.polls < 2 || task.flags.includes('slowtask')) {
      return res.json({ code: 200, msg: 'success', data: { taskId, state: 'generating' } });
    }

    const base = `http://127.0.0.1:${config.http.port}/_debug/kie/image.png`;
    return res.json({
      code: 200,
      msg: 'success',
      // resultJson — СТРОКА с JSON внутри, как у живого провайдера.
      data: {
        taskId,
        state: 'success',
        resultJson: JSON.stringify({ resultUrls: [`${base}?task=${taskId}`] }),
        creditsConsumed: 6,
        costTime: 42,
      },
    });
  });

  // Картинка-результат: настоящий PNG, собранный на месте, чтобы проверить весь путь
  // «скачали → положили в /media → отдали по публичному URL» без внешней сети.
  router.get(['/_debug/kie/image.png', '/_debug/kie/:flags/image.png'], (req, res) => {
    const png = solidPng(64, 36, [32, 64, 160]);
    res.type('image/png').send(png);
  });

  /**
   * Заглушка postmypost: аккаунты, загрузка картинки, создание и удаление публикации.
   *
   * Зачем: живая проверка публикации создаёт настоящие черновики (а в режиме live —
   * настоящие посты) в чужом проекте клиента, и «проверить обработку сбоя» там нельзя
   * вообще никак. Подключается через
   * POSTMYPOST_BASE_URL=http://127.0.0.1:3000/_debug/pmp
   *
   * Режим задаётся сегментом пути (клиент дописывает `/upload/init` к baseUrl):
   *   .../_debug/pmp/badaccount/...  аккаунты отдают connection_status 0 (отвалились)
   *   .../_debug/pmp/noaccounts/...  групп в проекте нет
   *   .../_debug/pmp/uploadfail/...  загрузка картинки завершается ошибкой (status 2)
   *   .../_debug/pmp/slowupload/...  загрузка вечно в работе (проверка таймаута)
   *   .../_debug/pmp/fail2/...       первые 2 запроса /upload/init отдают 503 (ретраи)
   *   .../_debug/pmp/pubfail/...     создание публикации отдаёт 422 (сбой одной группы)
   *   .../_debug/pmp/delete422/...   удаление отдаёт известный баг 422 при успехе
   *   .../_debug/pmp/vklink/...      публикация отдаёт адрес записи на стене ВК
   * Флаги сочетаются через дефис.
   */
  let pmpUploads = 0;
  let pmpInitCalls = 0;
  let pmpPublications = 0;
  const pmpUploadState = new Map();

  const pmpPath = (tail) => [`/_debug/pmp${tail}`, `/_debug/pmp/:flags${tail}`];
  const pmpFlags = (req) => String(req.params.flags ?? '');

  router.get(pmpPath('/accounts'), (req, res) => {
    const flags = pmpFlags(req);
    if (flags.includes('noaccounts')) return res.json([]);
    const connection = flags.includes('badaccount') ? 0 : 1;
    // Четыре аккаунта: две группы ВК, одна Одноклассников (постим и туда) и Telegram —
    // на нём проверяется, что сети вне списка NETWORKS в панель не попадают.
    return res.json([
      { id: 900001, chanel_id: 2, external_id: '-100001', name: 'Заглушка ВК первая',
        login: 'stub_vk_1', connection_status: connection },
      { id: 900002, chanel_id: 2, external_id: '-100002', name: 'Заглушка ВК вторая',
        login: 'stub_vk_2', connection_status: connection },
      { id: 900004, chanel_id: 5, external_id: '70000000000001', name: 'Заглушка ОК',
        login: null, connection_status: connection },
      { id: 900003, chanel_id: 6, external_id: '@stub', name: 'Заглушка Telegram',
        login: 'stub_tg', connection_status: 1 },
    ]);
  });

  router.post(pmpPath('/upload/init'), (req, res) => {
    pmpInitCalls += 1;
    const flags = pmpFlags(req);
    const failFirst = Number.parseInt(flags.match(/fail(\d+)/)?.[1] ?? '0', 10);
    if (pmpInitCalls <= failFirst) {
      logger.warn({ вызов: pmpInitCalls }, 'Заглушка postmypost: отдаём 503 на upload/init');
      return res.status(503).json([{ message: 'Заглушка: сервис недоступен' }]);
    }
    pmpUploads += 1;
    const id = 13_000 + pmpUploads;
    pmpUploadState.set(id, { polls: 0, flags });
    logger.info(
      { загрузка: id, url: req.body?.url, project_id: req.body?.project_id },
      `Заглушка postmypost: загрузка ${id} начата`,
    );
    // Ответ — массив, как у живого API.
    return res.json([{ id, url: req.body?.url, size: 204_331, status: 5 }]);
  });

  router.get(pmpPath('/upload/status'), (req, res) => {
    const id = Number.parseInt(String(req.query.id ?? ''), 10);
    const state = pmpUploadState.get(id);
    if (!state) return res.status(404).json([{ message: `Загрузки ${id} нет` }]);

    state.polls += 1;
    if (state.flags.includes('uploadfail')) return res.json([{ id, status: 2 }]);
    // Первый опрос всегда «в работе»: проверяем, что поллинг работает.
    if (state.polls < 2 || state.flags.includes('slowupload')) return res.json([{ id, status: 5 }]);
    return res.json([{ id, file_id: 50_000_000 + id, status: 1 }]);
  });

  router.post(pmpPath('/publications'), (req, res) => {
    const flags = pmpFlags(req);
    if (flags.includes('pubfail')) {
      return res.status(422).json([{ message: 'Заглушка: публикация не создана' }]);
    }
    pmpPublications += 1;
    const id = 30_800_000 + pmpPublications;
    logger.info(
      {
        публикация: id,
        аккаунты: req.body?.account_ids,
        статус: req.body?.publication_status,
        post_at: req.body?.post_at,
        файлы: req.body?.details?.[0]?.file_ids,
        символов: String(req.body?.details?.[0]?.content ?? '').length,
      },
      `Заглушка postmypost: публикация ${id} создана`,
    );
    return res.json([{
      id,
      publication_status: req.body?.publication_status,
      post_at: req.body?.post_at,
      account_ids: req.body?.account_ids,
    }]);
  });

  /**
   * Публикация целиком. Нужна разделу «Опубликовано»: адрес записи на стене живой API
   * отдаёт только после реальной публикации, и без флага заглушка ведёт себя так же —
   * ссылки в ответе нет. Флаг `vklink` изображает уже вышедший пост.
   */
  router.get(pmpPath('/publications/:id'), (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const published = pmpFlags(req).includes('vklink');
    return res.json([{
      id,
      publication_status: published ? 1 : 4,
      details: [{
        publication_type: 1,
        ...(published ? { link: `https://vk.com/wall-100001_${id % 10_000}` } : {}),
      }],
    }]);
  });

  router.delete(pmpPath('/publications/:id'), (req, res) => {
    if (pmpFlags(req).includes('delete422')) {
      // Тот самый баг живого API: 422 на валидации ответа, хотя удаление прошло.
      return res.status(422).json([{ message: 'Response validation error: publication_status' }]);
    }
    return res.json([{ id: Number.parseInt(req.params.id, 10), deleted: true }]);
  });

  // GET /_debug/boom — необработанное исключение внутри обработчика (проверка error-handler).
  router.get('/_debug/boom', () => {
    throw new Error('Искусственная ошибка для проверки обработчика');
  });

  return router;
}

/**
 * Однотонный PNG нужного размера. Пишем байты руками, чтобы не тащить зависимость:
 * заглушке важно отдать валидный PNG, а не красивую картинку.
 */
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // тип фильтра строки
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Текст, повторяющий формат из промта клиента. Длина попадает в 1200–2200 символов. */
function stubPost(project, dirty) {
  const dash = dirty ? ' — ' : ' ';
  const bold = (text) => (dirty ? `**${text}**` : text);
  const body = [
    `Хочу оставить плохой отзыв на ${project}. Обещали лёгкий доход, а на деле люди остались`,
    `без денег и без ответов. Разбираем по порядку, что там${dash}не так, и почему заходить туда`,
    'сейчас опасно для кошелька.',
    '',
    `🔰 Важно знать: что предлагает ${bold(project)}`,
    '— обещают доход от 30% в месяц без опыта и без рисков, что уже само по себе сигнал;',
    '— просят пополнить счёт «для разгона депозита», сумма растёт с каждым разговором;',
    '— на вопросы про документы и лицензию отвечают уклончиво или блокируют в чате;',
    '— отзывы в открытых источниках однотипные, написаны под копирку в один день.',
    '',
    '❗️ Вас могут обмануть? Проверьте эти признаки',
    `— вывод денег${dash}постоянно «в обработке», а поддержка просит подождать ещё немного;`,
    '— требуют доплату за «страховку перевода» или «налог» перед выплатой;',
    '— куратор давит на срочность: акция кончается, место в группе последнее;',
    '— реальных контактов и адреса нет, только мессенджер и красивый сайт.',
    '',
    'Итог:',
    `Схема с ${project} рабочая только в одну сторону${dash}в сторону организаторов. Деньги`,
    'заходят легко, а выходят никогда. Если вас уже втянули, прекращайте пополнения и',
    'фиксируйте переписку. Чем раньше остановитесь, тем меньше потеряете.',
    '',
    '--------',
    '❗️В отличие от мошенников, есть и честные люди!',
    '✅Вот проверенный проект без обмана — он принес нам 386 700 рублей: https://proverka-zarabotka.online',
    '------',
  ].join('\n');
  return { title: `${project}: отзывы и разбор схемы`, body };
}

/** Намеренно негодный вариант: коротко, без слова «отзыв» и без рекламного блока. */
function shortStubPost(project) {
  return { title: project, body: `Небольшой текст про ${project} без нужных элементов.` };
}
