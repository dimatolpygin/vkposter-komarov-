import { Router } from 'express';
import { requireAuth } from '../../auth/middleware.js';
import { page, esc } from '../views/layout.js';
import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import * as sources from '../../repo/sources.js';
import * as settings from '../../repo/settings.js';
import * as articles from '../../repo/articles.js';
import * as prompts from '../../repo/prompts.js';
import * as posts from '../../repo/posts.js';
import * as groups from '../../repo/groups.js';
import * as publications from '../../repo/publications.js';
import * as runs from '../../repo/runs.js';
import * as appErrors from '../../repo/errors.js';
import { checkSource } from '../../services/check-source.js';
import { buildPlan } from '../../services/plan-run.js';
import { startCycleInBackground, runningSince, lastBackgroundError } from '../../services/run-cycle.js';
import { nextRunAt, isRunDue, scheduleText } from '../../lib/schedule.js';
import { generatePost } from '../../services/generate-post.js';
import { generateImageForPost } from '../../services/generate-image.js';
import { publishPost } from '../../services/publish-post.js';
import { syncGroups } from '../../services/sync-groups.js';
import { createManualPost, inspect as inspectManual } from '../../services/manual-post.js';
import { schedulerState } from '../../services/scheduler.js';
import { archiveState, startArchiveFill, stopArchiveFill } from '../../services/archive-fill.js';
import * as kie from '../../lib/kie.js';
import * as pmp from '../../lib/postmypost.js';
import { log, errFields } from '../../logger.js';

const logger = log('панель');

/** Виды прогонов — фильтры в разделе «Прогоны» и подписи в таблицах. */
const KNOWN_RUN_KINDS = ['cron', 'manual', 'backfill', 'source_check', 'archive'];

