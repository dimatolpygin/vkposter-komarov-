/**
 * Тема материала = название проекта, о котором написан обзор.
 *
 * Зачем нормализация: один проект приходит с шести сайтов в разном написании —
 * «Atlas capital: обман и невыплаты брокера. Отзывы», «atlas-capital-otzyvy»,
 * «Отзывы о atlascapital.com». Публиковать три поста про одно и то же нельзя,
 * поэтому название приводится к машинному ключу: транслит кириллицы, срез слов-шумов
 * («отзывы», «развод», «обзор», «мошенничество»), срез доменных зон, только [a-z0-9].
 *
 * Заголовок есть далеко не всегда: обнаружение через sitemap отдаёт только URL с lastmod,
 * заголовок появляется лишь после извлечения текста. Поэтому ключ считается из трёх
 * источников по убыванию надёжности: подсказка адаптера → заголовок → slug адреса.
 * Все полученные варианты возвращаются вместе (aliases): заголовок и slug нормализуются
 * по-разному, и сверять дубль надо по всем сразу.
 */

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'ju', я: 'ja',
  і: 'i', ї: 'i', є: 'e', ґ: 'g',
};

/**
 * Слова-шумы: жанр материала, вердикт, канал распространения, предлоги.
 * Всё это встречается и в заголовках, и в slug'ах, но проектом не является.
 * Список в транслите — приводится уже после перевода кириллицы в латиницу.
 */
const NOISE = new Set([
  // жанр и вердикт
  'otzyv', 'otzyvy', 'otzyvi', 'otzyvov', 'otziv', 'otzivy', 'otzyvah', 'review', 'reviews',
  'obzor', 'obzory', 'obzora', 'razvod', 'razvodit', 'lohotron', 'moshennichestvo',
  'moshenniki', 'moshennik', 'moshennicheskij', 'obman', 'obmanshiki', 'obmanyvaet',
  'zhaloba', 'zhaloby', 'zhalob', 'skam', 'scam', 'proverka', 'proveryaem', 'pravda',
  'chestnyj', 'chestnyi', 'chestno', 'realnye', 'realnyj', 'nadezhnyj', 'nevyplaty',
  'riski', 'risk', 'veliki', 'skrytye', 'komissii', 'vyvod', 'deneg', 'doveryat',
  'doverjat', 'mozhno', 'stoit', 'rabotaet', 'rabota', 'zarabotok', 'razoblachenie',
  // канал распространения
  'kanal', 'kanaly', 'kanalov', 'telegram', 'telegramm', 'tg', 'youtube', 'instagram',
  'vk', 'sajt', 'sajta', 'site', 'blog', 'stati', 'statya',
  // сущность
  'proekt', 'proekta', 'proekte', 'broker', 'brokera', 'brokerov', 'trejder', 'treider',
  'trader', 'kompaniya', 'kompanii', 'kompanija', 'investicionnogo', 'investicionnaya',
  'investicionnoj', 'klientov', 'kriptovalyutnyj',
  // обломки адреса: тема, обнаруженная по slug, иногда начинается прямо с протокола
  // («https-playfortunage8d959-com-ru-login»), и «https» уезжало в название проекта.
  // Проверить пост по такому названию нельзя ни при каком тексте.
  'http', 'https', 'www', 'html', 'php', 'index', 'login',
  // служебные части речи и мусор
  'ili', 'net', 'da', 'ne', 'i', 'v', 'o', 'ob', 'obo', 'na', 's', 'so', 'po', 'iz',
  'dlya', 'kak', 'chto', 'eto', 'vse', 'li', 'a', 'no', 'the', 'of', 'and',
  '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026', 'god', 'goda',
]);

/** Доменные зоны: «atlascapital.com» и «atlascapital» — один проект. */
const TLDS = new Set([
  'com', 'ru', 'net', 'org', 'io', 'pro', 'online', 'top', 'xyz', 'today', 'info',
  'biz', 'su', 'cc', 'shop', 'store', 'space', 'website', 'link', 'live', 'vip',
]);

/**
 * Разделы сайтов, а не материалы. Такие адреса попадают в sitemap наравне со статьями
 * (`cryptorussia.ru/services` — страница-листинг на 20 тысяч символов) и, если их не
 * отсечь, уходят в генерацию как «проект».
 */
