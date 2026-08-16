/**
 * Расписание прогонов и раскладка публикаций по времени.
 *
 * Время везде местное — контейнер живёт в `Europe/Moscow` (`tzdata` поставлен на этапе 0
 * именно ради этого), поэтому `new Date(...)` и `getHours()` уже дают МСК. Отдельной
 * арифметики с оффсетом здесь нет: она нужна только на границе с postmypost
 * (`pmp.moscowIso`), где формат требует явного `+03:00`.
 */

/** «10:00» → {hours: 10, minutes: 0}. Мусор на входе не роняет прогон. */
export function parseHhMm(value, fallback = '10:00') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  const source = match ? match : /^(\d{1,2}):(\d{2})$/.exec(fallback);
  const hours = Math.min(23, Math.max(0, Number.parseInt(source[1], 10)));
  const minutes = Math.min(59, Math.max(0, Number.parseInt(source[2], 10)));
  return { hours, minutes };
}

function atTime(base, { hours, minutes }) {
  const date = new Date(base);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function addDays(base, days) {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * Когда прогон должен стартовать в следующий раз.
 *
 * Два режима из настроек:
 * - `interval` — каждые N часов от последнего прогона (если прогонов не было, от «сейчас»);
 * - `daily` — ежедневно в заданное время.
 *
 * @param {object} settingsMap значения из settings (schedule_mode, schedule_interval_hours, schedule_daily_at)
 * @param {Date|string|null} lastRunAt старт последнего прогона
 * @param {Date} [now]
 */
export function nextRunAt(settingsMap, lastRunAt = null, now = new Date()) {
  const mode = settingsMap.schedule_mode === 'interval' ? 'interval' : 'daily';

  if (mode === 'interval') {
    const hours = Math.max(1, Number.parseInt(settingsMap.schedule_interval_hours ?? '5', 10) || 5);
    const from = lastRunAt ? new Date(lastRunAt) : new Date(now);
    let next = new Date(from.getTime() + hours * 3600_000);
    // Пропущенные интервалы не копим: если контейнер стоял сутки, следующий запуск
    // не «через час назад», а ближайший будущий.
    while (next <= now) next = new Date(next.getTime() + hours * 3600_000);
    return next;
  }

  const at = parseHhMm(settingsMap.schedule_daily_at, '10:00');
  const today = atTime(now, at);
  return today > now ? today : atTime(addDays(now, 1), at);
}

/**
 * Пора ли запускать прогон прямо сейчас.
 *
 * Отдельная функция, а не сравнение с `nextRunAt`: та по определению возвращает время
 * в будущем, и «наступило ли оно» по ней не проверить — момент запуска пролетел бы
 * между тиками. Здесь смотрим назад: с какого момента прогон должен был состояться
 * и был ли он с тех пор.
 *
 * @param {object} settingsMap настройки расписания
 * @param {Date|string|null} anchor точка отсчёта: старт последнего прогона, а если
 *   прогонов ещё не было — момент включения автозапуска. Без якоря не запускаем:
 *   иначе «каждые N часов» срабатывало бы на первом же тике после старта контейнера.
 * @param {Date} [now]
 */
export function isRunDue(settingsMap, anchor, now = new Date()) {
  if (!anchor) return false;
  const from = new Date(anchor);
  if (Number.isNaN(from.getTime())) return false;

  if (settingsMap.schedule_mode === 'interval') {
    const hours = Math.max(1, Number.parseInt(settingsMap.schedule_interval_hours ?? '5', 10) || 5);
    return now.getTime() - from.getTime() >= hours * 3600_000;
  }

  // Ежедневный режим: положенный момент сегодня уже прошёл, а прогона с тех пор не было.
  const at = parseHhMm(settingsMap.schedule_daily_at, '10:00');
  const today = atTime(now, at);
  const due = today <= now ? today : atTime(addDays(now, -1), at);
  return from < due;
}

export function scheduleText(settingsMap) {
  return settingsMap.schedule_mode === 'interval'
    ? `каждые ${settingsMap.schedule_interval_hours} ч`
    : `ежедневно в ${settingsMap.schedule_daily_at} МСК`;
}

/**
 * Времена публикаций для `count` постов: равномерные слоты внутри окна постинга
 * плюс случайный сдвиг. Всё в одну минуту не сваливается — это антиспам-требование
 * брифа, и в ВК подряд идущие посты в одну секунду выглядят как бот.
 *
 * @param {number} count сколько слотов нужно
 * @param {object} options
 * @param {Date} [options.now]
 * @param {string} [options.windowStart] «10:00»
 * @param {string} [options.windowEnd] «21:00»
 * @param {number} [options.leadMinutes] минимальный отрыв от «сейчас» (postmypost не любит прошлое)
 * @param {number} [options.jitterMinutes] максимальный случайный сдвиг внутри слота
 * @param {number} [options.maxSpanMinutes] не растягивать дальше, чем на столько минут
 *   от начала: при расписании «каждые N часов» посты должны уложиться до следующего
 *   прогона, иначе слоты соседних прогонов наложатся друг на друга
 * @param {number} [options.stepMinutes] тестовая раскладка: слоты идут строго через
 *   столько минут от «сейчас», окно публикаций игнорируется. Нужно, чтобы проверить
 *   весь цикл за минуты, а не ждать вечернего слота.
 * @returns {Date[]} времена по возрастанию, минуты не повторяются
 */
export function slotTimes(count, {
  now = new Date(),
  windowStart = '10:00',
  windowEnd = '21:00',
  leadMinutes = 3,
  jitterMinutes = 7,
  maxSpanMinutes = null,
  stepMinutes = null,
} = {}) {
  if (count <= 0) return [];

  // Тестовая раскладка: ни окна, ни джиттера — предсказуемые «через 3, 6, 9 минут».
  if (stepMinutes) {
    const step = Math.max(1, stepMinutes) * 60_000;
    const first = now.getTime() + Math.max(1, leadMinutes) * 60_000;
    return Array.from({ length: count }, (_, index) =>
      new Date(Math.floor((first + step * index) / 60_000) * 60_000));
  }

  const earliest = new Date(now.getTime() + leadMinutes * 60_000);
  let start = atTime(now, parseHhMm(windowStart, '10:00'));
  let end = atTime(now, parseHhMm(windowEnd, '21:00'));
  if (end <= start) end = atTime(addDays(now, 1), parseHhMm(windowEnd, '21:00'));
  if (earliest > start) start = earliest;

  // Окно на сегодня уже закрылось (или закроется раньше, чем мы успеем) — переносим
  // весь прогон на завтрашнее окно целиком, а не поджимаем посты к полуночи.
  if (start >= end) {
    start = atTime(addDays(now, 1), parseHhMm(windowStart, '10:00'));
    end = atTime(addDays(now, 1), parseHhMm(windowEnd, '21:00'));
    if (end <= start) end = new Date(start.getTime() + 3600_000);
  }

  // Потолок по длине прогона (интервальное расписание). Меньше минуты на пост не даём:
  // иначе при коротком интервале все посты слипнутся в начало.
  if (maxSpanMinutes) {
    const capped = start.getTime() + Math.max(maxSpanMinutes, count) * 60_000;
    if (capped < end.getTime()) end = new Date(capped);
  }

  const span = end.getTime() - start.getTime();
  const step = count > 1 ? span / count : span;
  const jitterMs = Math.max(0, jitterMinutes) * 60_000;

  const times = [];
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const base = start.getTime() + step * index;
    const jitter = Math.floor(Math.random() * Math.min(jitterMs, Math.max(0, step / 2)));
    let ms = Math.min(base + jitter, end.getTime());
    // Минуты не должны повторяться: postmypost округляет `post_at` до минуты, и два
    // поста с одинаковым временем выглядят как один залп.
    ms = Math.max(ms, previous + 60_000);
    previous = ms;
    times.push(new Date(Math.floor(ms / 60_000) * 60_000));
  }
  return times;
}
