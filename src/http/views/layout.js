/**
 * Минимальный слой представления на шаблонных строках — без движка шаблонов.
 * Панель служебная, страниц мало, зависимость не оправдана.
 */

import { config } from '../../config.js';

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const NAV = [
  { href: '/', title: 'Обзор' },
  { href: '/groups', title: 'Группы' },
  { href: '/sources', title: 'Источники' },
  { href: '/posts', title: 'Посты' },
  { href: '/settings', title: 'Настройки' },
  { href: '/prompts', title: 'Промты' },
  { href: '/manual', title: 'Ручной режим' },
  { href: '/archive', title: 'Из архива' },
  { href: '/runs', title: 'Прогоны' },
  { href: '/published', title: 'Опубликовано' },
];

/**
 * Меню. «Ошибки» попадают в него только когда журнал живёт на обычном `/errors`.
 * Если `DIAG_PATH` задан своей строкой, ссылки в меню быть не должно: смысл настройки —
 * чтобы адрес журнала знал только владелец, а меню видит любой, кто вошёл в панель.
 */
function navItems() {
  if (config.diagPath === 'errors') {
    return [...NAV, { href: '/errors', title: 'Ошибки' }];
  }
  return NAV;
}

const STYLES = `
  :root {
    --bg: #f6f7f9; --panel: #fff; --line: #e3e6ea; --text: #1c2126;
    --muted: #6b7480; --accent: #2f6feb; --accent-weak: #eaf0fe;
    --warn: #b4530a; --warn-weak: #fdf3e7; --ok: #1a7f4b; --ok-weak: #eaf7f0;
    --err: #b3261e; --err-weak: #fdecea;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
         background: var(--bg); color: var(--text); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .shell { display: flex; min-height: 100vh; }
  aside { width: 220px; flex: 0 0 220px; background: var(--panel);
          border-right: 1px solid var(--line); padding: 18px 0; }
  aside .brand { padding: 0 18px 16px; font-weight: 600; font-size: 16px; }
  aside .brand small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
  aside nav a { display: block; padding: 9px 18px; color: var(--text); border-left: 3px solid transparent; }
  aside nav a:hover { background: var(--bg); text-decoration: none; }
  aside nav a.active { border-left-color: var(--accent); background: var(--accent-weak);
                       color: var(--accent); font-weight: 500; }
  aside .foot { margin-top: 22px; padding: 14px 18px 0; border-top: 1px solid var(--line);
                font-size: 13px; color: var(--muted); }
  /* 1280, а не 1100: в «Источниках» девять колонок, и на прежней ширине последняя
     (кнопки) уезжала под правый край карточки. */
  main { flex: 1; padding: 26px 30px; max-width: 1280px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { margin: 26px 0 10px; font-size: 17px; }
  .sub { color: var(--muted); margin: 0 0 22px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
          padding: 18px 20px; margin-bottom: 18px;
          /* Таблица с длинными адресами шире карточки: без прокрутки последняя колонка
             («Состояние» в списке материалов) вылезала за правую границу. */
          overflow-x: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
  .stat .n { font-size: 26px; font-weight: 600; }
  .stat .l { color: var(--muted); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line);
           vertical-align: top;
           /* break-word, а НЕ anywhere: anywhere учитывается при расчёте минимальной
              ширины колонки: браузер решал, что любая ячейка может ужаться до одной
              буквы, и раскладывал таблицу лесенкой («cry ptor ussi a»). break-word рвёт
              слово только тогда, когда оно физически не влезает в уже отданную ширину. */
           overflow-wrap: break-word; }
  /* Длинный адрес — единственное, что действительно нужно рвать по любому месту:
     иначе он один задаёт ширину таблицы и выталкивает её за границу карточки. */
  td a, td code { overflow-wrap: anywhere; }
  /* Короткие пометки не переносим: места им нужно немного, а по букве они
     разваливались особенно заметно. Заголовки переносить можно — в широких
     таблицах («Источники» — девять колонок) они и держат лишнюю ширину. */
  td .tag, td.nowrap, th.nowrap { white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  code { background: var(--bg); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 20px; font-size: 12px; }
  .tag.on { background: var(--ok-weak); color: var(--ok); }
  .tag.off { background: var(--bg); color: var(--muted); }
  .tag.soon { background: var(--warn-weak); color: var(--warn); }
  form.inline { display: inline; }
  label { display: block; margin-bottom: 5px; font-size: 13px; color: var(--muted); }
  input[type=text], input[type=password], input[type=number], input[type=date], select, textarea {
    width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 6px;
    font: inherit; background: #fff; color: var(--text); }
  input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent-weak);
    border-color: var(--accent); }
  .field { margin-bottom: 14px; }
  button, .btn { padding: 9px 16px; border: 1px solid var(--accent); background: var(--accent);
    color: #fff; border-radius: 6px; font: inherit; cursor: pointer; }
  button.ghost { background: #fff; color: var(--text); border-color: var(--line); }
  button.small { padding: 5px 11px; font-size: 13px; }
  .msg { padding: 11px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
  .msg.err { background: var(--err-weak); color: var(--err); }
  .msg.ok { background: var(--ok-weak); color: var(--ok); }
  .msg.info { background: var(--accent-weak); color: var(--accent); }
  .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login-card { width: 340px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 26px; }
  .login-card h1 { font-size: 19px; margin-bottom: 18px; }
  .hint { color: var(--muted); font-size: 13px; margin-top: 6px; }
  .empty { color: var(--muted); padding: 8px 0; }
`;

