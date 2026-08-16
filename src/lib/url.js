/**
 * Нормализация URL для дедупа. Один и тот же материал приходит в разном написании:
 * с www и без, с utm-метками из соцсетей, с якорем, со слешем на конце и без.
 * url_norm — то, по чему стоит уникальный индекс.
 */

const TRACKING_PARAMS = [
  /^utm_/i,
  /^yclid$/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^ysclid$/i,
  /^_openstat$/i,
  /^from$/i,
  /^ref$/i,
];

export function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  // схему приводим к https: часть источников отдаёт один и тот же материал по обеим
  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  parsed.hash = '';
  parsed.port = '';

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();

  // слеш на конце не значим для WP-адресов
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  const search = parsed.searchParams.toString();
  return `https://${parsed.hostname}${parsed.pathname}${search ? `?${search}` : ''}`;
}

/** Последний сегмент пути — slug записи WordPress. */
export function slugFromUrl(raw) {
  try {
    const parsed = new URL(raw);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.at(-1) ?? null;
  } catch {
    return null;
  }
}

/** Домен без www — служит темой для источников, где тема и есть проверяемый сайт. */
export function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
