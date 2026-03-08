/**
 * Единая логика учёта выручки (источник истины).
 * Используй: parseDDMMYYYY, buildLocalDayRange, getAccountingDate, isConfirmedForPeriod, sumConfirmed.
 */

export type OrderForAccounting = {
  status?: string | null;
  payment_type?: string | null;
  total_sum?: number | null;
  created_at?: string | null;
  is_preorder?: boolean | null;
  preorder_status?: string | null;
  fulfilled_at?: string | null;
  is_debt?: boolean | null;
  debt_status?: string | null;
  debt_paid_at?: string | null;
  debt_payment_method?: string | null;
};

/** Парсер DD.MM.YYYY. Строгий формат. */
export function parseDDMMYYYY(s: string): { y: number; m: number; d: number } | null {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** Парсер даты: DD.MM.YYYY или YYYY-MM-DD */
export function parseDateStr(s: string): { y: number; m: number; d: number } | null {
  const ddmm = parseDDMMYYYY(s);
  if (ddmm) return ddmm;
  const parts = s.trim().split('-');
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(mo) || isNaN(d) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** Диапазон: from = 00:00 локально, toNext = (toDate+1) 00:00 локально. fromStr/toStr: DD.MM.YYYY или YYYY-MM-DD */
export function buildLocalDayRange(
  fromStr: string,
  toStr: string
): { from: Date; toNext: Date } | null {
  const fromP = parseDateStr(fromStr);
  const toP = parseDateStr(toStr);
  if (!fromP || !toP) return null;
  const from = new Date(fromP.y, fromP.m - 1, fromP.d, 0, 0, 0, 0);
  const toNext = new Date(toP.y, toP.m - 1, toP.d, 0, 0, 0, 0);
  toNext.setDate(toNext.getDate() + 1);
  return { from, toNext };
}

/** Alias для buildLocalDayRange */
export function buildRange(fromStr: string, toStr: string): { from: Date; toNext: Date } | null {
  return buildLocalDayRange(fromStr, toStr);
}

/**
 * Оплачен ли заказ (деньги получены).
 * - debt: debt_paid_at != null OR debt_status === 'paid'
 * - иначе (cash/kaspi/прочее): true если status='confirmed'
 */
export function isOrderPaid(order: OrderForAccounting): boolean {
  const o = order as OrderForAccounting & { status?: string };
  if (o.status === 'canceled') return false;
  if (o.is_debt === true || o.payment_type === 'debt') {
    return o.debt_paid_at != null && String(o.debt_paid_at).trim() !== '' || o.debt_status === 'paid';
  }
  return o.status === 'confirmed';
}

/**
 * Дата для учёта в выручке (accounting timestamp).
 * - debt: debt_paid_at если paid, иначе null
 * - preorder: fulfilled_at если fulfilled, иначе null
 * - иначе: created_at
 */
export function getAccountingTimestamp(order: OrderForAccounting): Date | null {
  return getAccountingDate(order);
}

/**
 * Дата учёта в выручке (recognized_at).
 * - Долг (is_debt или payment_type='debt'): debt_paid_at если paid, иначе null
 * - Предзаказ: fulfilled_at если fulfilled, иначе null
 * - Обычный: created_at
 */
export function getRecognizedAt(order: OrderForAccounting): Date | null {
  return getAccountingDate(order);
}

/** Оплачен ли заказ (есть recognized_at) */
export function isRecognized(order: OrderForAccounting): boolean {
  return getAccountingDate(order) != null;
}

/** Дата попадает в диапазон [from, toNext) */
export function isDateInRange(date: Date, from: Date, toNext: Date): boolean {
  const t = date.getTime();
  return t >= from.getTime() && t < toNext.getTime();
}

/**
 * Accounting date по бизнес-правилам.
 * Долг: is_debt=true ИЛИ payment_type='debt'.
 */
export function getAccountingDate(order: OrderForAccounting): Date | null {
  const o = order as OrderForAccounting & { created_at?: string };
  if (o.status === 'canceled') return null;
  const isDebt = o.is_debt === true || o.payment_type === 'debt';
  if (isDebt) {
    if (o.debt_status !== 'paid' || o.debt_paid_at == null || String(o.debt_paid_at).trim() === '') return null;
    const d = new Date(o.debt_paid_at);
    return isNaN(d.getTime()) ? null : d;
  }
  if (o.is_preorder === true || o.preorder_status === 'fulfilled') {
    if (o.preorder_status !== 'fulfilled' || o.fulfilled_at == null || String(o.fulfilled_at).trim() === '') return null;
    const d = new Date(o.fulfilled_at);
    return isNaN(d.getTime()) ? null : d;
  }
  const created = o.created_at ?? null;
  if (!created || String(created).trim() === '') return null;
  const d = new Date(created);
  return isNaN(d.getTime()) ? null : d;
}

/** Заказ попадает в диапазон по accounting_date */
export function isConfirmedInRange(
  order: OrderForAccounting,
  range: { from: Date; toNext: Date }
): boolean {
  const ad = getAccountingDate(order);
  return ad != null && ad >= range.from && ad < range.toNext;
}

/** Заказ учитывается в подтверждённой выручке за период (fromStr/toStr: DD.MM.YYYY или YYYY-MM-DD) */
export function isConfirmedForPeriod(
  order: OrderForAccounting,
  fromStr: string,
  toStr: string
): boolean {
  const range = buildLocalDayRange(fromStr, toStr);
  if (!range) return false;
  return isConfirmedInRange(order, range);
}

/** Сумма подтверждённой выручки за период (по строковым датам, локаль браузера) */
export function sumConfirmed(
  orders: OrderForAccounting[],
  fromStr: string,
  toStr: string
): number {
  return orders.reduce((sum, o) => {
    if (!isConfirmedForPeriod(o, fromStr, toStr)) return sum;
    const t = (o as OrderForAccounting).total_sum;
    const val = typeof t === 'number' && !Number.isNaN(t) ? t : 0;
    return sum + val;
  }, 0);
}

/** Сумма подтверждённой выручки за период по явному диапазону (для Almaty "сегодня") */
export function sumConfirmedInRange(
  orders: OrderForAccounting[],
  range: { from: Date; toNext: Date }
): number {
  return orders.reduce((sum, o) => {
    if (!isConfirmedInRange(o, range)) return sum;
    const t = (o as OrderForAccounting).total_sum;
    const val = typeof t === 'number' && !Number.isNaN(t) ? t : 0;
    return sum + val;
  }, 0);
}

// --- Обратная совместимость ---

export function getAccountingDateAsDate(order: OrderForAccounting): Date | null {
  return getAccountingDate(order);
}

/** @deprecated Use getAccountingDate, returns ISO string for compatibility */
export function getAccountingDateISO(order: OrderForAccounting): string | null {
  const d = getAccountingDate(order);
  return d ? d.toISOString() : null;
}

/** @deprecated Use buildLocalDayRange + getAccountingDate */
export function getDateRangeISO(fromStr: string, toStr: string): { fromISO: string; toNextISO: string } {
  const range = buildLocalDayRange(fromStr, toStr);
  if (!range) return { fromISO: '', toNextISO: '' };
  return {
    fromISO: range.from.toISOString(),
    toNextISO: range.toNext.toISOString(),
  };
}

/** @deprecated Use isConfirmedForPeriod; signature (order, fromISO, toNextISO) for compatibility */
export function isAccountingDateInRange(
  order: OrderForAccounting,
  fromISO: string,
  toNextISO: string
): boolean {
  const acc = getAccountingDate(order);
  if (!acc) return false;
  const accTime = acc.getTime();
  const fromTime = new Date(fromISO).getTime();
  const toNextTime = new Date(toNextISO).getTime();
  if (isNaN(fromTime) || isNaN(toNextTime)) return false;
  return accTime >= fromTime && accTime < toNextTime;
}

const REVENUE_PAYMENT_TYPES = ['cash', 'kaspi', 'card', 'transfer'] as const;

export function isRevenueOrder(order: OrderForAccounting): boolean {
  const o = order as OrderForAccounting;
  if (o.status === 'canceled') return false;
  const acc = getAccountingDate(order);
  if (!acc) return false;
  const isDebt = o.is_debt === true || o.payment_type === 'debt';
  const isPreorder = o.is_preorder === true;
  if (!isPreorder && !isDebt) {
    return (
      o.status === 'confirmed' &&
      o.payment_type != null &&
      o.payment_type !== '' &&
      o.payment_type !== 'debt' &&
      REVENUE_PAYMENT_TYPES.includes(o.payment_type as (typeof REVENUE_PAYMENT_TYPES)[number])
    );
  }
  if (isDebt) {
    const paid = o.debt_status === 'paid' || (o.debt_paid_at != null && String(o.debt_paid_at).trim() !== '');
    if (!paid) return false;
    const pt = o.payment_type ?? o.debt_payment_method;
    return pt != null && pt !== '' && pt !== 'debt' && REVENUE_PAYMENT_TYPES.includes(pt as (typeof REVENUE_PAYMENT_TYPES)[number]);
  }
  if (isPreorder) {
    return o.status === 'confirmed' && (o.preorder_status === 'fulfilled' || (o.fulfilled_at != null && String(o.fulfilled_at).trim() !== ''));
  }
  return false;
}

export function getRevenueAmount(order: OrderForAccounting): number {
  if (!isRevenueOrder(order)) return 0;
  const t = (order as OrderForAccounting).total_sum;
  return typeof t === 'number' && !Number.isNaN(t) ? t : 0;
}