const SECTION_SLUGS = new Set([
  'services', 'uslugi', 'blog', 'obzory', 'obzor', 'zhaloby', 'stati', 'news', 'novosti',
  'category', 'tag', 'page', 'otzyvy', 'reviews', 'rating', 'reyting', 'blacklist',
  'author', 'feed', 'search', 'sitemap', 'kontakty', 'contacts', 'about', 'o-nas', 'check',
  'glavnaya', 'home', 'index', 'archive', 'arhiv', 'shop', 'cart',
]);

/** Сегменты пути в декодированном виде: у kaper.pro адреса в percent-encoded кириллице. */
function pathSegments(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Страница-листинг, а не материал: корень сайта, одиночный сегмент из списка разделов,
 * либо пагинация. Адреса с query-строкой не трогаем — у scama.net темы живут именно там
 * (`/check?id=112136`), и путь `check` формально выглядит разделом.
 */
export function isListingUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const segments = pathSegments(raw);
  if (segments.length === 0) return true;
  if ([...parsed.searchParams.keys()].length > 0) return false;

  const last = segments.at(-1).toLowerCase();
  if (/^\d+$/.test(last)) return true; // /blog/2 — пагинация
  return segments.length === 1 && SECTION_SLUGS.has(last);
}

function translit(text) {
  let out = '';
  for (const char of text.toLowerCase()) {
    out += TRANSLIT[char] ?? char;
  }
  return out;
}

