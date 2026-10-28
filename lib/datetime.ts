/**
 * Локальная дата/время для учёта (Asia/Almaty).
 * Все "Сегодня" и диапазоны для выручки строятся здесь.
 */

const DEFAULT_TZ = 'Asia/Almaty';

/**
 * Текущая дата в указанной таймзоне (YYYY-MM-DD).
 */
export function getTodayLocalISO(tz: string = DEFAULT_TZ): string {
  if (typeof window !== 'undefined') {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  }
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Диапазон одного дня в TZ: [00:00:00 в TZ, 00:00:00 следующего дня в TZ).
 * dateStr: YYYY-MM-DD.
 */
export function getLocalDayRangeInTz(
  dateStr: string,
  _tz: string = DEFAULT_TZ
): { from: Date; toNext: Date } {
  const from = new Date(`${dateStr}T00:00:00+05:00`);
  const toNext = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, toNext };
}

/**
 * "Сегодня" в Almaty: диапазон [startOfToday, startOfTomorrow) в UTC.
 */
export function getTodayRangeAlmaty(): { from: Date; toNext: Date } {
  const today = getTodayLocalISO(DEFAULT_TZ);
  return getLocalDayRangeInTz(today, DEFAULT_TZ);
}

/** YYYY-MM-DD в указанной TZ. */
export function ymdInTz(date: Date, tz: string = DEFAULT_TZ): string {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Сдвиг календарного дня YYYY-MM-DD в TZ (Казахстан UTC+5 без DST). */
export function addDaysYmd(dateStr: string, days: number, tz: string = DEFAULT_TZ): string {
  const noon = new Date(`${dateStr}T12:00:00+05:00`);
  const shifted = new Date(noon.getTime() + days * 24 * 60 * 60 * 1000);
  return ymdInTz(shifted, tz);
}

export function startOfMonthYmd(dateStr: string): string {
  return `${dateStr.slice(0, 8)}01`;
}

/** Полуоткрытый диапазон [fromYmd 00:00 TZ, toYmd+1 00:00 TZ). */
export function getYmdSpanRangeInTz(
  fromYmd: string,
  toYmd: string,
  tz: string = DEFAULT_TZ
): { from: Date; toNext: Date } {
  const from = getLocalDayRangeInTz(fromYmd, tz).from;
  const toNext = getLocalDayRangeInTz(toYmd, tz).toNext;
  return { from, toNext };
}