/** Страница внутри панели: сайдбар + контент. */
/**
 * Занятость формы: нажатая кнопка гаснет и говорит, что происходит.
 *
 * Панель работает без ajax — генерация поста это обычный POST, который живёт
 * десятки секунд (модель + валидация + до трёх повторов). Без индикации кнопка
 * выглядит нерабочей, и её жмут повторно: получается второй прогон генерации
 * за те же деньги.
 *
 * Тонкости, которые легко потерять:
 *   - `disabled` ставится через setTimeout, а НЕ сразу: отключённая кнопка не попадает
 *     в тело запроса, а половина форм панели различает действия именно по `name`
 *     кнопки. Ставим после того, как браузер собрал данные формы.
 *   - Возврат «назад» отдаёт страницу из bfcache в том же состоянии — на `pageshow`
 *     всё возвращается, иначе кнопка остаётся серой навсегда.
 *   - Текст берётся из `data-busy` кнопки, если он там задан.
 */
const BUSY_SCRIPT = `
document.addEventListener('submit', function (event) {
  if (event.defaultPrevented) return;
  var form = event.target;
  var button = event.submitter || form.querySelector('button[type=submit], button:not([type])');
  if (!button || button.dataset.busyOn) return;
  button.dataset.busyOn = '1';
  button.dataset.busyText = button.textContent;
  button.textContent = button.dataset.busy || 'Выполняется…';
  document.documentElement.style.cursor = 'progress';
  setTimeout(function () { button.disabled = true; }, 0);
});
window.addEventListener('pageshow', function () {
  document.documentElement.style.cursor = '';
  document.querySelectorAll('button[data-busy-on]').forEach(function (button) {
    button.disabled = false;
    button.textContent = button.dataset.busyText;
    delete button.dataset.busyOn;
  });
});
`;

/**
 * Версия выката в подвале. Значение приходит из APP_REVISION — его подставляет
 * `deploy/deploy.sh` из `git rev-parse --short HEAD`. Это та самая видимая строка,
 * по которой на приёмке проверяется, что пуш в `master` доехал до прода сам.
 * Локально переменной нет — строку не показываем вовсе.
 */
function revisionLine() {
  if (!config.revision) return '';
  return `<div style="margin-top:10px;font-size:12px">версия <code>${esc(config.revision)}</code></div>`;
}

export function page({ title, active, user, heading, sub, body, message }) {
  const nav = navItems().map(
    (item) =>
      `<a href="${item.href}"${item.href === active ? ' class="active"' : ''}>${esc(item.title)}</a>`,
  ).join('\n');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Автопостинг ВК</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
  <aside>
    <div class="brand">Автопостинг ВК<small>панель управления</small></div>
    <nav>${nav}</nav>
    <div class="foot">
      Вход: <strong>${esc(user?.login ?? '')}</strong><br>
      <a href="/account">Сменить пароль</a><br>
      <form method="post" action="/logout" style="margin-top:10px">
        <button class="ghost small" type="submit">Выйти</button>
      </form>
      ${revisionLine()}
    </div>
  </aside>
  <main>
    <h1>${esc(heading ?? title)}</h1>
    ${sub ? `<p class="sub">${sub}</p>` : ''}
    ${renderMessage(message)}
    ${body}
  </main>
</div>
<script>${BUSY_SCRIPT}</script>
</body>
</html>`;
}

export function renderMessage(message) {
  if (!message) return '';
  const kind = message.kind === 'err' ? 'err' : message.kind === 'ok' ? 'ok' : 'info';
  return `<div class="msg ${kind}">${esc(message.text)}</div>`;
}

/** Страница входа — без сайдбара. */
export function loginPage({ login = '', next = '/', message } = {}) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход — Автопостинг ВК</title>
<style>${STYLES}</style>
</head>
<body>
<div class="login-wrap">
  <div class="login-card">
    <h1>Вход в панель</h1>
    ${renderMessage(message)}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <div class="field">
        <label for="login">Логин</label>
        <input id="login" name="login" type="text" autocomplete="username"
               value="${esc(login)}" required autofocus>
      </div>
      <div class="field">
        <label for="password">Пароль</label>
        <input id="password" name="password" type="password"
               autocomplete="current-password" required>
      </div>
      <button type="submit" style="width:100%">Войти</button>
    </form>
  </div>
</div>
</body>
</html>`;
}
