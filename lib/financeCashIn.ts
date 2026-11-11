/**
 * Денежные поступления vs признанная выручка.
 * Кассового журнала нет: не складывать Cash In из created_at / confirm.
 * Достоверная дата есть только у погашения долга (debt_paid_at + debt_status=paid).
 * Правила признания выручки не меняет: по-прежнему lib/accounting.ts.
 */

import {
  getAccountingDate,
  isConfirmedInRange,
  isRevenueOrder,
  type OrderForAccounting,
} from '@/lib/accounting';

function money(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function isCanceled(order: OrderForAccounting): boolean {
  return order.status === 'canceled' || order.status === 'cancelled';
}

function isDebtOrder(order: OrderForAccounting): boolean {
  return order.is_debt === true || order.payment_type === 'debt';
}

/** Дата погашения долга. Требует и статус paid, и timestamp — иначе поступление неполное. */
export function getVerifiedDebtCollectionAt(order: OrderForAccounting): Date | null {
  if (isCanceled(order)) return null;
  if (!isDebtOrder(order)) return null;
  if (order.debt_status !== 'paid') return null;
  if (order.debt_paid_at == null || String(order.debt_paid_at).trim() === '') return null;
  const d = new Date(order.debt_paid_at);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isVerifiedDebtCollectionInRange(
  order: OrderForAccounting,
  range: { from: Date; toNext: Date }
): boolean {
  const at = getVerifiedDebtCollectionAt(order);
  return at != null && at >= range.from && at < range.toNext;
}

export function sumVerifiedDebtCollectionsInRange(
  orders: OrderForAccounting[],
  range: { from: Date; toNext: Date }
): { amount: number; count: number } {
  let amount = 0;
  let count = 0;
  const seen = new Set<string>();
  for (const order of orders) {
    if (!isVerifiedDebtCollectionInRange(order, range)) continue;
    const id = (order as { id?: string }).id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    amount = money(amount + money(order.total_sum));
    count += 1;
  }
  return { amount, count };
}

export type CashInReason =
  | 'no_payment_ledger'
  | 'cash_confirm_is_not_a_receipt'
  | 'preorder_pay_date_unknown'
  | 'no_partial_payments';

export type CashInReport = {
  /** Полный Cash In за период недоступен — нет журнала поступлений. */
  quality: 'incomplete';
  inflowsIncomplete: true;
  reasons: CashInReason[];
  /** Единственная датированная касса: полное погашение долга. Не полный Cash In. */
  verifiedDebtCollections: number;
  verifiedDebtCollectionCount: number;
};

export function buildCashInReport(
  orders: OrderForAccounting[],
  range: { from: Date; toNext: Date }
): CashInReport {
  const collected = sumVerifiedDebtCollectionsInRange(orders, range);
  return {
    quality: 'incomplete',
    inflowsIncomplete: true,
    reasons: [
      'no_payment_ledger',
      'cash_confirm_is_not_a_receipt',
      'preorder_pay_date_unknown',
      'no_partial_payments',
    ],
    verifiedDebtCollections: collected.amount,
    verifiedDebtCollectionCount: collected.count,
  };
}

/**
 * Фиксирует расхождение двух функций учёта без смены правил.
 * Finance/stats используют isConfirmedInRange, не isRevenueOrder.
 */
export function recognitionRuleGap(order: OrderForAccounting, range: { from: Date; toNext: Date }): {
  confirmedInRange: boolean;
  revenueOrder: boolean;
  recognizedAt: Date | null;
} {
  return {
    confirmedInRange: isConfirmedInRange(order, range),
    revenueOrder: isRevenueOrder(order),
    recognizedAt: getAccountingDate(order),
  };
}
