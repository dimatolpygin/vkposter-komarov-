/**
 * Раздача материалов по группам.
 *
 * Вынесено из планировщика, потому что раздают двое: обычный прогон (`plan-run.js`)
 * и наполнение из архива (`archive-fill.js`). Правила у них должны совпадать —
 * иначе «одна тема в ВК и в ОК» работало бы в одном режиме и не работало в другом.
 *
 * Ключевое правило зеркалирования: сети раздаются **независимо, из одного и того же
 * списка**. Материал №1 уходит в первую группу ВК и в первую группу ОК, материал №2 —
 * во вторые, и так далее. Внутри одной сети пересечений нет (курсор общий на сеть),
 * между сетями — есть, и это ровно то, что просил клиент: одна статья видна в поиске
 * и как пост ВК, и как пост ОК.
 *
 * Следствие, о котором стоит помнить: тем в день нужно не «сумма квот», а «максимум
 * квоты по сети». Пятнадцать групп ВК и три группы ОК — это 15 тем, из которых три
 * продублируются в ОК, а не 18 разных.
 */

/**
 * Сеть группы. Поле в БД называется `chanel_id` — опечатка из API postmypost.
 *
 * Двойка вписана числом, а не взята из `lib/postmypost.js` намеренно: этот файл —
 * чистая арифметика раздачи, и тянуть за собой клиент внешнего API (а с ним логгер
 * и конфиг) ему незачем. Проверять раздачу так можно одним `node` без окружения.
 */
export function networkOfGroup(group) {
  return Number(group?.chanel_id ?? 2);
}

/**
 * Разложить квоты по сетям, сохранив порядок групп.
 * @returns {Array<[number, Array]>} пары «сеть — её квоты», сети в порядке первой группы
 */
export function byNetwork(quotas) {
  const map = new Map();
  for (const item of quotas) {
    const net = networkOfGroup(item.group);
    if (!map.has(net)) map.set(net, []);
    map.get(net).push(item);
  }
  return [...map.entries()];
}

/**
 * Раздача по кругу: группы получают материалы по очереди, поэтому наборы групп
 * не пересекаются, а внутри группы сохраняется порядок списка (от свежих к старым).
 *
 * @param {Array<{group: object, left: number}>} quotas сколько ещё влезет в каждую группу
 * @param {Array} pool кандидаты в порядке приоритета
 * @returns {Array<{group: object, candidate: object}>}
 */
export function dealRoundRobin(quotas, pool) {
  const left = quotas.map((item) => ({ group: item.group, left: Math.max(0, item.left) }));
  const out = [];
  let cursor = 0;
  while (cursor < pool.length && left.some((item) => item.left > 0)) {
    let placed = false;
    for (const slot of left) {
      if (slot.left === 0 || cursor >= pool.length) continue;
      out.push({ group: slot.group, candidate: pool[cursor] });
      cursor += 1;
      slot.left -= 1;
      placed = true;
    }
    if (!placed) break;
  }
  return out;
}

/**
 * Сшить раздачи разных сетей в один порядок слотов.
 *
 * Не «сначала все ВК, потом все ОК»: слоты идут по времени, и такой порядок увёл бы
 * все посты ОК в конец окна публикаций. Берём по одному из каждой сети по очереди.
 */
export function interleave(lists) {
  const out = [];
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      if (index < list.length) out.push(list[index]);
    }
  }
  return out;
}

/**
 * Раздать один пул кандидатов с учётом режима зеркалирования.
 *
 * @param {Array<{group: object, left: number}>} quotas
 * @param {Array} pool
 * @param {boolean} mirror раздавать сети независимо (одна тема в ВК и в ОК)
 * @returns {{assignments: Array, used: number}} `used` — сколько кандидатов из пула
 *   реально израсходовано: при зеркалировании это максимум по сетям, а не сумма.
 */
export function dealPool(quotas, pool, mirror) {
  if (!mirror) {
    const assignments = dealRoundRobin(quotas, pool);
    return { assignments, used: assignments.length };
  }
  const perNetwork = byNetwork(quotas).map(([, netQuotas]) => dealRoundRobin(netQuotas, pool));
  return {
    assignments: interleave(perNetwork),
    used: perNetwork.reduce((max, list) => Math.max(max, list.length), 0),
  };
}

/**
 * Сколько разных материалов нужно, чтобы закрыть эти квоты.
 * При зеркалировании — максимум по сети, иначе — сумма.
 */
export function materialsNeeded(quotas, mirror) {
  const total = (list) => list.reduce((sum, item) => sum + Math.max(0, item.left), 0);
  if (!mirror) return total(quotas);
  return byNetwork(quotas).reduce((max, [, netQuotas]) => Math.max(max, total(netQuotas)), 0);
}