/** Токены латиницей: кириллица переведена, всё непечатное стало границей слова. */
function tokenize(text) {
  return translit(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Значимые токены названия. Порядок сохраняется, шум и доменные зоны выброшены,
 * длина ограничена: у части источников slug содержит половину заголовка
 * («finoko-otzyvy-o-finansovoy-analitike-i-zaschite-dannyh»), и без ограничения
 * ключ превращается во всю фразу.
 */
const MAX_TOKENS = 3;

/**
 * Сворачивание транслитерационных вариантов.
 *
 * Одно и то же название приходит и латиницей с сайта, и кириллицей с другого:
 * «Atlas capital» → atlascapital, «Атлас Капитал» → atlaskapital. Отличие в одной
 * букве, а проект один. Поэтому ключ приводится к сокращённому алфавиту: c→k, w→v,
 * x→ks, y/j→i, сдвоенные буквы схлопываются. Преобразование применяется к обеим
 * сторонам сравнения, поэтому остаётся согласованным (ch → kh везде).
 *
 * Цена — редкие ложные склейки очень похожих названий. Для этой предметной области
 * цена оправдана: пропущенный дубль означает два поста про один проект в одной группе.
 */
function fold(key) {
  return key
    .replace(/c/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/q/g, 'k')
    .replace(/[yj]/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Текст в свёрнутом транслите — для сравнений «кириллица против латиницы»
 * за пределами этого модуля (проверка поста в text-clean).
 */
export function foldLatin(text) {
  return fold(translit(String(text ?? '')));
}

/**
 * Значимые слова названия — то, что реально называет проект, без жанрового хвоста.
 *
 * Название темы часто равно slug'у адреса («xrp-turbo-io-razoblachenie»): при
 * обнаружении через sitemap заголовка ещё нет. Для сверки дублей это неважно,
 * а вот проверять по такой строке текст поста нельзя — модель пишет «XRP Turbo»
 * и никогда не напишет «razoblachenie». Возвращаем и исходные слова, и свёрнутый
 * транслит: название бывает латиницей, а пост — кириллицей, и наоборот.
 *
 * @returns {{words: string[], folded: string[]}}
 */
export function projectTokens(name) {
  if (!name) return { words: [], folded: [] };
  const words = String(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .filter((word) => {
      const latin = translit(word.toLowerCase());
      return !NOISE.has(latin) && !TLDS.has(latin);
    });
  return {
    words,
    folded: words.map((word) => fold(translit(word.toLowerCase()))),
  };
}

/**
 * Название для поискового запроса. Отличается от `projectDisplayName` одним:
 * доменная зона сохраняется, а точка не считается границей слова.
 *
 * Причина конкретная: тема «Отзывы о merabo.ru» после обычной чистки превращается
 * в «merabo», и поиск по такому слову не находит ничего — проект известен именно
 * как домен. А вот для сверки дублей и для проверки текста домен, наоборот, мешает
 * («atlascapital.com» и «atlascapital» — один проект), поэтому функции две.
 */
export function projectSearchName(name) {
  if (!name) return null;
  const parts = String(name)
    .split(/[\s\-_/\\|,;:()[\]"«»]+/u)
    .filter(Boolean)
    .filter((part) => {
      const latin = translit(part.toLowerCase()).replace(/[^a-z0-9.]/g, '');
      // Домен целиком (merabo.ru) шумом быть не может, даже если его часть похожа.
      if (latin.includes('.')) return true;
      return !NOISE.has(latin);
    });
  if (parts.length === 0) return String(name);
  return parts.slice(0, MAX_TOKENS + 1).join(' ');
}

/**
 * Название проекта в человеческом виде — для промта и заголовков в панели.
 * «xrp-turbo-io-razoblachenie» → «xrp turbo». Если после чистки не остаётся ничего
 * (название целиком из шума), отдаём исходную строку: пусть лучше некрасиво, чем пусто.
 */
export function projectDisplayName(name) {
  const { words } = projectTokens(name);
  if (words.length === 0) return name ?? null;
  return words.slice(0, MAX_TOKENS).join(' ');
}

function keyFromText(text) {
  if (!text) return null;
  const tokens = tokenize(text).filter((token) => !NOISE.has(token) && !TLDS.has(token));
  if (tokens.length === 0) return null;
  const key = fold(tokens.slice(0, MAX_TOKENS).join(''));
  return key.length >= 3 ? key : null;
}

/**
 * Название проекта из заголовка. Заголовки на всех источниках построены одинаково:
 * «<проект>: <вердикт>» или «<проект> — <вердикт>». Берём часть до первого разделителя,
 * скобочные уточнения («Joycasino (Джойказино)») отбрасываем — они дублируют название
 * в другом алфавите и удвоили бы ключ.
 */
function nameFromTitle(title) {
  if (!title) return null;
  const cleaned = title.replace(/\([^)]*\)/g, ' ');
  const head = cleaned.split(/[:|—–?!]/, 1)[0].trim();
  // если до разделителя остался только шум («Отзывы о coinmagnetix.com»), берём весь заголовок
  return keyFromText(head) ? head : cleaned.trim();
}

/**
 * @param {{title?: string|null, url: string, topicHint?: string|null}} input
 * @returns {{key: string|null, aliases: string[], name: string|null, via: string|null}}
 *   key — основной ключ, aliases — прочие варианты (участвуют в сверке на дубль).
 */
/** Есть ли у двух ключей общий фрагмент — признак, что речь об одном названии. */
function sharesFragment(a, b, length = 4) {
  if (!a || !b) return false;
  for (let i = 0; i + length <= a.length; i += 1) {
    if (b.includes(a.slice(i, i + length))) return true;
  }
  return false;
}

export function extractTopic({ title, url, topicHint }) {
  const variants = [];

  const push = (source, text) => {
    const key = keyFromText(text);
    if (!key) return;
    if (variants.some((variant) => variant.key === key)) return;
    variants.push({ key, via: source, name: String(text).trim() });
  };

  // подсказка адаптера надёжнее всего: у scama.net это проверяемый домен как он есть
  push('hint', topicHint);

  // slug — единственный источник темы при обнаружении через sitemap: заголовка там нет.
  // Но slug бывает разделом, а не названием: у scama.net все адреса вида `/check?id=NNN`,
  // и ключ «check» склеил бы все 47 тем источника в одну. Такие slug'и не берём.
  const slugRaw = pathSegments(url).at(-1);
  const slug = slugRaw && !SECTION_SLUGS.has(slugRaw.toLowerCase()) ? slugRaw : null;
  const slugKey = keyFromText(slug);
  const titleKey = keyFromText(nameFromTitle(title));

  // Заголовок с сайта бывает не тем: cryptorussia отдала двум разным материалам
  // («promopad-scam» и «smartgptsignalsai-bot-moshennik») один заголовок «Промопад»,
  // и по нему разные проекты схлопнулись бы в одну тему. Если заголовок и адрес
  // не имеют общего фрагмента, верим адресу: рерайтим мы именно страницу.
  const titleTrusted = !slugKey || !titleKey || sharesFragment(titleKey, slugKey);
  if (titleTrusted) push('title', nameFromTitle(title));
  push('slug', slug);

  if (variants.length === 0) return { key: null, aliases: [], name: null, via: null };

  const [primary, ...rest] = variants;
  return {
    key: primary.key,
    aliases: rest.map((variant) => variant.key),
    name: primary.name,
    via: primary.via,
  };
}