export function panelRouter() {
  const router = Router();
  router.use(requireAuth());

  // ── Обзор ────────────────────────────────────────────────────────────────
  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await query(`
        SELECT
          (SELECT count(*) FROM sources WHERE is_active)   AS sources_active,
          (SELECT count(*) FROM sources)                   AS sources_total,
          (SELECT count(*) FROM groups
            WHERE is_active AND deleted_at IS NULL)        AS groups_active,
          (SELECT count(*) FROM articles)                  AS articles,
          (SELECT count(DISTINCT topic_key) FROM articles
            WHERE topic_key IS NOT NULL AND status <> 'duplicate') AS topics,
          (SELECT count(*) FROM posts)                     AS posts,
          (SELECT count(*) FROM publications)              AS publications,
          (SELECT count(*) FROM runs)                      AS runs,
          (SELECT count(*) FROM app_errors
            WHERE created_at > now() - interval '24 hours') AS errors_day
      `);
      const s = rows[0];
      const map = await settings.getMap();
      const lastCycle = await runs.lastCycle();
      const next = nextRunAt(map, lastCycle?.started_at ?? map.schedule_enabled_at ?? null);
      // Пропущенный момент запуска: расписание сдвинули назад или приложение стояло.
      // `nextRunAt` по определению смотрит вперёд и показал бы завтрашний день, пока
      // планировщик стартует прогон в ближайшую минуту - об этом надо сказать прямо.
      const overdue = map.schedule_enabled === 'on'
        && isRunDue(map, lastCycle?.started_at ?? map.schedule_enabled_at ?? null);

      // Четыре плитки, а не восемь. Восемь равных чисел не отвечали на вопрос
      // «всё ли идёт»: «Источников активно» и «Прогонов» стояли рядом с «Публикациями»
      // и весили столько же. Остальные счётчики — строкой в свёрнутом блоке ниже.
      const body = `
        <div class="grid">
          ${stat(s.publications, 'Публикаций')}
          ${stat(s.posts, 'Постов сгенерировано')}
          ${stat(s.topics, 'Тем в запасе')}
          ${Number(s.errors_day) > 0
            ? (config.diagPath === 'errors'
              // Спрятанный журнал не должен выдавать свой адрес ссылкой с обзора:
              // счётчик сбоев виден, а пройти по нему может только знающий путь.
              ? `<a href="/errors" style="text-decoration:none">${
                stat(s.errors_day, 'Сбоев за сутки')}</a>`
              : stat(s.errors_day, 'Сбоев за сутки'))
            : stat(0, 'Сбоев за сутки')}
        </div>
        <h2>Прогон</h2>
        ${await runCard(lastCycle)}
        <details class="fold">
          <summary>Как система настроена и чем наполнена</summary>
        <div class="card">
          <p style="margin:0 0 14px;display:flex;gap:18px;flex-wrap:wrap">
            ${statLine(`${s.sources_active} из ${s.sources_total}`, 'источников включено')}
            ${statLine(s.groups_active, 'групп включено')}
            ${statLine(s.articles, 'материалов найдено')}
            ${statLine(s.runs, 'прогонов сделано')}
          </p>
          <table>
            <tr><th>Окно свежести</th><td>${esc(map.freshness_window_days)} дней</td></tr>
            <tr><th>Постов в день на группу</th><td>${esc(map.default_posts_per_day)}</td></tr>
            <tr><th>Расписание</th><td>${esc(scheduleText(map))}, автозапуск ${autoTag(map)}</td></tr>
            <tr><th>Следующий запуск</th><td>${
              overdue ? 'в ближайшую минуту' : esc(formatDate(next))}
              <span class="hint">${
                overdue
                  ? 'момент по расписанию уже прошёл, а прогона с тех пор не было — планировщик стартует его сам'
                  : map.schedule_enabled === 'on'
                    ? 'прогон стартует сам, нажимать кнопку не нужно'
                    : 'автозапуск выключен — это время, на которое встанет прогон при запуске кнопкой; включается в «Настройках»'
              }</span></td></tr>
            <tr><th>Окно публикаций</th><td>${esc(map.posting_window_start)}-${
              esc(map.posting_window_end)} МСК, разброс до ${esc(map.slot_jitter_minutes)} мин</td></tr>
            <tr><th>Режим публикации</th><td>${publishModeTag(map.publish_mode)}</td></tr>
            <tr><th>Длина поста</th><td>${esc(postLengthLabel(map))}</td></tr>
          </table>
        </div>
        </details>`;

      res.type('html').send(
        page({
          title: 'Обзор',
          active: '/',
          user: req.user,
          heading: 'Обзор',
          sub: 'Что уже вышло, что уйдёт следующим прогоном.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // ── Источники ────────────────────────────────────────────────────────────
  router.get('/sources', async (req, res, next) => {
    try {
      const list = await sources.listAll();
      const stats = await articles.statsBySource();
      const recent = await articles.listRecent(30);
      const rejected = await articles.listRejected(20);

      const rows = list
        .map((item) => {
          const st = stats.get(item.id) ?? {
            total: 0, with_text: 0, failed: 0, topics: 0, topic_duplicates: 0, skipped: 0,
          };
          return `<tr>
            <td><strong title="${esc(item.notes ?? '')}">${esc(item.title)}</strong>
                <br><span class="hint">${esc(item.base_url)}</span></td>
            <td>${esc(discoveryText(item))}
                <br><span class="hint">${esc(item.content_mode === 'text' ? 'рерайт статьи' : 'только тема')}
                · ${esc(fetchViaText(item.fetch_via))}</span></td>
            <td>${st.total}${
              st.failed ? ` <span class="tag soon">сбоев ${st.failed}</span>` : ''
            }<br><span class="hint">${st.with_text ? `с текстом ${st.with_text} · ` : ''}тем ${
              st.topics ?? 0}${st.topic_duplicates ? ` · дублей ${st.topic_duplicates}` : ''
            }${st.skipped ? ` · служебных ${st.skipped}` : ''}</span></td>
            <td class="hint">${esc(formatDate(item.last_checked_at) || 'ни разу')}</td>
            <td>${item.is_active ? '<span class="tag on">включён</span>' : '<span class="tag off">выключен</span>'}
                <br>${priorityForm(item)}</td>
            <td style="display:flex;gap:6px;flex-wrap:wrap">
              <form class="inline" method="post" action="/sources/${item.id}/check">
                <button class="small" type="submit"${item.is_active ? '' : ' disabled'}>Проверить</button>
              </form>
              <form class="inline" method="post" action="/sources/${item.id}/toggle">
                <button class="ghost small" type="submit">${item.is_active ? 'Выключить' : 'Включить'}</button>
              </form>
            </td>
          </tr>`;
        })
        .join('\n');

      const recentList = recent.length
        ? recent.map(
              (item) => `<tr>
                <td class="hint">${esc(item.source_code)}</td>
                <td>${esc(item.title ?? '(заголовок появится при извлечении)')}
                    <br><a href="${esc(item.url)}" target="_blank" rel="noopener"
                          class="hint">${esc(item.url)}</a></td>
                <td>${topicCell(item)}</td>
                <td class="hint">${esc(formatDate(item.lastmod))}</td>
                <td>${statusTag(item)}</td>
              </tr>`,
          )
        : [];
      const recentClip = clipRows(recentList, { limit: 10, label: 'материалов' });
      const recentRows = recentList.length
        ? recentClip.body
        : '<tr><td colspan="5" class="empty">Пока ничего не найдено. Нажмите «Проверить» у любого источника.</td></tr>';

      const rejectedRows = rejected.length
        ? rejected
            .map(
              (item) => `<tr>
                <td class="hint">${esc(item.source_code)}</td>
                <td><a href="${esc(item.url)}" target="_blank" rel="noopener"
                       class="hint">${esc(item.url)}</a></td>
                <td>${topicCell(item)}</td>
                <td>${item.status === 'duplicate'
                    ? '<span class="tag off">дубль темы</span>'
                    : '<span class="tag off">пропущен</span>'}
                    <span class="hint">${esc(item.skip_reason ?? '')}</span></td>
              </tr>`,
            )
            .join('\n')
        : '<tr><td colspan="4" class="empty">Отклонённых материалов нет.</td></tr>';

      const body = `
        <div class="card">
          <table>
            <thead><tr>
              <th>Источник</th><th>Как берём</th><th>Найдено</th>
              <th>Проверен</th><th>Статус</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            <form method="post" action="/sources/check-all">
              <button type="submit">Проверить все включённые</button>
            </form>
            <form method="post" action="/sources/topics/recompute">
              <button class="ghost" type="submit">Пересчитать темы</button>
            </form>
          </div>
          <p class="hint" style="margin:10px 0 0">
            «Тем» — сколько разных проектов набралось после дедупа. Пересчёт нужен после
            правки правил нормализации названий: заново размечает уже найденные материалы.
          </p>
        </div>

        <h2>Последние найденные материалы</h2>
        <div class="card">
          <table id="${recentClip.id}" class="${recentClip.className.trim()}">
            <thead><tr><th>Источник</th><th>Материал</th><th>Тема</th><th>Дата</th><th>Состояние</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table>
          ${recentClip.toggle}
        </div>

        <details class="fold">
          <summary>Отклонённые материалы: дубли тем и служебные страницы</summary>
        <div class="card">
          <p class="hint" style="margin:0 0 10px">
            Дубль обычно старше «победителя», поэтому в списке выше он не виден —
            причина отклонения показана здесь.
          </p>
          <table>
            <thead><tr><th>Источник</th><th>Материал</th><th>Тема</th><th>Причина отклонения</th></tr></thead>
            <tbody>${rejectedRows}</tbody>
          </table>
        </div>
        </details>`;

      res.type('html').send(
        page({
          title: 'Источники',
          active: '/sources',
          user: req.user,
          heading: 'Источники',
          sub: 'Раздел для исполнителя: новые сайты подключаются с индивидуальной настройкой парсинга.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // Проверка одного источника
  router.post('/sources/:id/check', async (req, res, next) => {
    try {
      const source = await sources.findById(Number.parseInt(req.params.id, 10));
      if (!source) return res.status(404).json({ error: 'Источник не найден' });

      const result = await checkSource(source);
      const summary =
        `${source.code}: найдено ${result.discovered}, новых ${result.added}, ` +
        `дублей URL ${result.duplicates}, дублей темы ${result.topicDuplicates}` +
        (result.listings ? `, служебных страниц ${result.listings}` : '') +
        `, текстов ${result.extracted}` +
        (result.extractFailed ? `, сбоев ${result.extractFailed}` : '') +
        `, ${Math.round(result.ms / 1000)} c`;
      res.redirect(`/sources?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error(errFields(error), 'Проверка источника из панели упала');
      res.redirect(`/sources?err=${encodeURIComponent(error.message)}`);
      return undefined;
    }
  });

  // Проверка всех включённых источников
  router.post('/sources/check-all', async (req, res) => {
    const active = await sources.listActive();
    const parts = [];
    for (const source of active) {
      try {
        const result = await checkSource(source);
        parts.push(`${source.code}: +${result.added} (текстов ${result.extracted})`);
      } catch (error) {
        parts.push(`${source.code}: ошибка — ${error.message}`);
        logger.error({ источник: source.code, ...errFields(error) }, 'Проверка источника упала');
      }
    }
    res.redirect(`/sources?ok=${encodeURIComponent(parts.join('; '))}`);
  });

  // Пересчёт тем у уже найденных материалов (после правки правил нормализации)
  router.post('/sources/topics/recompute', async (req, res) => {
    try {
      const stats = await articles.recomputeTopics();
      const summary =
        `Пересчитано ${stats.processed}: тем ${stats.keyed}, дублей темы ${stats.duplicates}, ` +
        `служебных страниц ${stats.listings}` +
        (stats.unkeyed ? `, без темы ${stats.unkeyed}` : '');
      logger.info({ ...stats, кто: req.user.login }, 'Темы пересчитаны из панели');
      res.redirect(`/sources?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error(errFields(error), 'Пересчёт тем упал');
      res.redirect(`/sources?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/sources/:id/toggle', async (req, res, next) => {
    try {
      const source = await sources.findById(Number.parseInt(req.params.id, 10));
      if (!source) return res.status(404).json({ error: 'Источник не найден' });
      await sources.setActive(source.id, !source.is_active);
      logger.info(
        { источник: source.code, включён: !source.is_active, кто: req.user.login },
        `Источник ${source.code} ${!source.is_active ? 'включён' : 'выключен'}`,
      );
      res.redirect('/sources?ok=1');
    } catch (error) {
      next(error);
    }
  });

  // Очередь источника: меньше число — раньше берём его темы
  router.post('/sources/:id/priority', async (req, res, next) => {
    try {
      const source = await sources.findById(Number.parseInt(req.params.id, 10));
      if (!source) return res.status(404).json({ error: 'Источник не найден' });
      const value = Number.parseInt(req.body.priority, 10);
      if (!Number.isFinite(value) || value < 0 || value > 999) {
        return res.redirect('/sources?err=' + encodeURIComponent('Очередь задаётся числом от 0 до 999'));
      }
      await sources.setPriority(source.id, value);
      logger.info(
        { источник: source.code, очередь: value, кто: req.user.login },
        `Очередь источника ${source.code}: ${value}`,
      );
      res.redirect('/sources?ok=' + encodeURIComponent(`Очередь источника ${source.code} обновлена`));
    } catch (error) {
      next(error);
    }
  });

  // ── Настройки ────────────────────────────────────────────────────────────
  router.get('/settings', async (req, res, next) => {
    try {
      const list = await settings.getAll();
      const rows = list
        .filter((row) => !row.key.endsWith('_prompt'))
        .map(
          (row) => `<tr>
            <td><code>${esc(row.key)}</code><br><span class="hint">${esc(row.title ?? '')}</span></td>
            <td>${esc(row.value)}</td>
            <td class="hint">${esc(formatDate(row.updated_at))}</td>
          </tr>`,
        )
        .join('\n');

      const mode = await settings.get('publish_mode', 'draft');
      const map = await settings.getMap();
      const next = nextRunAt(map, (await runs.lastCycle())?.started_at ?? map.schedule_enabled_at ?? null);
      // Порядок карточек — по частоте обращения, а не по истории появления.
      // Наверху три, которые открывают каждый день; остальное свёрнуто: пять карточек
      // с тонкими настройками стояли вперемешку с ними, и страница читалась как
      // список из двадцати четырёх полей без главного.
      const body = `
        <div class="card">
          <h2 style="margin-top:0">Режим публикации</h2>
          <p style="margin:0 0 10px">Сейчас: ${publishModeTag(mode)}</p>
          <p class="hint" style="margin:0 0 12px">
            В режиме «черновики» посты создаются в postmypost со статусом 4 и на стену
            не уходят — их видно только в интерфейсе postmypost. «Реальная публикация»
            ставит статус 5, и пост появляется в группе ВК в назначенное время.
          </p>
          <form method="post" action="/settings/publish-mode">
            <input type="hidden" name="mode" value="${mode === 'live' ? 'draft' : 'live'}">
            <button ${mode === 'live' ? 'class="ghost"' : ''} type="submit">${
              mode === 'live' ? 'Вернуть режим черновиков' : 'Включить реальную публикацию'
            }</button>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Расписание прогонов</h2>
          <p style="margin:0 0 10px">Автозапуск: ${autoTag(map)}.
            Сейчас: ${esc(scheduleText(map))}. Следующий запуск ${esc(formatDate(next))}.</p>
          <p class="hint" style="margin:0 0 12px">
            Когда автозапуск включён, приложение раз в минуту сверяется с расписанием
            и само запускает прогон - нажимать кнопку не нужно. Прогон тратит деньги
            (текст и обложка), поэтому по умолчанию автозапуск выключен.
          </p>
          <form class="inline" method="post" action="/settings/schedule-enabled"
                style="margin-bottom:12px">
            <input type="hidden" name="enabled" value="${map.schedule_enabled === 'on' ? 'off' : 'on'}">
            <button ${map.schedule_enabled === 'on' ? 'class="ghost"' : ''} type="submit">${
              map.schedule_enabled === 'on' ? 'Выключить автозапуск' : 'Включить автозапуск'
            }</button>
          </form>
          <form method="post" action="/settings/schedule">
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
              <label>режим<br>
                <select name="schedule_mode">
                  <option value="daily"${map.schedule_mode === 'daily' ? ' selected' : ''}>раз в день</option>
                  <option value="interval"${map.schedule_mode === 'interval' ? ' selected' : ''}>каждые N часов</option>
                </select></label>
              <label>каждые N часов<br>
                <input type="number" name="schedule_interval_hours" min="1" max="168"
                       value="${esc(map.schedule_interval_hours)}" style="width:80px"></label>
              <label>время ежедневного запуска<br>
                <input type="text" name="schedule_daily_at" value="${esc(map.schedule_daily_at)}"
                       placeholder="10:00" style="width:80px"></label>
              <button type="submit">Сохранить расписание</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Окно публикаций и объём</h2>
          <p class="hint" style="margin:0 0 12px">
            Публикации разносятся по слотам внутри окна со случайным сдвигом: залп в одну
            минуту выглядит как бот. «Постов в день» здесь - значение для новых групп;
            у каждой группы своё в разделе «Группы».
          </p>
          <p class="hint" style="margin:0 0 12px">
            «Одна тема в ВК и ОК»: тема уходит один раз в какую-то группу ВК и один раз
            в какую-то группу ОК - статья при этом одна, текст и обложка не пишутся дважды.
            В поиске находятся обе площадки. Тем в день при этом нужно не «сумма квот
            всех групп», а «максимум по сети»: 15 групп ВК и 3 группы ОК - это 15 тем,
            три из которых продублируются в ОК. Если выключить, у каждой группы будут
            свои темы и пересечений не будет вовсе.
          </p>
          <form method="post" action="/settings/posting">
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
              <label>окно с<br>
                <input type="text" name="posting_window_start" value="${esc(map.posting_window_start)}"
                       style="width:80px"></label>
              <label>по<br>
                <input type="text" name="posting_window_end" value="${esc(map.posting_window_end)}"
                       style="width:80px"></label>
              <label>разброс, мин<br>
                <input type="number" name="slot_jitter_minutes" min="0" max="120"
                       value="${esc(map.slot_jitter_minutes)}" style="width:80px"></label>
              <label>окно свежести, дней<br>
                <input type="number" name="freshness_window_days" min="1" max="3650"
                       value="${esc(map.freshness_window_days)}" style="width:80px"></label>
              <label>постов в день<br>
                <input type="number" name="default_posts_per_day" min="0" max="100"
                       value="${esc(map.default_posts_per_day)}" style="width:80px"></label>
              <label>одна тема в ВК и ОК<br>
                <select name="mirror_networks" style="width:150px">
                  <option value="1"${map.mirror_networks !== '0' ? ' selected' : ''}>да</option>
                  <option value="0"${map.mirror_networks === '0' ? ' selected' : ''}>нет</option>
                </select></label>
              <button type="submit">Сохранить</button>
            </div>
          </form>
        </div>
        <details class="fold">
          <summary>Тонкая настройка: длина поста, обход источников, добор тем, поиск, все ключи</summary>
        <div class="card">
          <h2 style="margin-top:0">Длина поста</h2>
          <p class="hint" style="margin:0 0 12px">
            Границы, по которым пост принимается или отправляется на переделку.
            Ноль означает «без ограничения»: сколько написала нейросеть, столько и уйдёт
            в группу. В записи ВК помещается около 16 тысяч символов, так что упереться
            в площадку обзором нельзя; в ленте пост всё равно сворачивается кнопкой
            «Показать полностью» примерно на 350 символах.
          </p>
          <form method="post" action="/settings/post-length">
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
              <label>минимум, символов<br>
                <input type="number" name="post_min_chars" min="0" max="20000"
                       value="${esc(map.post_min_chars)}" style="width:110px"></label>
              <label>максимум, символов<br>
                <input type="number" name="post_max_chars" min="0" max="20000"
                       value="${esc(map.post_max_chars)}" style="width:110px"></label>
              <button type="submit">Сохранить</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Обновление источников</h2>
          <p class="hint" style="margin:0 0 12px">
            Перед каждым прогоном система обходит все включённые сайты и забирает то,
            что вышло со времени прошлой проверки. Сначала в дело идёт свежее, и только
            когда его не хватает на план, подключается добор из архива.
            «Текстов за проверку» - сколько статей скачивается с одного сайта за раз;
            материал без текста в очередь не попадает, поэтому слишком низкое значение
            держит часть тем в базе мёртвым грузом.
          </p>
          <form method="post" action="/settings/sources-refresh">
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
              <label>обновление<br>
                <select name="refresh_sources_enabled">
                  <option value="on"${map.refresh_sources_enabled === 'on' ? ' selected' : ''}>включено</option>
                  <option value="off"${map.refresh_sources_enabled === 'off' ? ' selected' : ''}>выключено</option>
                </select></label>
              <label>не чаще раза в, мин<br>
                <input type="number" name="refresh_sources_min_age_minutes" min="0" max="1440"
                       value="${esc(map.refresh_sources_min_age_minutes)}" style="width:100px"></label>
              <label>адресов за проверку<br>
                <input type="number" name="discovery_limit_per_source" min="1" max="500"
                       value="${esc(map.discovery_limit_per_source)}" style="width:100px"></label>
              <label>текстов за проверку<br>
                <input type="number" name="extract_limit_per_check" min="1" max="200"
                       value="${esc(map.extract_limit_per_check)}" style="width:100px"></label>
              <button type="submit">Сохранить</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Добор старых тем</h2>
          <p class="hint" style="margin:0 0 12px">
            Когда свежих материалов меньше, чем мест в группах, прогон сам перечитывает
            источники с большей глубиной - 2х, 4х, 8х от окна свежести, но не глубже
            указанного предела - и добирает более ранние темы. Без добора прогон при
            исчерпании свежего просто ничего бы не опубликовал.
          </p>
          <form method="post" action="/settings/backfill">
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
              <label>добор<br>
                <select name="topic_backfill_enabled">
                  <option value="on"${map.topic_backfill_enabled === 'on' ? ' selected' : ''}>включён</option>
                  <option value="off"${map.topic_backfill_enabled === 'off' ? ' selected' : ''}>выключен</option>
                </select></label>
              <label>глубина архива, дней<br>
                <input type="number" name="topic_backfill_max_days" min="1" max="3650"
                       value="${esc(map.topic_backfill_max_days)}" style="width:100px"></label>
              <label>пауза после осечки, мин<br>
                <input type="number" name="scheduler_retry_minutes" min="1" max="720"
                       value="${esc(map.scheduler_retry_minutes)}" style="width:100px"></label>
              <button type="submit">Сохранить</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Сбор материала поиском</h2>
          <p class="hint" style="margin:0 0 12px">
            У части источников (scama.net, all-comment) своих текстов нет - только названия
            проектов. Без поиска модель пишет о таком проекте по типичным схемам, без единого
            проверяемого факта. С поиском перед генерацией собираются страницы из выдачи
            firecrawl, и пост опирается на них; ссылки видны в карточке материала.
            Каждая страница расходует лимит firecrawl (1000 запросов в месяц на проект),
            поэтому число страниц - настройка, а не константа.
          </p>
          <form method="post" action="/settings/research">
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
              <label>режим<br>
                <select name="research_mode">
                  <option value="off"${map.research_mode === 'off' ? ' selected' : ''}>выключен</option>
                  <option value="missing"${map.research_mode === 'missing' ? ' selected' : ''}>только для тем без текста</option>
                  <option value="always"${map.research_mode === 'always' ? ' selected' : ''}>всегда</option>
                </select></label>
              <label>страниц из выдачи<br>
                <input type="number" name="research_results" min="1" max="10"
                       value="${esc(map.research_results)}" style="width:80px"></label>
              <label>символов со страницы<br>
                <input type="number" name="research_chars_per_page" min="500" max="20000" step="500"
                       value="${esc(map.research_chars_per_page)}" style="width:110px"></label>
              <label style="flex:1;min-width:280px">поисковый запрос<br>
                <input type="text" name="research_query" value="${esc(map.research_query)}"></label>
              <button type="submit">Сохранить</button>
            </div>
            <p class="hint" style="margin:10px 0 0">
              В запросе <code>{{проект}}</code> подставляется названием темы. Формулировка
              влияет на выдачу сильнее всего остального - её и стоит подбирать.
            </p>
          </form>
        </div>
        <div class="card">
          <table>
            <thead><tr><th>Ключ</th><th>Значение</th><th>Изменено</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="hint">
          Остальные ключи правятся по месту: промты - в разделе «Промты», объём по группам -
          в разделе «Группы». Служебные значения (таймауты и интервалы опроса провайдеров)
          меняются миграцией.
        </p>        </details>`;

      res.type('html').send(
        page({
          title: 'Настройки',
          active: '/settings',
          user: req.user,
          heading: 'Настройки',
          sub: 'Значения засеяны из брифа. Правка остальных ключей через панель появится на этапе 8.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // Переключатель режима публикации. Отдельным роутом, а не общей формой настроек:
  // это единственное значение, ошибка в котором видна подписчикам группы.
  router.post('/settings/publish-mode', async (req, res) => {
    try {
      const mode = req.body.mode === 'live' ? 'live' : 'draft';
      await settings.set('publish_mode', mode);
      logger.warn(
        { режим: mode, кто: req.user.login },
        `Режим публикации переключён на «${mode === 'live' ? 'реальная публикация' : 'черновики'}»`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(
          mode === 'live'
            ? 'Включена реальная публикация — посты будут уходить на стену группы'
            : 'Включён режим черновиков',
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Переключение режима публикации упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/settings/schedule', async (req, res) => {
    try {
      const mode = req.body.schedule_mode === 'interval' ? 'interval' : 'daily';
      const hours = requireInt(req.body.schedule_interval_hours, 1, 168, 'Интервал запуска, часов');
      const at = requireHhMm(req.body.schedule_daily_at, 'Время ежедневного запуска');
      await settings.set('schedule_mode', mode);
      await settings.set('schedule_interval_hours', String(hours));
      await settings.set('schedule_daily_at', at);
      const map = await settings.getMap();
      const next = nextRunAt(map, (await runs.lastCycle())?.started_at ?? map.schedule_enabled_at ?? null);
      logger.info(
        { режим: mode, интервал: hours, время: at, кто: req.user.login },
        `Расписание изменено: ${scheduleText(map)}, следующий запуск ${formatDate(next)}`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(
          `Расписание: ${scheduleText(map)}. Следующий запуск ${formatDate(next)}`,
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Сохранение расписания упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Автозапуск — отдельной кнопкой, как и режим публикации: включение означает, что
  // система начнёт тратить деньги без участия человека, и это не должно случайно
  // «сохраниться заодно» с правкой соседнего поля.
  router.post('/settings/schedule-enabled', async (req, res) => {
    try {
      const enabled = req.body.enabled === 'on' ? 'on' : 'off';
      await settings.set('schedule_enabled', enabled);
      // Момент включения — точка отсчёта для «каждые N часов», пока прогонов не было.
      // Иначе первый тик после включения счёл бы, что интервал давно прошёл.
      if (enabled === 'on') await settings.set('schedule_enabled_at', new Date().toISOString());
      const map = await settings.getMap();
      const next = nextRunAt(map, (await runs.lastCycle())?.started_at ?? map.schedule_enabled_at ?? null);
      logger.warn(
        { автозапуск: enabled, расписание: scheduleText(map), кто: req.user.login },
        `Автозапуск ${enabled === 'on' ? 'включён' : 'выключен'} (${scheduleText(map)})`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(
          enabled === 'on'
            ? `Автозапуск включён: ${scheduleText(map)}, ближайший прогон ${formatDate(next)}`
            : 'Автозапуск выключен — прогоны только по кнопке',
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Переключение автозапуска упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/settings/backfill', async (req, res) => {
    try {
      const enabled = req.body.topic_backfill_enabled === 'off' ? 'off' : 'on';
      const days = requireInt(req.body.topic_backfill_max_days, 1, 3650, 'Глубина архива, дней');
      const retry = requireInt(req.body.scheduler_retry_minutes, 1, 720, 'Пауза после осечки, минут');
      await settings.set('topic_backfill_enabled', enabled);
      await settings.set('topic_backfill_max_days', String(days));
      await settings.set('scheduler_retry_minutes', String(retry));
      logger.info(
        { добор: enabled, глубина: days, пауза: retry, кто: req.user.login },
        `Добор ${enabled === 'on' ? 'включён' : 'выключен'}, глубина ${days} дней`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(
          `Добор ${enabled === 'on' ? 'включён' : 'выключен'}, глубина ${days} дней`,
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Сохранение настроек добора упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/settings/post-length', async (req, res) => {
    try {
      const min = requireInt(req.body.post_min_chars, 0, 20000, 'Минимум, символов');
      const max = requireInt(req.body.post_max_chars, 0, 20000, 'Максимум, символов');
      if (min > 0 && max > 0 && min >= max) {
        throw new Error('Минимум должен быть меньше максимума');
      }
      await settings.set('post_min_chars', String(min));
      await settings.set('post_max_chars', String(max));
      const описание = `${min > 0 ? `от ${min}` : 'без нижней границы'}, ` +
        `${max > 0 ? `до ${max}` : 'без верхней границы'}`;
      logger.info({ минимум: min, максимум: max, кто: req.user.login }, `Длина поста: ${описание}`);
      res.redirect(`/settings?ok=${encodeURIComponent(`Длина поста: ${описание}`)}`);
    } catch (error) {
      logger.error(errFields(error), 'Сохранение длины поста упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/settings/sources-refresh', async (req, res) => {
    try {
      const enabled = req.body.refresh_sources_enabled === 'off' ? 'off' : 'on';
      const minAge = requireInt(req.body.refresh_sources_min_age_minutes, 0, 1440,
        'Не чаще, чем раз в N минут');
      const discovery = requireInt(req.body.discovery_limit_per_source, 1, 500,
        'Материалов за проверку');
      const extract = requireInt(req.body.extract_limit_per_check, 1, 200, 'Текстов за проверку');
      await settings.set('refresh_sources_enabled', enabled);
      await settings.set('refresh_sources_min_age_minutes', String(minAge));
      await settings.set('discovery_limit_per_source', String(discovery));
      await settings.set('extract_limit_per_check', String(extract));
      logger.info(
        { обновление: enabled, пауза: minAge, адресов: discovery, текстов: extract, кто: req.user.login },
        `Обновление источников ${enabled === 'on' ? 'включено' : 'выключено'}, ` +
          `${discovery} адресов и ${extract} текстов за проверку`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(
          `Обновление источников ${enabled === 'on' ? 'включено' : 'выключено'}, ` +
            `текстов за проверку ${extract}`,
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Сохранение настроек обновления источников упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/settings/posting', async (req, res) => {
    try {
      const start = requireHhMm(req.body.posting_window_start, 'Начало окна публикаций');
      const end = requireHhMm(req.body.posting_window_end, 'Конец окна публикаций');
      if (start >= end) throw new Error('Начало окна публикаций должно быть раньше конца');
      const jitter = requireInt(req.body.slot_jitter_minutes, 0, 120, 'Разброс времени, минут');
      const freshness = requireInt(req.body.freshness_window_days, 1, 3650, 'Окно свежести, дней');
      const perDay = requireInt(req.body.default_posts_per_day, 0, 100, 'Постов в день');
      const mirror = String(req.body.mirror_networks ?? '1') === '0' ? '0' : '1';
      await settings.set('mirror_networks', mirror);
      await settings.set('posting_window_start', start);
      await settings.set('posting_window_end', end);
      await settings.set('slot_jitter_minutes', String(jitter));
      await settings.set('freshness_window_days', String(freshness));
      await settings.set('default_posts_per_day', String(perDay));
      logger.info(
        { окно: `${start}-${end}`, разброс: jitter, свежесть: freshness, постов_в_день: perDay,
          зеркало: mirror === '1', кто: req.user.login },
        `Настройки постинга изменены: окно ${start}-${end}, разброс ${jitter} мин, ` +
          `одна тема в ВК и ОК — ${mirror === '1' ? 'да' : 'нет'}`,
      );
      res.redirect(
        `/settings?ok=${encodeURIComponent(`Окно публикаций ${start}-${end}, разброс ${jitter} мин`)}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Сохранение настроек постинга упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/settings/research', async (req, res) => {
    try {
      const mode = String(req.body.research_mode ?? '').trim();
      if (!['off', 'missing', 'always'].includes(mode)) {
        throw new Error('Режим сбора материала: допустимы «выключен», «только для тем без текста», «всегда»');
      }
      const results = requireInt(req.body.research_results, 1, 10, 'Страниц из выдачи');
      const chars = requireInt(req.body.research_chars_per_page, 500, 20_000, 'Символов со страницы');
      const query = String(req.body.research_query ?? '').trim();
      if (!query) throw new Error('Поисковый запрос не может быть пустым');
      // Без подстановки запрос будет одинаковым для всех тем — искали бы всегда одно и то же.
      if (!query.includes('{{проект}}')) {
        throw new Error('В поисковом запросе обязателен {{проект}} — иначе он не зависит от темы');
      }
      await settings.set('research_mode', mode);
      await settings.set('research_results', String(results));
      await settings.set('research_chars_per_page', String(chars));
      await settings.set('research_query', query);
      logger.info(
        { режим: mode, страниц: results, символов: chars, запрос: query, кто: req.user.login },
        `Сбор материала: режим «${mode}», ${results} страниц по ${chars} символов`,
      );
      res.redirect(`/settings?ok=${encodeURIComponent(`Сбор материала: ${mode}, ${results} страниц`)}`);
    } catch (error) {
      logger.error(errFields(error), 'Сохранение настроек сбора материала упало');
      res.redirect(`/settings?err=${encodeURIComponent(error.message)}`);
    }
  });

  // ── Промты ───────────────────────────────────────────────────────────────
  router.get('/prompts', async (req, res, next) => {
    try {
      const body = `
        ${await promptCard('post_prompt', 'Промт текста поста', 20,
          'Системная часть запроса к модели. Правка создаёт новую версию и применяется ' +
          'к следующей генерации сразу, без перезапуска контейнера.')}
        ${await promptCard('image_prompt', 'Промт обложки', 8,
          'Используется при генерации картинки (этап 5).')}`;

      res.type('html').send(
        page({
          title: 'Промты',
          active: '/prompts',
          user: req.user,
          heading: 'Промты',
          sub: 'Промт клиента живёт в базе, а не в коде: правится в панели без пересборки.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/prompts/:key', async (req, res) => {
    const key = req.params.key;
    try {
      const text = String(req.body.body ?? '').trim();
      if (!['post_prompt', 'image_prompt'].includes(key)) throw new Error('Неизвестный промт');
      if (text.length < 50) throw new Error('Промт слишком короткий — похоже на случайное сохранение');
      const version = await prompts.saveVersion(key, text, {
        note: String(req.body.note ?? '').trim() || null,
        createdBy: req.user.login,
      });
      res.redirect(`/prompts?ok=${encodeURIComponent(`${key}: сохранена версия ${version}`)}`);
    } catch (error) {
      logger.error({ промт: key, ...errFields(error) }, 'Сохранение промта упало');
      res.redirect(`/prompts?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/prompts/:key/activate/:version', async (req, res) => {
    const { key, version } = req.params;
    try {
      await prompts.activateVersion(key, Number.parseInt(version, 10), { by: req.user.login });
      res.redirect(`/prompts?ok=${encodeURIComponent(`${key}: активна версия ${version}`)}`);
    } catch (error) {
      logger.error({ промт: key, версия: version, ...errFields(error) }, 'Откат промта упал');
      res.redirect(`/prompts?err=${encodeURIComponent(error.message)}`);
    }
  });

  // ── Посты ────────────────────────────────────────────────────────────────
  router.get('/posts', async (req, res, next) => {
    try {
      const list = await posts.listRecent(30);
      const totals = await posts.countAll();
      // Выбранный источник живёт в адресе страницы: так его видно, им можно поделиться
      // ссылкой и он не «прилипает» к системе, влияя на автоматический прогон.
      const pickedSource = Number.parseInt(req.query.source ?? '', 10) || null;
      const sourceCounts = await posts.readyCountsBySource();
      const nextArticle = await posts.nextArticleForGeneration(pickedSource);
      const nextWithoutImage = await posts.nextWithoutImage();
      const nextToPublish = await posts.nextForPublishing();

      const rows = list.length
        ? list
            .map(
              (item) => `<tr>
                <td>#${item.id}</td>
                <td>${thumbCell(item)}</td>
                <td><a href="/posts/${item.id}">${esc(item.title)}</a>
                    <br><span class="hint">${esc(item.source_code ?? '')} · тема
                    <code>${esc(item.topic_key ?? '—')}</code></span></td>
                <td>${item.char_count}</td>
                <td class="hint">${esc(item.model ?? '')}${
                  item.attempts > 1 ? `<br>попыток ${item.attempts}` : ''
                }</td>
                <td class="hint">${item.latency_ms ? `${Math.round(item.latency_ms / 100) / 10} c` : ''}${
                  item.cost_usd ? `<br>$${Number(item.cost_usd).toFixed(5)}` : ''
                }</td>
                <td>${item.status === 'failed'
                    ? `<span class="tag off">сбой</span> <span class="hint">${esc(item.error ?? '')}</span>`
                    : '<span class="tag on">готов</span>'}</td>
                <td class="hint">${esc(formatDate(item.created_at))}</td>
              </tr>`,
            )
            .join('\n')
        : '<tr><td colspan="8" class="empty">Постов пока нет.</td></tr>';

      const body = `
        <div class="grid">
          ${stat(totals.total, 'Постов всего')}
          ${stat(totals.failed, 'Сбоев генерации')}
          ${stat(`$${Number(totals.cost).toFixed(4)}`, 'Израсходовано на текст')}
          ${stat(`${totals.with_image} из ${totals.total}`, 'С обложкой')}
          ${stat(totals.published, 'Опубликовано')}
          ${stat(await creditsText(), 'Кредитов на kie.ai')}
        </div>
        ${nextWithoutImage
          ? `<div class="card">
               <h2 style="margin-top:0">Пост без обложки</h2>
               <p style="margin:0 0 4px"><strong>#${nextWithoutImage.id}
                 ${esc(nextWithoutImage.title)}</strong></p>
               <p class="hint" style="margin:0 0 12px">
                 Обложка делается через kie.ai и складывается в наш /media —
                 временную ссылку провайдера в postmypost отдавать нельзя, она истекает.</p>
               <form method="post" action="/posts/${nextWithoutImage.id}/image">
                 <button type="submit" data-busy="Рисую обложку…">Сгенерировать обложку</button>
               </form>
               ${nextWithoutImage.image_error
                 ? `<p class="hint" style="margin:10px 0 0">Прошлая попытка:
                    ${esc(nextWithoutImage.image_error)}</p>`
                 : ''}
             </div>`
          : ''}
        ${nextToPublish
          ? `<div class="card">
               <h2 style="margin-top:0">Готов к публикации</h2>
               <p style="margin:0 0 4px"><strong>#${nextToPublish.id}
                 ${esc(nextToPublish.title)}</strong></p>
               ${await publishForm(nextToPublish)}
             </div>`
          : ''}
        <div class="card">
          <h2 style="margin-top:0">Следующий материал в очереди</h2>
          <form method="get" action="/posts" style="margin:0 0 14px">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
              <label>источник<br>
                <select name="source">
                  <option value=""${pickedSource ? '' : ' selected'}>все источники</option>
                  ${sourceCounts
                    .map((item) => `<option value="${item.id}"${
                      pickedSource === item.id ? ' selected' : ''
                    }>${esc(item.code)} (${item.ready})</option>`)
                    .join('\n                  ')}
                </select></label>
              <button type="submit">Показать</button>
            </div>
          </form>
          ${nextArticle
            ? `<p style="margin:0 0 4px"><strong>${esc(nextArticle.topic_name ?? nextArticle.title ?? '')}</strong></p>
               <p class="hint" style="margin:0 0 12px">${esc(nextArticle.source_code)} ·
                 ${esc(formatDate(nextArticle.published_at))} ·
                 ${nextArticle.content ? `текст ${nextArticle.content.length} симв.` : 'только тема'} ·
                 <a href="${esc(nextArticle.url)}" target="_blank" rel="noopener">${esc(nextArticle.url)}</a></p>
               <form method="post" action="/posts/generate">
                 <input type="hidden" name="source_id" value="${pickedSource ?? ''}">
                 <button type="submit" data-busy="Генерирую пост…">Сгенерировать пост</button>
               </form>`
            : pickedSource
              ? '<p class="hint" style="margin:0">У этого источника готовых материалов нет. ' +
                'Проверьте его в разделе «Источники» или выберите другой.</p>'
              : '<p class="hint" style="margin:0">Материалов, готовых к генерации, нет. ' +
                'Проверьте источники в разделе «Источники».</p>'}
          <p class="hint" style="margin:12px 0 0">
            Очередь идёт от свежих к старым. Темы, по которым пост уже есть, пропускаются.
            Выбор источника действует только на эту кнопку: прогон по расписанию
            по-прежнему берёт самое свежее со всех сайтов.
          </p>
        </div>

        <h2>Сгенерированные посты</h2>
        <div class="card">
          <table>
            <thead><tr>
              <th>ID</th><th>Обложка</th><th>Заголовок</th><th>Символов</th><th>Модель</th>
              <th>Время / цена</th><th>Статус</th><th>Создан</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;

      res.type('html').send(
        page({
          title: 'Посты',
          active: '/posts',
          user: req.user,
          heading: 'Посты',
          sub: 'Текст генерируется по промту из раздела «Промты» и проверяется на требования формата.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/posts/generate', async (req, res) => {
    try {
      const sourceId = Number.parseInt(req.body.source_id ?? '', 10) || null;
      const article = req.body.article_id
        ? await posts.findArticleForGeneration(Number.parseInt(req.body.article_id, 10))
        : await posts.nextArticleForGeneration(sourceId);
      if (!article) {
        throw new Error(sourceId
          ? 'У выбранного источника нет материалов, готовых к генерации'
          : 'Нет материалов, готовых к генерации');
      }
      // interactive: человек ждёт ответ, поэтому тир priority вместо flex
      const post = await generatePost(article, { interactive: true });
      res.redirect(`/posts/${post.id}?ok=${encodeURIComponent(`Пост #${post.id} готов`)}`);
    } catch (error) {
      logger.error(errFields(error), 'Генерация поста из панели упала');
      // Выбранный источник возвращаем в адрес: иначе после сбоя страница молча
      // переключается на «все источники», и человек генерирует не то, что хотел.
      const back = Number.parseInt(req.body.source_id ?? '', 10) || null;
      res.redirect(`/posts?err=${encodeURIComponent(error.message)}${back ? `&source=${back}` : ''}`);
    }
  });

  // Обложка поста. Генерация синхронная: человек в панели ждёт результат, а kie.ai
  // отвечает за 30-90 секунд — очередь появится вместе с кроном на этапе 9.
  router.post('/posts/:id/image', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const post = await posts.findById(id);
      if (!post) throw new Error(`Поста #${id} нет`);
      const updated = await generateImageForPost(post);
      res.redirect(
        `/posts/${id}?ok=${encodeURIComponent(
          `Обложка готова: кредитов ${updated.image_credits ?? '?'}, ` +
            `${Math.round((updated.image_latency_ms ?? 0) / 1000)} c`,
        )}`,
      );
    } catch (error) {
      logger.error({ пост: id, ...errFields(error) }, 'Генерация обложки из панели упала');
      res.redirect(`/posts/${id}?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Синхронизация групп из postmypost. Кнопка есть и в разделе «Группы»,
  // и в форме публикации — поле back говорит, куда вернуться.
  router.post('/groups/sync', async (req, res) => {
    const back = typeof req.body.back === 'string' && req.body.back.startsWith('/')
      ? req.body.back
      : '/groups';
    try {
      const result = await syncGroups();
      const summary = `Групп в postmypost: ${result.total} (новых ${result.added}` +
        (result.broken ? `, отвалившихся ${result.broken}` : '') +
        (result.hidden ? `, скрытых ${result.hidden}` : '') + ')';
      res.redirect(`${back}?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error(errFields(error), 'Синхронизация групп из панели упала');
      res.redirect(`${back}?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Публикация поста. Синхронная: заливка картинки и создание публикаций занимают
  // секунды, человек в панели ждёт результат. Очередь появится с кроном на этапе 8.
  router.post('/posts/:id/publish', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const post = await posts.findById(id);
      if (!post) throw new Error(`Поста #${id} нет`);

      const raw = req.body.group_ids;
      const groupIds = (Array.isArray(raw) ? raw : [raw])
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => !Number.isNaN(value));
      if (groupIds.length === 0) throw new Error('Не выбрана ни одна группа');

      const result = await publishPost(post, { groupIds });
      const ok = result.published
        .map((item) => `${item.group.name} → публикация ${item.publication.id}`)
        .join('; ');
      const bad = result.failed.map((item) => `${item.group.name}: ${item.error.message}`).join('; ');
      const summary =
        `${result.mode === 'live' ? 'Опубликовано' : 'Черновики созданы'} ` +
        `(file_id ${result.fileId}${result.fileReused ? ', переиспользован' : ''}, ` +
        `время ${result.postAt}): ${ok}` + (bad ? `. Не ушло — ${bad}` : '');
      res.redirect(`/posts/${id}?ok=${encodeURIComponent(summary)}`);
    } catch (error) {
      logger.error({ пост: id, ...errFields(error) }, 'Публикация из панели упала');
      res.redirect(`/posts/${id}?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Удаление публикации (в том числе черновика) — нужно для приёмки: черновик из UAT
  // не должен оставаться в postmypost навсегда.
  router.post('/publications/:id/delete', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const postId = Number.parseInt(req.body.post_id, 10);
    try {
      const list = await publications.listByPost(postId);
      // Number(): publications.id — bigserial, node-pg отдаёт его строкой, и строгое
      // сравнение со числом из URL не сходится никогда.
      const row = list.find((item) => Number(item.id) === id);
      if (!row) throw new Error(`Публикации #${id} нет`);
      if (!row.pmp_publication_id) throw new Error('У записи нет id публикации в postmypost');

      // findAnyById: группа могла быть убрана из списка, но её публикацию всё равно
      // нужно уметь удалить в postmypost.
      const group = await groups.findAnyById(row.group_id);
      await pmp.deletePublication(row.pmp_publication_id, [group.pmp_account_id]);
      await publications.remove(row.id);
      // Пост держит статус «опубликован», пока у него есть хоть одна живая публикация.
      if (!(await publications.hasSuccess(postId))) await posts.markReady(postId);
      logger.info(
        { публикация: row.pmp_publication_id, группа: group.name, кто: req.user.login },
        `Публикация ${row.pmp_publication_id} удалена из postmypost`,
      );
      res.redirect(`/posts/${postId}?ok=${encodeURIComponent(`Публикация ${row.pmp_publication_id} удалена`)}`);
    } catch (error) {
      logger.error({ публикация: id, ...errFields(error) }, 'Удаление публикации упало');
      res.redirect(`/posts/${postId}?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.get('/posts/:id', async (req, res, next) => {
    try {
      const post = await posts.findById(Number.parseInt(req.params.id, 10));
      if (!post) return res.status(404).type('html').send(
        page({ title: 'Пост', active: '/posts', user: req.user, heading: 'Пост не найден',
               sub: '', body: '<div class="card">Такого поста нет.</div>' }),
      );

      const body = `
        <div class="card">
          <table>
            <tr><th>Тема</th><td><code>${esc(post.topic_key ?? '—')}</code></td></tr>
            <tr><th>Источник</th><td>${esc(post.source_code ?? '—')}
              ${post.article_url ? `<br><a href="${esc(post.article_url)}" target="_blank" rel="noopener" class="hint">${esc(post.article_url)}</a>` : ''}</td></tr>
            <tr><th>Материал</th><td>${materialOrigin(post)}</td></tr>
            <tr><th>Модель</th><td>${esc(post.model ?? '—')} ${esc(post.provider ? `(${post.provider})` : '')}</td></tr>
            <tr><th>Версия промта</th><td>${esc(post.prompt_version ?? '—')}</td></tr>
            <tr><th>Токенов</th><td>вход ${esc(post.tokens_in ?? '—')}, выход ${esc(post.tokens_out ?? '—')}</td></tr>
            <tr><th>Стоимость</th><td>${post.cost_usd ? `$${Number(post.cost_usd).toFixed(6)}` : '—'}</td></tr>
            <tr><th>Латентность</th><td>${esc(post.latency_ms ?? '—')} мс, попыток ${esc(post.attempts)}</td></tr>
            <tr><th>Длина</th><td>${post.char_count} символов</td></tr>
            <tr><th>request-id</th><td><code>${esc(post.request_id ?? '—')}</code></td></tr>
          </table>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Обложка</h2>
          ${post.image_url
            ? `<p style="margin:0 0 10px"><a href="${esc(post.image_url)}" target="_blank"
                 rel="noopener"><img src="${esc(post.image_url)}" alt="Обложка поста"
                 style="max-width:100%;border-radius:8px"></a></p>
               <table>
                 <tr><th>Публичный URL</th><td><a href="${esc(post.image_url)}" target="_blank"
                   rel="noopener">${esc(post.image_url)}</a></td></tr>
                 <tr><th>Файл на диске</th><td><code>${esc(post.image_path ?? '—')}</code></td></tr>
                 <tr><th>Задача kie.ai</th><td><code>${esc(post.image_task_id ?? '—')}</code></td></tr>
                 <tr><th>Версия промта обложки</th><td>${esc(post.image_prompt_version ?? '—')}</td></tr>
                 <tr><th>Кредитов / время</th><td>${esc(post.image_credits ?? '—')} ·
                   ${post.image_latency_ms ? `${Math.round(post.image_latency_ms / 1000)} c` : '—'}</td></tr>
                 <tr><th>Сделана</th><td>${esc(formatDate(post.image_generated_at))}</td></tr>
               </table>
               <p class="hint" style="margin:10px 0 0">
                 Мини-превью — так обложка выглядит в ленте:
                 <img src="${esc(post.image_url)}" alt="" style="width:160px;vertical-align:middle;
                   border-radius:4px;margin-left:8px"></p>`
            : `<p class="hint" style="margin:0 0 10px">Обложки ещё нет.${
                post.image_error ? ` Прошлая попытка: ${esc(post.image_error)}` : ''
              }${
                post.image_task_id
                  ? ` Есть незавершённая задача <code>${esc(post.image_task_id)}</code> —
                      она уже оплачена, повторный запуск дочитает её, а не создаст новую.`
                  : ''
              }</p>`}
          <form method="post" action="/posts/${post.id}/image" style="margin-top:10px">
            <button ${post.image_url ? 'class="ghost"' : ''} type="submit" data-busy="Рисую обложку…">${
              post.image_url ? 'Сгенерировать заново' : 'Сгенерировать обложку'
            }</button>
          </form>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Публикация</h2>
          ${await publicationsTable(post.id)}
          ${post.image_url
            ? await publishForm(post, Number.parseInt(req.query.group, 10))
            : '<p class="hint" style="margin:0">Публиковать нечего: у поста нет обложки.</p>'}
        </div>
        <div class="card">
          <h2 style="margin-top:0">${esc(post.title)}</h2>
          ${post.error ? `<p class="hint">Ошибка: ${esc(post.error)}</p>` : ''}
          <pre style="white-space:pre-wrap;font:inherit;margin:0">${esc(post.body)}</pre>
        </div>`;

      res.type('html').send(
        page({
          title: `Пост #${post.id}`,
          active: '/posts',
          user: req.user,
          heading: `Пост #${post.id}`,
          sub: 'Текст в том виде, в котором уйдёт на стену группы.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // ── Группы ────────────────────────────────────────────────────────────
  router.get('/groups', async (req, res, next) => {
    try {
      const list = await groups.listAll();
      const removed = await groups.listDeleted();
      const totals = await groups.countAll();
      const defaultPerDay = await settings.getInt('default_posts_per_day', 10);

      // Остаток на сегодня по каждой включённой группе — это и есть план следующего
      // прогона: столько постов группа ещё примет с учётом «постов в день».
      const planned = list
        .filter((group) => group.is_active)
        .reduce((sum, group) => sum + Math.max(0, group.posts_per_day - group.published_today), 0);

      const rows = list.length
        ? list
            .map((group) => {
              const broken = group.connection_status !== null
                && Number(group.connection_status) !== pmp.CONNECTION_OK;
              const left = Math.max(0, group.posts_per_day - group.published_today);
              return `<tr>
                <td><strong>${esc(group.name)}</strong>
                    ${networkTag(group)}<br>
                    <span class="hint">${group.login ? `${esc(group.login)} · ` : ''}аккаунт
                    ${group.pmp_account_id}${
                      group.external_id ? ` · ${esc(group.external_id)}` : ''
                    }</span></td>
                <td>
                  <form class="inline" method="post" action="/groups/${group.id}/posts-per-day">
                    <input type="number" name="posts_per_day" min="0" max="100"
                           value="${group.posts_per_day}" style="width:70px">
                    <button class="ghost small" type="submit">Сохранить</button>
                  </form>
                </td>
                <td>${group.published_today} из ${group.posts_per_day}
                    <br><span class="hint">${
                      group.is_active
                        ? (left ? `примет ещё ${left}` : 'лимит на сегодня исчерпан')
                        : 'группа выключена'
                    }</span></td>
                <td>${group.publications}</td>
                <td>${connectionTag(group)}<br>
                    <span class="hint">${esc(formatDate(group.synced_at) || 'не синхронизирована')}</span></td>
                <td>${group.is_active
                    ? '<span class="tag on">включена</span>'
                    : '<span class="tag off">выключена</span>'}</td>
                <td style="white-space:nowrap">
                  <form class="inline" method="post" action="/groups/${group.id}/toggle">
                    <button class="ghost small" type="submit"${broken && !group.is_active ? ' disabled' : ''}>${
                      group.is_active ? 'Выключить' : 'Включить'
                    }</button>
                  </form>
                  <form class="inline" method="post" action="/groups/${group.id}/delete">
                    <button class="ghost small" type="submit">Убрать из списка</button>
                  </form>
                </td>
              </tr>`;
            })
            .join('\n')
        : `<tr><td colspan="7" class="empty">Групп нет. Подключите группу в postmypost
             и нажмите «Обновить список из postmypost».</td></tr>`;

      const removedBlock = removed.length
        ? `<h2>Убранные из списка</h2>
           <div class="card">
             <p class="hint" style="margin:0 0 10px">
               Группа скрыта, но не удалена: история публикаций по ней цела и видна
               в карточках постов. Обновление списка из postmypost скрытую группу
               обратно не возвращает — только кнопка ниже.
             </p>
             <table>
               <thead><tr><th>Группа</th><th>Публикаций</th><th>Убрана</th><th></th></tr></thead>
               <tbody>${removed
                 .map(
                   (group) => `<tr>
                     <td>${esc(group.name)}<br><span class="hint">аккаунт ${group.pmp_account_id}</span></td>
                     <td>${group.publications}</td>
                     <td class="hint">${esc(formatDate(group.deleted_at))}</td>
                     <td><form class="inline" method="post" action="/groups/${group.id}/restore">
                           <button class="ghost small" type="submit">Вернуть в список</button>
                         </form></td>
                   </tr>`,
                 )
                 .join('\n')}</tbody>
             </table>
           </div>`
        : '';

      const body = `
        <div class="grid">
          ${stat(`${totals.active} из ${totals.total}`, 'Групп включено')}
          ${stat(planned, 'Постов примут сегодня')}
          ${stat(totals.deleted, 'Убрано из списка')}
          ${stat(defaultPerDay, 'Постов в день по умолчанию')}
        </div>
        <div class="card">
          <table>
            <thead><tr>
              <th>Группа</th><th>Постов в день</th><th>Сегодня</th><th>Публикаций</th>
              <th>Подключение</th><th>Статус</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:14px">
            <form method="post" action="/groups/sync">
              <input type="hidden" name="back" value="/groups">
              <button type="submit">Обновить список из postmypost</button>
            </form>
          </div>
          <p class="hint" style="margin:10px 0 0">
            Группы берутся из проекта postmypost (ВКонтакте и Одноклассники), числовые id вводить
            не нужно: подключили группу там - нажали кнопку здесь. «Постов в день»
            ограничивает публикации в группу за сутки по МСК; выключенная группа посты
            не получает.
          </p>
        </div>
        ${removedBlock}`;

      res.type('html').send(
        page({
          title: 'Группы',
          active: '/groups',
          user: req.user,
          heading: 'Группы',
          sub: 'Список приходит из postmypost. Клиент включает нужные группы и задаёт объём постинга.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/groups/:id/toggle', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const group = await groups.findById(id);
      if (!group) throw new Error(`Группы #${id} нет`);
      await groups.setActive(group.id, !group.is_active);
      logger.info(
        { группа: group.name, включена: !group.is_active, кто: req.user.login },
        `Группа «${group.name}» ${!group.is_active ? 'включена' : 'выключена'}`,
      );
      res.redirect(
        `/groups?ok=${encodeURIComponent(
          `Группа «${group.name}» ${!group.is_active ? 'включена' : 'выключена'}`,
        )}`,
      );
    } catch (error) {
      logger.error({ группа: id, ...errFields(error) }, 'Переключение группы упало');
      res.redirect(`/groups?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/groups/:id/posts-per-day', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const group = await groups.setPostsPerDay(id, req.body.posts_per_day);
      logger.info(
        { группа: group.name, постов_в_день: group.posts_per_day, кто: req.user.login },
        `Группа «${group.name}»: постов в день теперь ${group.posts_per_day}`,
      );
      res.redirect(
        `/groups?ok=${encodeURIComponent(
          `Группа «${group.name}»: постов в день ${group.posts_per_day}`,
        )}`,
      );
    } catch (error) {
      logger.error({ группа: id, ...errFields(error) }, 'Смена «постов в день» упала');
      res.redirect(`/groups?err=${encodeURIComponent(error.message)}`);
    }
  });

  // Удаление мягкое: история публикаций по группе должна остаться читаемой,
  // а физический DELETE её уносит (и с этапа 7 запрещён на уровне схемы).
  router.post('/groups/:id/delete', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const group = await groups.softDelete(id);
      if (!group) throw new Error(`Группы #${id} нет или она уже убрана`);
      logger.warn(
        { группа: group.name, кто: req.user.login },
        `Группа «${group.name}» убрана из списка (история публикаций сохранена)`,
      );
      res.redirect(
        `/groups?ok=${encodeURIComponent(
          `Группа «${group.name}» убрана из списка. История публикаций сохранена, ` +
            'группу можно вернуть.',
        )}`,
      );
    } catch (error) {
      logger.error({ группа: id, ...errFields(error) }, 'Удаление группы упало');
      res.redirect(`/groups?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/groups/:id/restore', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    try {
      const group = await groups.restore(id);
      if (!group) throw new Error(`Группы #${id} нет среди убранных`);
      logger.info({ группа: group.name, кто: req.user.login }, `Группа «${group.name}» возвращена в список`);
      res.redirect(
        `/groups?ok=${encodeURIComponent(
          `Группа «${group.name}» возвращена в список выключенной — включите её, когда нужно`,
        )}`,
      );
    } catch (error) {
      logger.error({ группа: id, ...errFields(error) }, 'Восстановление группы упало');
      res.redirect(`/groups?err=${encodeURIComponent(error.message)}`);
    }
  });

  // ── Ручной режим ─────────────────────────────────────────────────────────
  router.get('/manual', async (req, res, next) => {
    try {
      const list = await groups.listAll();
      const recent = await query(
        `SELECT p.id, p.title, p.status, p.image_url, p.created_at, a.url AS article_url
           FROM posts p JOIN articles a ON a.id = p.article_id
           JOIN sources s ON s.id = a.source_id
          WHERE s.code = 'manual' OR a.url LIKE 'https://manual.local/%'
          ORDER BY p.id DESC LIMIT 10`,
      );

      const options = list
        .filter((group) => group.is_active && !group.deleted_at)
        .map((group) => `<option value="${group.id}">${esc(group.name)} (сегодня ${
          group.published_today} из ${group.posts_per_day})</option>`)
        .join('\n');

      const recentRows = recent.rows.length
        ? recent.rows
            .map((row) => `<tr>
              <td><a href="/posts/${row.id}">${esc(row.title)}</a></td>
              <td>${postStatusTag(row.status)}</td>
              <td class="hint">${esc(formatDate(row.created_at))}</td>
            </tr>`)
            .join('\n')
        : '<tr><td colspan="3" class="empty">Ручных постов ещё не было</td></tr>';

      const body = `
        <div class="card">
          <h2 style="margin-top:0">Пост по ссылке или по теме</h2>
          <p class="hint" style="margin:0 0 12px">
            Заполните одно поле из двух. По ссылке система забирает текст статьи
            (WP API, при неудаче firecrawl) и делает рерайт. По теме текста нет -
            обзор пишет ИИ по названию проекта, как для all-comment и scama.net.
            Пост создаётся вместе с обложкой и открывается для проверки: публикация
            отдельной кнопкой, автоматически ничего не уходит.
          </p>
          <form method="post" action="/manual">
            <div style="display:flex;flex-direction:column;gap:10px;max-width:640px">
              <label>ссылка на материал<br>
                <input type="text" name="url" placeholder="https://..." style="width:100%"></label>
              <label>или тема (название проекта)<br>
                <input type="text" name="topic" placeholder="Например: Global ERP" style="width:100%"></label>
              <label>группа для публикации<br>
                <select name="group_id" style="min-width:280px">
                  <option value="">выбрать позже, в карточке поста</option>
                  ${options}
                </select></label>
              <label class="hint"><input type="checkbox" name="force" value="1">
                писать, даже если про эту тему уже был пост</label>
              <div>
                <button type="submit" data-busy="Генерирую пост…">Сгенерировать пост</button>
                <span class="hint" style="margin-left:8px">займёт 20-60 секунд:
                  текст и обложка делаются сразу</span>
              </div>
            </div>
          </form>
        </div>
        <h2>Последние ручные посты</h2>
        <div class="card">
          <table>
            <thead><tr><th>Пост</th><th>Статус</th><th>Создан</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>`;

      res.type('html').send(
        page({
          title: 'Ручной режим',
          active: '/manual',
          user: req.user,
          heading: 'Ручной режим',
          sub: 'Пост вне очереди: по ссылке или по одной теме.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/manual', async (req, res) => {
    try {
      const url = String(req.body.url ?? '').trim();
      const topic = String(req.body.topic ?? '').trim();
      const force = req.body.force === '1';
      if (!url && !topic) throw new Error('Заполните ссылку или тему');

      // Дедуп в ручном режиме предупреждает, а не запрещает: клиент мог захотеть
      // второй пост по той же теме осознанно (например, вышло продолжение истории).
      if (!force) {
        const found = await inspectManual({ url, topic });
        if (found.owner && found.post) {
          throw new Error(
            `Про тему «${found.owner.topic_name ?? found.topic.name}» уже писали: ` +
              `пост #${found.post.id}. ` +
              'Если нужен ещё один — отметьте галочку «писать, даже если про эту тему уже был пост».',
          );
        }
      }

      const result = await createManualPost({ url: url || null, topic: topic || null, force });
      const groupId = Number.parseInt(req.body.group_id, 10);
      const notes = [`Пост #${result.post.id} готов${result.post.image_url ? ' с обложкой' : ''}.`,
        ...result.warnings];

      logger.info(
        { пост: result.post.id, по_ссылке: Boolean(url), кто: req.user.login },
        `Ручной пост #${result.post.id} создан (${url ? 'по ссылке' : 'по теме'})`,
      );

      // Группу не публикуем сами: критерий этапа — «показывает результат до публикации».
      // Она передаётся в карточку поста, где уже стоит галочкой в форме публикации.
      const suffix = Number.isNaN(groupId) ? '' : `&group=${groupId}`;
      res.redirect(`/posts/${result.post.id}?ok=${encodeURIComponent(notes.join(' '))}${suffix}`);
    } catch (error) {
      logger.error(errFields(error), 'Ручной пост не создался');
      res.redirect(`/manual?err=${encodeURIComponent(error.message)}`);
    }
  });

  // ── Наполнение из архива ─────────────────────────────────────────────────
  router.get('/archive', async (req, res, next) => {
    try {
      const [state, sourceList, groupList, map] = await Promise.all([
        archiveState(),
        sources.listAll(),
        groups.listAll(),
        settings.getMap(),
      ]);

      const activeSources = sourceList.filter((item) => item.is_active && item.code !== 'manual');
      const activeGroups = groupList.filter((item) => item.is_active && !item.deleted_at);

      const sourceChecks = activeSources.length
        ? activeSources
            .map((item) => `<label style="display:block;margin-bottom:6px">
              <input type="checkbox" name="source_ids" value="${item.id}" checked>
              ${esc(item.title)} <span class="hint">${esc(item.code)} · ${
                esc(discoveryText(item))}</span></label>`)
            .join('\n')
        : '<p class="hint">Активных источников нет — включите их в разделе «Источники».</p>';

      const groupChecks = activeGroups.length
        ? activeGroups
            .map((item) => `<label style="display:block;margin-bottom:6px">
              <input type="checkbox" name="group_ids" value="${item.id}" checked>
              ${esc(item.name)} <span class="hint">до ${item.posts_per_day} постов в день · ${
                esc(item.login ?? '')}</span></label>`)
            .join('\n')
        : '<p class="hint">Включённых групп нет — включите группу в разделе «Группы».</p>';

      // Период по умолчанию: год до начала окна свежести. Свежее окно и так забирает
      // обычный обход, наполнению нужен именно архив «до» него.
      const freshDays = Number.parseInt(map.freshness_window_days ?? '30', 10) || 30;
      const to = new Date(Date.now() - freshDays * 86_400_000);
      const from = new Date(to.getTime() - 365 * 86_400_000);
      const iso = (date) => date.toISOString().slice(0, 10);

      const busy = state.active;
      const form = `<div class="card">
          <h2 style="margin-top:0">Новое наполнение</h2>
          <p class="hint" style="margin:0 0 12px">
            Система соберёт материалы выбранных источников за период, отбросит те, по которым
            пост уже был, и разложит очередь от свежих к старым: каждый день — не больше
            заданного числа постов на группу. Публикации создаются сразу, но встают
            в postmypost на свои даты, поэтому стена наполняется постепенно.
          </p>
          <form method="post" action="/archive">
            <div style="display:flex;gap:30px;flex-wrap:wrap">
              <div style="min-width:260px"><b>Источники</b><div style="margin-top:8px">${
                sourceChecks}</div></div>
              <div style="min-width:260px"><b>Группы</b><div style="margin-top:8px">${
                groupChecks}</div></div>
              <div style="min-width:220px">
                <b>Период и объём</b>
                <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
                  <label>с<br><input type="date" name="from" value="${iso(from)}"></label>
                  <label>по<br><input type="date" name="to" value="${iso(to)}"></label>
                  <label>всего постов<br>
                    <input type="number" name="limit_total" min="1" max="500" value="30"></label>
                  <label>в день на группу<br>
                    <input type="number" name="per_day" min="1" max="100" value="${
                      esc(map.default_posts_per_day ?? '3')}"></label>
                </div>
              </div>
            </div>
            <div style="margin-top:14px">
              <button type="submit"${busy ? ' disabled' : ''}>${
                busy ? 'Задание уже выполняется' : 'Поставить в очередь'}</button>
              <span class="hint" style="margin-left:8px">сбор материалов занимает
                несколько минут, затем задание публикует посты по одному</span>
            </div>
          </form>
        </div>`;

      const body = `${form}
        ${busy ? await archiveCard(busy) : ''}
        <h2>История наполнений</h2>
        <div class="card">
          <table>
            <thead><tr><th>Задание</th><th>Период</th><th>Итог</th><th>Начато</th></tr></thead>
            <tbody>${
              state.recent.length
                ? state.recent
                    .map((job) => `<tr>
                      <td>#${job.id} ${archiveStatusTag(job.status)}</td>
                      <td class="hint">${esc(formatDay(job.period_from))} - ${
                        esc(formatDay(job.period_to))}</td>
                      <td class="hint">в очереди ${job.planned}, опубликовано ${
                        job.published}${job.failed ? `, сбоев ${job.failed}` : ''}</td>
                      <td class="hint">${esc(formatDate(job.started_at))}</td>
                    </tr>`)
                    .join('\n')
                : '<tr><td colspan="4" class="empty">Наполнений ещё не было</td></tr>'
            }</tbody>
          </table>
        </div>`;

      res.type('html').send(
        page({
          title: 'Из архива',
          active: '/archive',
          user: req.user,
          heading: 'Наполнение из архива',
          sub: 'Разовый старт: посты за прошлый период, растянутые по дням.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/archive', async (req, res) => {
    try {
      const job = await startArchiveFill({
        sourceIds: idList(req.body.source_ids),
        groupIds: idList(req.body.group_ids),
        from: String(req.body.from ?? '').trim(),
        to: String(req.body.to ?? '').trim(),
        limitTotal: requireInt(req.body.limit_total, 1, 500, 'Всего постов'),
        perDay: requireInt(req.body.per_day, 1, 100, 'Постов в день на группу'),
        createdBy: req.user.login,
      });
      logger.info({ задание: job.id, кто: req.user.login }, `Наполнение #${job.id} поставлено в очередь`);
      res.redirect(
        `/archive?ok=${encodeURIComponent(
          `Задание #${job.id} принято. Сначала сбор материалов, потом публикация — ` +
            'обновляйте страницу, прогресс виден ниже.',
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Наполнение из архива не запустилось');
      res.redirect(`/archive?err=${encodeURIComponent(error.message)}`);
    }
  });

  router.post('/archive/:id/stop', async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      await stopArchiveFill(id);
      res.redirect(
        `/archive?ok=${encodeURIComponent(
          'Задание останавливается: слот, который уже начат, доедет, остальные не публикуются.',
        )}`,
      );
    } catch (error) {
      res.redirect(`/archive?err=${encodeURIComponent(error.message)}`);
    }
  });

  /** Карточка активного задания: этап, счётчики, слоты, кнопка «Остановить». */
  async function archiveCard(job) {
    const progress = job.planned
      ? `${job.published} из ${job.planned}`
      : `собрано материалов: ${job.collected}`;
    return `<div class="card">
        <h2 style="margin-top:0">Задание #${job.id} ${archiveStatusTag(job.status)}</h2>
        <table>
          <tr><th>Этап</th><td>${esc(job.stage ?? '')}</td></tr>
          <tr><th>Период</th><td>${esc(formatDay(job.period_from))} - ${
            esc(formatDay(job.period_to))}</td></tr>
          <tr><th>Объём</th><td>до ${job.limit_total} постов, ${job.per_day} в день на группу${
            job.days ? `, растянуто на ${job.days} дн.` : ''}</td></tr>
          <tr><th>Прогресс</th><td>${esc(progress)}${
            job.generated ? `, сгенерировано ${job.generated}` : ''}${
            job.failed ? `, сбоев ${job.failed}` : ''}</td></tr>
          <tr><th>Начато</th><td>${esc(formatDate(job.started_at))} ${
            esc(job.created_by ? `· ${job.created_by}` : '')}</td></tr>
          <tr><th>request-id</th><td><code>${esc(job.request_id ?? '')}</code></td></tr>
        </table>
        <p class="hint" style="margin:12px 0 0">
          Страница сама не обновляется - нажмите F5. Вкладку можно закрыть, задание
          от этого не остановится.
        </p>
        <form method="post" action="/archive/${job.id}/stop" style="margin-top:12px">
          <button class="ghost" type="submit">Остановить</button>
          <span class="hint" style="margin-left:8px">уже созданные посты останутся в базе,
            неопубликованные слоты будут сняты</span>
        </form>
        ${job.run_id ? await runItemsTable(job.run_id) : ''}
      </div>`;
  }

  // ── Прогоны ──────────────────────────────────────────────────────────────
  /**
   * История запусков. Сюда попадают все виды прогонов, включая проверки источников
   * и наполнение из архива: для наблюдаемости важно «что система делала», а не
   * «что из этого было постингом».
   */
  router.get('/runs', async (req, res, next) => {
    try {
      const kind = KNOWN_RUN_KINDS.includes(req.query.kind) ? req.query.kind : null;
      const list = await runs.listRecent(60, { kind: kind ?? undefined });

      const rowList = list.length
        ? list
            .map(
              (run) => `<tr>
                <td><a href="/runs/${run.id}">#${run.id}</a><br>
                    <span class="hint">${esc(runKindText(run.kind))}</span></td>
                <td>${runStatusTag(run.status)}</td>
                <td class="hint">${esc(formatDate(run.started_at))}<br>${
                  run.finished_at
                    ? `${esc(durationText(run.started_at, run.finished_at))}`
                    : 'ещё идёт'}</td>
                <td>${runCountersText(run)}</td>
                <td>${run.errors
                    ? `<a href="${DIAG}?run=${run.id}"><span class="tag off">сбоев ${run.errors}</span></a>`
                    : (run.error ? `<span class="tag off">сбой</span>` : '<span class="hint">нет</span>')}
                    ${run.error ? `<br><span class="hint">${esc(cut(run.error, 120))}</span>` : ''}</td>
                <td><code>${esc(run.request_id ?? '')}</code></td>
              </tr>`,
            )
        : [];
      const runsClip = clipRows(rowList, { limit: 15, label: 'прогонов' });
      const rows = rowList.length
        ? runsClip.body
        : '<tr><td colspan="6" class="empty">Прогонов ещё не было</td></tr>';

      const filters = ['', ...KNOWN_RUN_KINDS]
        .map((value) => {
          const active = (kind ?? '') === value;
          const title = value ? runKindText(value) : 'все';
          return `<a href="/runs${value ? `?kind=${value}` : ''}"
             class="tag ${active ? 'on' : 'off'}" style="text-decoration:none">${esc(title)}</a>`;
        })
        .join(' ');

      const body = `<div class="card">
          <p style="margin:0 0 10px">Вид: ${filters}</p>
          <table id="${runsClip.id}" class="${runsClip.className.trim()}">
            <thead><tr><th>Прогон</th><th>Итог</th><th>Начат</th>
              <th>Счётчики</th><th>Ошибки</th><th>request-id</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${runsClip.toggle}
          <p class="hint" style="margin:12px 0 0">
            Счётчики — по шагам конвейера: слотов в плане, из них сгенерировано текстов
            и опубликовано. У проверки источника «найдено» - это новые материалы.
            По <code>request-id</code> ищутся все строки лога прогона:
            <code>docker compose logs app | grep &lt;id&gt;</code>.
          </p>
        </div>`;

      res.type('html').send(
        page({
          title: 'Прогоны',
          active: '/runs',
          user: req.user,
          heading: 'Прогоны',
          sub: 'Что система делала: запуски, счётчики по шагам, сбои и сквозной request-id.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  /** Карточка одного прогона: слоты, ошибки, meta — то же, что видно на «Обзоре». */
  router.get('/runs/:id', async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      const run = await runs.findById(id);
      if (!run) return next();

      const errorList = await appErrors.listByRun(id);
      const meta = run.meta && Object.keys(run.meta).length
        ? Object.entries(run.meta)
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([key, value]) => `${esc(key)}: ${esc(String(value))}`)
            .join(' · ')
        : '';

      const body = `<div class="card">
          <table>
            <tr><th>Прогон</th><td>#${run.id} ${esc(runKindText(run.kind))},
              ${runStatusTag(run.status)}</td></tr>
            <tr><th>Время</th><td>${esc(formatDate(run.started_at))} →
              ${esc(formatDate(run.finished_at) || 'ещё идёт')}${
                run.finished_at ? ` <span class="hint">(${esc(durationText(run.started_at, run.finished_at))})</span>` : ''
              }</td></tr>
            <tr><th>Счётчики</th><td>${runCountersText(run)}</td></tr>
            ${meta ? `<tr><th>Подробности</th><td class="hint">${meta}</td></tr>` : ''}
            ${run.error ? `<tr><th>Ошибка</th><td class="hint">${esc(run.error)}</td></tr>` : ''}
            <tr><th>request-id</th><td><code>${esc(run.request_id ?? '')}</code>
              <span class="hint">поиск в логах:
                <code>docker compose logs app | grep ${esc(run.request_id ?? '')}</code></span></td></tr>
          </table>
          ${await runItemsTable(run.id)}
        </div>
        ${errorList.length ? `<h2>Сбои прогона</h2>${errorsTable(errorList)}` : ''}
        <p><a href="/runs">← ко всем прогонам</a></p>`;

      res.type('html').send(
        page({
          title: `Прогон #${run.id}`,
          active: '/runs',
          user: req.user,
          heading: `Прогон #${run.id}`,
          sub: esc(runKindText(run.kind)),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // ── Опубликовано ─────────────────────────────────────────────────────────
  router.get('/published', async (req, res, next) => {
    try {
      const groupId = Number.parseInt(req.query.group, 10);
      const only = ['ok', 'failed', 'live'].includes(req.query.only) ? req.query.only : null;
      const list = await publications.listForLog({
        limit: 80,
        groupId: Number.isNaN(groupId) ? undefined : groupId,
        only: only ?? undefined,
      });
      const groupList = await groups.listAll();
      const totals = await publications.countAll();

      const rows = list.length
        ? list
            .map(
              (item) => `<tr>
                <td style="width:110px">${item.image_url
                    ? `<a href="/posts/${item.post_id}"><img src="${esc(item.image_url)}" alt=""
                         style="width:96px;border-radius:4px;display:block"></a>`
                    : '<span class="hint">нет обложки</span>'}</td>
                <td><a href="/posts/${item.post_id}">${esc(item.post_title ?? `пост #${item.post_id}`)}</a><br>
                    <span class="hint">${esc(item.topic_name ?? item.topic_key ?? '')}</span></td>
                <td>${esc(item.group_name)}<br>${vkLinkCell(item)}</td>
                <td class="hint">${esc(formatDate(item.post_at ?? item.created_at))}</td>
                <td>${item.error
                    ? `<span class="tag off">не уехал</span><br><span class="hint">${esc(cut(item.error, 160))}</span>`
                    : `${publishModeTag(item.mode)}<br><span class="hint">id ${
                        esc(item.pmp_publication_id ?? '—')}, статус ${esc(item.pmp_status ?? '—')}</span>`}</td>
                <td><code>${esc(item.request_id ?? '')}</code></td>
              </tr>`,
            )
            .join('\n')
        : '<tr><td colspan="6" class="empty">Публикаций пока нет</td></tr>';

      const groupFilter = groupList
        .map(
          (group) => `<a href="/published?group=${group.id}" class="tag ${
            group.id === groupId ? 'on' : 'off'}" style="text-decoration:none">${esc(group.name)}</a>`,
        )
        .join(' ');

      const body = `<div class="grid">
          ${stat(totals.total, 'Всего публикаций')}
          ${stat(totals.live, 'На стену (live)')}
          ${stat(totals.failed, 'Со сбоем')}
        </div>
        <div class="card">
          <p style="margin:0 0 10px">
            <a href="/published" class="tag ${!only && Number.isNaN(groupId) ? 'on' : 'off'}"
               style="text-decoration:none">все</a>
            <a href="/published?only=ok" class="tag ${only === 'ok' ? 'on' : 'off'}"
               style="text-decoration:none">уехавшие</a>
            <a href="/published?only=live" class="tag ${only === 'live' ? 'on' : 'off'}"
               style="text-decoration:none">на стену</a>
            <a href="/published?only=failed" class="tag ${only === 'failed' ? 'on' : 'off'}"
               style="text-decoration:none">со сбоем</a>
            ${groupFilter ? ` · ${groupFilter}` : ''}
          </p>
          <table>
            <thead><tr><th>Обложка</th><th>Пост</th><th>Куда</th><th>Время</th>
              <th>Итог</th><th>request-id</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="hint" style="margin:12px 0 0">
            Ссылка на запись появляется только у реальной публикации: у черновика
            записи на стене ещё нет, поэтому ссылка ведёт на саму группу. Кнопка
            «Найти ссылку» перечитывает публикацию в postmypost - ей есть смысл
            пользоваться после того, как отложенный пост вышел.
          </p>
        </div>`;

      res.type('html').send(
        page({
          title: 'Опубликовано',
          active: '/published',
          user: req.user,
          heading: 'Опубликовано',
          sub: 'Лог постов: куда, когда, чем закончилось и по какому request-id искать в логах.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  /**
   * Подтянуть ссылку на запись из postmypost. Отдельной кнопкой, а не при
   * публикации: в момент создания записи на стене ещё нет — ни у черновика,
   * ни у отложенного поста.
   */
  router.post('/publications/:id/vk-link', async (req, res) => {
    const back = String(req.body.back ?? '/published');
    try {
      const id = Number.parseInt(req.params.id, 10);
      const row = await publications.findById(id);
      if (!row) throw new Error(`Публикация #${id} не найдена`);
      if (!row.pmp_publication_id) throw new Error('У этой записи нет id в postmypost');

      const payload = await pmp.publication(row.pmp_publication_id);
      const url = pmp.postUrlFrom(payload);
      if (!url) {
        throw new Error(
          'postmypost не отдал адрес записи. Так бывает у черновика и у отложенного ' +
            'поста, который ещё не вышел: записи на стене пока не существует.',
        );
      }
      await publications.setVkUrl(id, url);
      res.redirect(`${back}?ok=${encodeURIComponent(`Ссылка найдена: ${url}`)}`);
    } catch (error) {
      logger.error(errFields(error), 'Поиск ссылки на пост не удался');
      res.redirect(`${back}?err=${encodeURIComponent(error.message)}`);
    }
  });

  // ── Ошибки ───────────────────────────────────────────────────────────────
  // Путь берётся из настройки, а не зашит: на проде журнал сбоев спрятан за
  // непубличным адресом (`DIAG_PATH`), потому что вход в панель один на всех, а тела
  // ответов провайдеров показывать клиенту незачем. Локально настройка пустая и
  // раздел остаётся на привычном `/errors`.
  const DIAG = `/${config.diagPath}`;

  router.get(DIAG, async (req, res, next) => {
    try {
      const runId = Number.parseInt(req.query.run, 10);
      const list = Number.isNaN(runId)
        ? await appErrors.listRecent({
            limit: 100,
            stage: req.query.stage || undefined,
            service: req.query.service || undefined,
          })
        : await appErrors.listByRun(runId, 100);
      const stats = await appErrors.summary();

      const filters = stats.byStage
        .map((row) => {
          const params = new URLSearchParams({ stage: row.stage });
          if (row.service) params.set('service', row.service);
          const active = req.query.stage === row.stage
            && (req.query.service ?? '') === (row.service ?? '');
          return `<a href="${DIAG}?${params}" class="tag ${active ? 'on' : 'off'}"
              style="text-decoration:none">${esc(row.stage)}${
                row.service ? ` · ${esc(row.service)}` : ''} (${row.n})</a>`;
        })
        .join(' ');

      const body = `<div class="card">
          <p style="margin:0 0 10px">
            <a href="${DIAG}" class="tag ${req.query.stage || !Number.isNaN(runId) ? 'off' : 'on'}"
               style="text-decoration:none">все</a>
            ${filters}
            ${Number.isNaN(runId) ? '' : `<span class="tag on">прогон #${runId}</span>`}
          </p>
          ${errorsTable(list)}
          <form method="post" action="${DIAG}/clear" style="margin-top:14px">
            <button class="ghost" type="submit">Очистить журнал</button>
            <span class="hint" style="margin-left:8px">всего записей: ${stats.total},
              за сутки: ${stats.recent}</span>
          </form>
          <p class="hint" style="margin:12px 0 0">
            «Шаг» - место в конвейере, «сервис» - чей ответ привёл к сбою, «ответ» -
            тело ответа провайдера как есть (в нём и объяснение 422, и 401).
            По <code>request-id</code> находятся все строки этого же события в логах:
            <code>docker compose logs app | grep &lt;id&gt;</code>.
          </p>
        </div>`;

      res.type('html').send(
        page({
          title: 'Ошибки',
          active: DIAG,
          user: req.user,
          heading: 'Ошибки',
          sub: 'Последние сбои с шагом конвейера, внешним сервисом и телом ответа.',
          message: buildSourceMessage(req.query),
          body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post(`${DIAG}/clear`, async (req, res) => {
    try {
      const removed = await appErrors.clear();
      logger.info({ кто: req.user.login, удалено: removed }, `Журнал ошибок очищен: ${removed} записей`);
      res.redirect(`${DIAG}?ok=${encodeURIComponent(`Журнал очищен: удалено ${removed} записей`)}`);
    } catch (error) {
      res.redirect(`${DIAG}?err=${encodeURIComponent(error.message)}`);
    }
  });

  /** Таблица сбоев — общая для раздела «Ошибки» и карточки прогона. */
  function errorsTable(list) {
    if (list.length === 0) return '<p class="empty">Сбоев не записано.</p>';
    const rows = list
      .map(
        (item) => `<tr>
          <td class="hint">${esc(formatDate(item.created_at))}</td>
          <td>${esc(item.stage)}${
            item.service ? `<br><span class="hint">${esc(item.service)}</span>` : ''}</td>
          <td>${esc(item.message)}${
            item.http_status ? `<br><span class="tag off">HTTP ${esc(item.http_status)}</span>` : ''}${
            item.url ? `<br><span class="hint">${esc(cut(item.url, 90))}</span>` : ''}</td>
          <td>${item.details
              ? `<details><summary class="hint">ответ сервиса</summary>
                   <pre style="white-space:pre-wrap;font-size:12px;margin:6px 0 0">${
                     esc(cut(item.details, 1500))}</pre></details>`
              : '<span class="hint">—</span>'}</td>
          <td class="hint">${errorContext(item)}</td>
          <td><code>${esc(item.request_id ?? '')}</code></td>
        </tr>`,
      )
      .join('\n');
    return `<table>
        <thead><tr><th>Когда</th><th>Шаг</th><th>Что случилось</th><th>Ответ</th>
          <th>Контекст</th><th>request-id</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /** Что уже уехало (или не уехало) по этому посту. */
  async function publicationsTable(postId) {
    const list = await publications.listByPost(postId);
    if (list.length === 0) {
      return '<p class="hint" style="margin:0 0 12px">Публикаций по этому посту ещё нет.</p>';
    }
    const rows = list
      .map(
        (item) => `<tr>
          <td>${esc(item.group_name)}<br><span class="hint">${esc(item.group_login ?? '')}</span></td>
          <td>${item.error
              ? `<span class="tag off">сбой</span> <span class="hint">${esc(item.error)}</span>`
              : `${publishModeTag(item.mode)} <span class="hint">статус ${esc(item.pmp_status ?? '—')}</span>`}</td>
          <td><code>${esc(item.pmp_publication_id ?? '—')}</code>
              <br><span class="hint">file_id ${esc(item.pmp_file_id ?? '—')}</span></td>
          <td class="hint">${esc(formatDate(item.post_at))}</td>
          <td>${item.pmp_publication_id
              ? `<form class="inline" method="post" action="/publications/${item.id}/delete">
                   <input type="hidden" name="post_id" value="${postId}">
                   <button class="ghost small" type="submit">Удалить в postmypost</button>
                 </form>`
              : ''}</td>
        </tr>`,
      )
      .join('\n');
    return `<table style="margin-bottom:14px">
        <thead><tr><th>Группа</th><th>Режим</th><th>ID в postmypost</th><th>Время</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /**
   * Форма публикации: выбор групп + кнопка.
   *
   * Выключенная группа в выборе есть, но недоступна: так видно, почему пост в неё
   * не уйдёт, и сразу понятно, где это менять (раздел «Группы»). Дневной лимит
   * показывается рядом — публикация сверх него отказывает на уровне сервиса.
   */
  async function publishForm(post, onlyGroupId = NaN) {
    const list = await groups.listAll();
    const mode = await settings.get('publish_mode', 'draft');
    const syncButton = `<form class="inline" method="post" action="/groups/sync">
        <input type="hidden" name="back" value="/posts/${post.id}">
        <button class="ghost small" type="submit">Обновить список групп из postmypost</button>
      </form>`;

    if (list.length === 0) {
      return `<p class="hint" style="margin:0 0 10px">
          Групп в базе нет. Список берётся из postmypost: подключите группу там
          и нажмите кнопку ниже.</p>
        ${syncButton}`;
    }

    const checks = list
      .map((group) => {
        const broken = group.connection_status !== null
          && Number(group.connection_status) !== pmp.CONNECTION_OK;
        const left = Math.max(0, group.posts_per_day - group.published_today);
        const blocked = broken || !group.is_active;
        const notes = [
          esc(group.login ?? ''),
          `аккаунт ${group.pmp_account_id}`,
          `сегодня ${group.published_today} из ${group.posts_per_day}`,
        ];
        if (!group.is_active) notes.push('<span class="tag off">выключена</span>');
        if (broken) notes.push('<span class="tag off">отключён</span>');
        if (group.is_active && !broken && left === 0) notes.push('лимит на сегодня исчерпан');
        // Пришли из ручного режима с выбранной группой — отмечаем только её,
        // остальные оставляем доступными, но снятыми.
        const picked = Number.isNaN(onlyGroupId) ? true : group.id === onlyGroupId;
        return `<label style="display:block;margin-bottom:6px">
            <input type="checkbox" name="group_ids" value="${group.id}"
              ${blocked ? 'disabled' : (picked ? 'checked' : '')}>
            ${esc(group.name)}
            <span class="hint">${notes.filter(Boolean).join(' · ')}</span>
          </label>`;
      })
      .join('\n');

    return `<form method="post" action="/posts/${post.id}/publish">
        <div style="margin:0 0 10px">${checks}</div>
        <button type="submit" data-busy="Отправляю в postmypost…">${
          mode === 'live' ? 'Опубликовать на стену' : 'Создать черновик в postmypost'
        }</button>
        <span class="hint" style="margin-left:8px">режим: ${publishModeTag(mode)}</span>
      </form>
      <p class="hint" style="margin:10px 0 0">
        Картинка заливается в postmypost один раз и переиспользуется всеми выбранными
        группами. Режим переключается в разделе «Настройки», состав групп и объём
        постинга - в разделе «Группы». ${syncButton}</p>`;
  }

  /**
   * Карточка прогона: план на следующий запуск, кнопка ручного запуска и итог последнего.
   *
   * План строится «на лету» из тех же правил, что использует сам прогон, — так видно,
   * что уйдёт в какую группу и в какое время, до того как что-то опубликовано.
   */
  async function runCard(lastCycle) {
    const plan = await buildPlan();
    const map = await settings.getMap();
    const planList = plan.items.map(
      (item) => `<tr>
              <td>${item.slotNo}</td>
              <td>${esc(item.groupName)}</td>
              <td>${esc(item.label ?? '')}<br><span class="hint">${
                item.kind === 'post' ? 'пост готов' : 'нужна генерация'
              }${item.date ? ` · материал от ${esc(formatDate(item.date))}` : ''}</span></td>
              <td class="hint">${esc(formatDate(item.postAt))}</td>
            </tr>`,
    );
    const planClip = clipRows(planList, { limit: 10, label: 'слотов' });
    const planRows = plan.items.length
      ? planClip.body
      : `<tr><td colspan="4" class="empty">${esc(plan.reason ?? 'Планировать нечего')}</td></tr>`;

    // Сводкой, а не перечислением: двенадцать групп в одну строку читались как
    // сплошной текст, и главное число — сколько мест осталось — в нём терялось.
    const quotaSummary = plan.groups.length
      ? `${plan.groups.reduce((sum, row) => sum + row.quota, 0)} свободных мест ` +
        `в ${plan.groups.length} группах` +
        (plan.need ? ` · нужно тем: ${plan.need}` : '')
      : 'нет включённых групп';
    const quotaDetails = plan.groups.length
      ? plan.groups
          .map(
            (row) => `${esc(row.group.name)}: ${row.quota} из ${row.group.posts_per_day}` +
              (row.publishedToday ? ` (сегодня уже ${row.publishedToday})` : ''),
          )
          .join(' · ')
      : '';

    const busySince = runningSince();
    const bgError = !busySince ? lastBackgroundError() : null;
    const lastBlock = lastCycle
      ? `<h2>${busySince ? 'Идёт прогон' : 'Последний прогон'}</h2>
         <div class="card">
           ${busySince
             ? `<p style="margin:0 0 10px">Прогон идёт с ${esc(formatDate(busySince))}.
                  Страница сама не обновляется - нажмите F5, чтобы увидеть новые слоты.
                  Вкладку можно закрыть, прогон от этого не остановится.</p>`
             : ''}
           <table>
             <tr><th>Прогон</th><td>#${lastCycle.id} ${runKindText(lastCycle.kind)},
               ${runStatusTag(lastCycle.status)}</td></tr>
             <tr><th>Время</th><td>${esc(formatDate(lastCycle.started_at))} →
               ${esc(formatDate(lastCycle.finished_at) || 'ещё идёт')}</td></tr>
             <tr><th>Итог</th><td>слотов ${lastCycle.found}, сгенерировано
               ${lastCycle.generated}, опубликовано ${lastCycle.published}</td></tr>
             ${lastCycle.error
               ? `<tr><th>Ошибки</th><td class="hint">${esc(lastCycle.error)}</td></tr>`
               : ''}
             <tr><th>request-id</th><td><code>${esc(lastCycle.request_id)}</code></td></tr>
           </table>
           ${await runItemsTable(lastCycle.id)}
         </div>`
      : '';

    const auto = await schedulerState(map);

    return `<div class="card">
        ${bgError
          ? `<p style="margin:0 0 10px"><span class="tag off">прогон не пошёл</span>
               ${esc(bgError)}</p>`
          : ''}
        <p style="margin:0 0 10px">Автозапуск ${autoTag(map)}${
          auto.enabled
            ? (auto.due ? ', стартует в ближайшую минуту' : `, ближайший ${esc(formatDate(auto.nextAt))}`)
            : ''
        }${
          auto.failureReason
            ? ` · <span class="tag off">осечка</span> <span class="hint">${esc(auto.failureReason)}</span>`
            : ''
        }</p>
        <p style="margin:0 0 10px">Квоты на сегодня: ${quotaSummary}</p>
        ${quotaDetails ? `<p class="hint" style="margin:0 0 10px">${quotaDetails}</p>` : ''}
        <p class="hint" style="margin:0 0 10px">
          ${plan.stepMinutes
            ? `Тестовая раскладка: слоты идут через ${esc(plan.stepMinutes)} мин от запуска,
               окно публикаций не применяется. Поставьте 0 в поле ниже, чтобы вернуть
               обычный режим.`
            : `Времена слотов считаются от окна публикаций ${esc(map.posting_window_start)}-${
            esc(map.posting_window_end)} МСК${
            map.schedule_mode === 'interval'
              ? `, но не дальше чем на ${esc(map.schedule_interval_hours)} ч от старта:
                 при расписании «каждые ${esc(map.schedule_interval_hours)} ч» посты должны
                 уложиться до следующего прогона`
              : ' (расписание «раз в день» растягивает посты на всё окно)'
          }. Если окно на сегодня уже закрыто, прогон встаёт на завтрашнее.`}
        </p>
        <table id="${planClip.id}" class="${planClip.className.trim()}">
          <thead><tr><th>Слот</th><th>Группа</th><th>Материал</th><th>Время публикации</th></tr></thead>
          <tbody>${planRows}</tbody>
        </table>
        ${planClip.toggle}
        <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <form method="post" action="/run" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
            <button type="submit" data-busy="Запускаю прогон…"${plan.items.length && !busySince ? '' : ' disabled'}>${
              busySince ? 'Прогон уже идёт' : 'Запустить прогон'
            }</button>
            <!-- Два проверочных поля свёрнуты: они нужны при отладке цикла, а на главной
                 странице стояли рядом с кнопкой и выглядели как обязательные к заполнению. -->
            <details class="fold" style="width:100%">
              <summary>Проверочные настройки запуска</summary>
              <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:6px 0 2px">
                <label class="hint">не больше
                  <input type="number" name="limit_per_group" min="1" max="100" value=""
                         placeholder="все" style="width:70px"> постов на группу</label>
                <label class="hint">слот каждые
                  <input type="number" name="step_minutes" min="0" max="600"
                         value="${esc(map.test_slot_step_minutes ?? '0')}" style="width:70px">
                  мин (0 - по окну публикаций)</label>
              </div>
            </details>
          </form>
        </div>
        <p class="hint" style="margin:10px 0 0">
          Один материал уходит ровно в одну группу, порядок внутри группы - от свежих
          к старым. Прогон делает всю цепочку: текст, обложка, публикация, и работает
          в фоне - ждать страницу не нужно. Второй запуск во время первого отклоняется.
          Поле «слот каждые N мин» - тестовая раскладка: публикации встают через N минут
          от запуска в обход окна, чтобы проверить цикл целиком за минуты.${
            plan.reason && plan.items.length ? ` ${esc(plan.reason)}` : ''}
        </p>
      </div>
      ${lastBlock}`;
  }

  /** Слоты прогона: что уехало, что нет, с временем и ошибкой. */
  async function runItemsTable(runId) {
    const items = await runs.listItems(runId);
    if (items.length === 0) return '';
    const rowList = items
      .map(
        (item) => `<tr>
          <td>${item.slot_no}</td>
          <td>${esc(item.group_name)}
              <span class="hint">${esc(pmp.networkOf(item.chanel_id).short)}</span></td>
          <td>${item.post_id
              ? `<a href="/posts/${item.post_id}">${esc(item.post_title ?? `пост #${item.post_id}`)}</a>`
              : esc(item.topic_name ?? '(материал)')}</td>
          <td class="hint">${esc(formatDate(item.post_at))}</td>
          <td>${runItemTag(item)}</td>
        </tr>`,
      );
    const clip = clipRows(rowList, { limit: 12, label: 'слотов' });
    return `<table id="${clip.id}" class="${clip.className.trim()}" style="margin-top:14px">
        <thead><tr><th>Слот</th><th>Группа</th><th>Пост</th><th>Время</th><th>Состояние</th></tr></thead>
        <tbody>${clip.body}</tbody>
      </table>
      ${clip.toggle}`;
  }

  // Ручной запуск прогона — в фоне. Шесть слотов на живых провайдерах это 6-8 минут,
  // держать всё это время HTTP-ответ нельзя: закрытая вкладка оборвала бы запрос.
  // Прогресс виден в таблице слотов по обновлению страницы.
  router.post('/run', async (req, res) => {
    try {
      const raw = Number.parseInt(req.body.limit_per_group, 10);
      const limitPerGroup = Number.isNaN(raw) ? undefined : raw;
      const step = Number.parseInt(req.body.step_minutes, 10);
      // Шаг слотов сохраняем в настройки: он же применяется к плану, который панель
      // показывает до запуска, и к прогону по расписанию на этапе 9.
      if (!Number.isNaN(step)) {
        await settings.set('test_slot_step_minutes', String(Math.max(0, Math.min(600, step))));
      }

      const { started, reason } = startCycleInBackground({ kind: 'manual', limitPerGroup });
      if (!started) throw new Error(reason);

      logger.info({ кто: req.user.login, лимит: limitPerGroup ?? 'по группам' }, 'Прогон запущен из панели');
      res.redirect(
        `/?ok=${encodeURIComponent(
          'Прогон запущен в фоне. Обновляйте страницу: состояние слотов видно в таблице ниже.',
        )}`,
      );
    } catch (error) {
      logger.error(errFields(error), 'Запуск прогона из панели упал');
      res.redirect(`/?err=${encodeURIComponent(error.message)}`);
    }
  });

  /** Карточка промта: правка, история версий, откат. */
  async function promptCard(key, title, rows, hint) {
    const active = await prompts.getActive(key);
    const versions = await prompts.listVersions(key, 10);
    const history = versions
      .map(
        (item) => `<tr>
          <td>v${item.version}${item.is_active ? ' <span class="tag on">активна</span>' : ''}</td>
          <td class="hint">${item.length} симв.</td>
          <td class="hint">${esc(item.note ?? '')}</td>
          <td class="hint">${esc(item.created_by ?? '')}<br>${esc(formatDate(item.created_at))}</td>
          <td>${item.is_active ? '' : `<form class="inline" method="post"
                action="/prompts/${key}/activate/${item.version}">
                <button class="ghost small" type="submit">Вернуть эту</button></form>`}</td>
        </tr>`,
      )
      .join('\n');

    return `<div class="card">
      <h2 style="margin-top:0">${esc(title)}</h2>
      <div class="hint" style="margin-bottom:8px">
        Активна версия ${esc(active?.version ?? '—')}, ${active?.body.length ?? 0} символов. ${esc(hint)}
      </div>
      <form method="post" action="/prompts/${key}">
        <textarea name="body" rows="${rows}">${esc(active?.body ?? '')}</textarea>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="text" name="note" placeholder="что поменяли (необязательно)" style="flex:1;min-width:220px">
          <button type="submit">Сохранить новую версию</button>
        </div>
      </form>
      <h3 style="margin:18px 0 6px;font-size:14px">История версий</h3>
      <table>
        <tbody>${history}</tbody>
      </table>
    </div>`;
  }

  return router;
}

/** Миниатюра обложки в списке постов: 96 px — сразу видно, читается ли текст мелким. */
function thumbCell(item) {
  if (item.image_url) {
    return `<a href="/posts/${item.id}"><img src="${esc(item.image_url)}" alt=""
      style="width:96px;border-radius:4px;display:block"></a>`;
  }
  if (item.image_error) return `<span class="tag off">сбой</span>`;
  return '<span class="hint">нет</span>';
}

/**
 * Остаток кредитов kie.ai. Живой запрос к провайдеру, поэтому в панели он не должен
 * ломать страницу: недоступный kie.ai не повод не показать список постов.
 */
async function creditsText() {
  if (!kie.isConfigured()) return 'ключ не задан';
  try {
    const left = await kie.credits();
    return left === null ? '?' : left;
  } catch (error) {
    logger.warn(errFields(error), 'Не удалось узнать остаток кредитов kie.ai');
    return 'недоступно';
  }
}

function stat(value, label) {
  return `<div class="card stat"><div class="n">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
}

/** Счётчик для свёрнутых блоков: одна строка вместо плитки на пол-экрана. */
function statLine(value, label) {
  return `<span style="white-space:nowrap"><strong>${esc(value)}</strong>
    <span class="hint" style="margin:0">${esc(label)}</span></span>`;
}

/**
 * Длинная таблица: первые строки видны, остальные скрыты до щелчка.
 *
 * Понадобилось после этапа 7: план на сутки вырос с 15 слотов до 58 (одна тема идёт
 * в две сети), и на «Обзоре» он занимал три экрана — кнопка запуска уезжала за низ.
 * Строки не выбрасываются, а прячутся: поиск по странице их находит, и раскрыть
 * можно одним щелчком.
 *
 * @param {string[]} rows готовые `<tr>…</tr>`
 * @param {object} [options]
 * @param {number} [options.limit] сколько показать сразу
 * @param {string} [options.label] надпись раскрытия
 * @returns {{className: string, id: string, body: string, toggle: string}}
 */
let clipCounter = 0;
function clipRows(rows, { limit = 10, label = 'строк' } = {}) {
  const id = `clip${(clipCounter += 1)}`;
  if (rows.length <= limit) {
    return { className: '', id, body: rows.join('\n'), toggle: '' };
  }
  const hidden = rows.length - limit;
  const body = [
    ...rows.slice(0, limit),
    ...rows.slice(limit).map((row) => row.replace('<tr>', '<tr class="more">')),
  ].join('\n');
  const text = `Показать остальные ${hidden} ${label}`;
  return {
    className: ' clip',
    id,
    body,
    toggle: `<p class="more-toggle" data-clip="${id}" data-label="${esc(text)}">${esc(text)}</p>`,
  };
}

/**
 * Состояние подключения аккаунта в postmypost. У ВК токен истекает (по брифу — раз
 * в три месяца), и клиент должен видеть это в списке, а не узнавать из сбоя постинга.
 */
function connectionTag(group) {
  if (group.connection_status === null) return '<span class="hint">неизвестно</span>';
  if (Number(group.connection_status) === pmp.CONNECTION_OK) {
    return '<span class="tag on">подключена</span>';
  }
  return `<span class="tag off">отвалилась</span>
    <span class="hint">статус ${esc(group.connection_status)} — переподключите в postmypost</span>`;
}

/** Числовое поле формы с понятной ошибкой вместо «violates check constraint». */
function requireInt(value, min, max, label) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  if (Number.isNaN(number) || number < min || number > max) {
    throw new Error(`${label}: нужно целое число от ${min} до ${max}`);
  }
  return number;
}

function requireHhMm(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(text)) throw new Error(`${label}: нужно время в формате ЧЧ:ММ`);
  const [hours, minutes] = text.split(':').map((part) => Number.parseInt(part, 10));
  if (hours > 23 || minutes > 59) throw new Error(`${label}: такого времени не существует`);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Список id из чекбоксов формы: одна галочка приходит строкой, несколько — массивом. */
function idList(value) {
  const raw = Array.isArray(value) ? value : (value === undefined ? [] : [value]);
  return raw
    .map((item) => Number.parseInt(String(item), 10))
    .filter((item) => Number.isInteger(item));
}

function runKindText(kind) {
  return { cron: 'по расписанию', manual: 'вручную', backfill: 'добор материалов',
    source_check: 'проверка источника', archive: 'наполнение из архива' }[kind] ?? kind;
}

function archiveStatusTag(status) {
  if (status === 'done') return '<span class="tag on">завершено</span>';
  if (status === 'failed') return '<span class="tag off">сбой</span>';
  if (status === 'stopped') return '<span class="tag off">остановлено</span>';
  if (status === 'stopping') return '<span class="tag soon">останавливается</span>';
  if (status === 'collecting') return '<span class="tag soon">сбор материалов</span>';
  return '<span class="tag soon">публикует</span>';
}

function runStatusTag(status) {
  if (status === 'done') return '<span class="tag on">завершён</span>';
  if (status === 'failed') return '<span class="tag off">сбой</span>';
  return '<span class="tag soon">идёт</span>';
}

function runItemTag(item) {
  if (item.status === 'published') return '<span class="tag on">опубликован</span>';
  if (item.status === 'failed') {
    return `<span class="tag off">сбой</span> <span class="hint">${esc(item.error ?? '')}</span>`;
  }
  if (item.status === 'generated') return '<span class="tag soon">текст готов</span>';
  if (item.status === 'skipped') return '<span class="tag off">пропущен</span>';
  return '<span class="tag soon">в плане</span>';
}

function postStatusTag(status) {
  if (status === 'failed') return '<span class="tag off">сбой</span>';
  if (status === 'published') return '<span class="tag on">опубликован</span>';
  return '<span class="tag soon">готов</span>';
}

/** Включён ли автозапуск прогонов. Отдельный тег: это главный переключатель системы. */
function autoTag(map) {
  return map.schedule_enabled === 'on'
    ? '<span class="tag on">включён</span>'
    : '<span class="tag off">выключен</span>';
}

function publishModeTag(mode) {
  return mode === 'live'
    ? '<span class="tag on">реальная публикация</span>'
    : '<span class="tag soon">черновики</span>';
}

function discoveryText(item) {
  if (item.discovery === 'sitemap') return `sitemap: ${item.sitemap_pattern}`;
  return 'свой адаптер';
}

function fetchViaText(via) {
  if (via === 'wp_api') return 'WP REST API';
  if (via === 'firecrawl') return 'firecrawl';
  return 'прямой запрос';
}

/** Тема материала: ключ дедупа и то, откуда он получен (подсказка/заголовок/адрес). */
function topicCell(item) {
  if (!item.topic_key) return '<span class="hint">—</span>';
  const via = { hint: 'из подсказки', title: 'из заголовка', slug: 'из адреса' }[item.topic_via];
  return `<code>${esc(item.topic_key)}</code><br><span class="hint">${esc(via ?? '')}</span>`;
}

function statusTag(item) {
  if (item.status === 'failed') {
    return `<span class="tag soon">сбой</span> <span class="hint">${esc(item.skip_reason ?? '')}</span>`;
  }
  // Отклонённый материал показывает причину: дубль темы (с номером «победителя»)
  // или служебная страница-листинг.
  if (item.status === 'duplicate') {
    return `<span class="tag off">отклонён</span> <span class="hint">${esc(item.skip_reason ?? 'дубль темы')}</span>`;
  }
  if (item.status === 'skipped') {
    return `<span class="tag off">пропущен</span> <span class="hint">${esc(item.skip_reason ?? '')}</span>`;
  }
  if (item.content_mode === 'topic_only') {
    return '<span class="tag on">тема готова</span> <span class="hint">текст не нужен</span>';
  }
  if (item.has_text) {
    return `<span class="tag on">текст есть</span> <span class="hint">${item.text_len} симв.</span>`;
  }
  return '<span class="tag off">ждёт извлечения</span>';
}

/**
 * Очередь источника прямо в списке: меньше число — раньше берём его темы.
 * Три готовых значения вместо числового поля: клиенту нужно «этот последним»,
 * а не тонкая раскладка, при этом в базе лежит число и промежуточные значения
 * при необходимости выставляются руками.
 */
function priorityForm(item) {
  const current = Number(item.priority ?? 100);
  const options = [
    [10, 'берём первым'],
    [100, 'обычная очередь'],
    [900, 'берём последним'],
  ]
    .map(([value, label]) =>
      `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`)
    .join('');
  return `<form class="inline" method="post" action="/sources/${item.id}/priority">
    <select name="priority" onchange="this.form.submit()"
            style="width:auto;padding:2px 6px;font-size:12px">${options}</select>
    <noscript><button class="ghost small" type="submit">ОК</button></noscript>
  </form>`;
}

function buildSourceMessage(q) {
  if (q.err) return { kind: 'err', text: String(q.err) };
  if (q.ok) return { kind: 'ok', text: String(q.ok) };
  return null;
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

/** Сколько шёл прогон. Секунды до минуты, дальше минуты — точнее в панели не нужно. */
/** Границы длины поста человеческой строкой: ноль означает «без ограничения». */
function postLengthLabel(map) {
  const min = Number.parseInt(map.post_min_chars ?? '0', 10) || 0;
  const max = Number.parseInt(map.post_max_chars ?? '0', 10) || 0;
  if (min > 0 && max > 0) return `${min}-${max} символов`;
  if (min > 0) return `от ${min} символов, верхней границы нет`;
  if (max > 0) return `до ${max} символов`;
  return 'без ограничений';
}

function durationText(from, to) {
  if (!from || !to) return '';
  const seconds = Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000));
  if (seconds < 60) return `${seconds} c`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин ${seconds % 60} c`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

/**
 * Откуда взялся материал поста. Для собранного поиском показываем ссылки: пост
 * написан по чужим страницам, и клиент должен иметь возможность его проверить.
 */
function materialOrigin(post) {
  if (post.content_via !== 'search') {
    return post.article_url
      ? 'статья источника'
      : 'только тема, текста не было';
  }
  const urls = Array.isArray(post.research_urls) ? post.research_urls : [];
  const list = urls
    .map((url) => `<li><a href="${esc(url)}" target="_blank" rel="noopener">${esc(cut(url, 80))}</a></li>`)
    .join('');
  return `<span class="tag soon">собран поиском</span>
    <span class="hint">${esc(formatDate(post.research_at))}</span>
    ${list ? `<ul class="hint" style="margin:6px 0 0;padding-left:18px">${list}</ul>` : ''}`;
}

function cut(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * Счётчики прогона по шагам конвейера. У проверки источника смысл колонок другой:
 * «найдено» там — новые материалы, а генерации и публикации не бывает вовсе.
 */
function runCountersText(run) {
  if (run.kind === 'source_check') {
    const meta = run.meta ?? {};
    return `новых материалов ${run.found}` +
      (meta.discovered ? ` <span class="hint">из ${esc(meta.discovered)} найденных</span>` : '') +
      (meta.extracted ? `, текстов ${esc(meta.extracted)}` : '');
  }
  return `слотов ${run.items ?? run.found}, текстов ${run.generated}, опубликовано ${run.published}` +
    (run.items_failed ? ` <span class="tag off">сбоев ${run.items_failed}</span>` : '');
}

/** С чем связан сбой: пост, группа, материал, источник — что известно, то и показываем. */
function errorContext(item) {
  const parts = [];
  if (item.run_id) parts.push(`<a href="/runs/${item.run_id}">прогон #${item.run_id}</a>`);
  if (item.post_id) parts.push(`<a href="/posts/${item.post_id}">пост #${item.post_id}</a>`);
  if (item.group_name) parts.push(esc(item.group_name));
  if (item.source_name) parts.push(esc(item.source_name));
  if (item.topic_name) parts.push(esc(item.topic_name));
  return parts.join(' · ') || '—';
}

/**
 * Ссылка «куда уехал пост». У реальной публикации это запись на стене (адрес
 * приходит из postmypost кнопкой), у черновика записи ещё нет — ведём на группу,
 * чтобы ссылка в логе всегда была рабочей, а не мёртвой.
 */
function vkLinkCell(item) {
  if (item.vk_url) {
    return `<a href="${esc(item.vk_url)}" target="_blank" rel="noopener">пост ↗</a>`;
  }
  const wall = groupWallUrl(item);
  const refresh = item.pmp_publication_id
    ? `<form class="inline" method="post" action="/publications/${item.id}/vk-link">
         <input type="hidden" name="back" value="/published">
         <button class="ghost small" type="submit">Найти ссылку</button>
       </form>`
    : '';
  return `${wall ? `<a href="${esc(wall)}" target="_blank" rel="noopener">группа ↗</a> ` : ''}${refresh}`;
}

/**
 * Адрес сообщества: по короткому имени, а если его нет — по числовому id.
 * У ВК это vk.com/club<id> (минус в id сообщества отбрасывается), у Одноклассников
 * ok.ru/group/<id>.
 */
function groupWallUrl(item) {
  const ok = Number(item.group_chanel_id) === pmp.CHANEL_OK;
  if (item.group_login) return `https://${ok ? 'ok.ru' : 'vk.com'}/${item.group_login}`;
  const external = String(item.group_external_id ?? '').trim();
  if (!/^-?\d+$/.test(external)) return null;
  const digits = external.replace('-', '');
  return ok ? `https://ok.ru/group/${digits}` : `https://vk.com/club${digits}`;
}

/** Метка соцсети рядом с названием группы. */
function networkTag(group) {
  const net = pmp.networkOf(group.chanel_id);
  return `<span class="tag ${net.code === 'ok' ? 'soon' : 'off'}">${esc(net.title)}</span>`;
}

/** Только дата: у периода наполнения времени нет, и «00:00:00» в нём выглядит мусором. */
function formatDay(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
}
