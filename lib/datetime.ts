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
