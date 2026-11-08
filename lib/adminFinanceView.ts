import { getAccountingDate, isConfirmedInRange } from '@/lib/accounting';
import {
  FINANCE_CARGO_CUSTOMS_CATEGORY,
  uniqueLiveExpenses,
  type AdminFinanceReport,
  type FinanceExpenseRow,
  type FinanceOrder,
} from '@/lib/adminFinance';
import { addDaysYmd, getYmdSpanRangeInTz, ymdInTz } from '@/lib/datetime';

export type FinancePeriodMode = 'month' | 'custom';

export type FinanceDailyPoint = {
  date: string;
  revenue: number;
  operatingExpenses: number;
};

export type FinanceKpiKind = 'fact' | 'estimate' | 'preliminary' | 'unavailable';

export type FinanceKpi = {
  kind: FinanceKpiKind;
  amount: number | null;
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function monthRangeYmd(year: number, month: number): { fromYmd: string; toYmd: string } {
  const y = Math.trunc(year);
  const m = Math.trunc(month);
  const fromYmd = `${y}-${pad2(m)}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { fromYmd, toYmd: `${y}-${pad2(m)}-${pad2(last)}` };
}

export function resolveFinanceRange(opts: {
  mode: FinancePeriodMode;
  year: number;
  month: number;
  customFrom: string;
  customTo: string;
}): { fromYmd: string; toYmd: string; range: { from: Date; toNext: Date } } | null {
  let fromYmd: string;
  let toYmd: string;
  if (opts.mode === 'month') {
    const span = monthRangeYmd(opts.year, opts.month);
    fromYmd = span.fromYmd;
    toYmd = span.toYmd;
  } else {
    fromYmd = opts.customFrom;
    toYmd = opts.customTo;
  }
  if (!fromYmd || !toYmd || fromYmd > toYmd) return null;
  return { fromYmd, toYmd, range: getYmdSpanRangeInTz(fromYmd, toYmd, 'Asia/Almaty') };
}

export function expensesForCityView(
  expenses: FinanceExpenseRow[],
  cityId: string | 'all'
): { pnlExpenses: FinanceExpenseRow[]; companyExpenses: FinanceExpenseRow[] } {
  const live = expenses.filter((e) => e.deleted_at == null || String(e.deleted_at).trim() === '');
  const companyExpenses = live.filter((e) => !e.city_id);
  if (cityId === 'all') return { pnlExpenses: live, companyExpenses };
  return {
    pnlExpenses: live.filter((e) => e.city_id === cityId),
    companyExpenses,
  };
}

export function ordersForCityView(orders: FinanceOrder[], cityId: string | 'all'): FinanceOrder[] {
  if (cityId === 'all') return orders;
  return orders.filter((o) => o.city_id === cityId);
}

export function buildFinanceDaily(params: {
  orders: FinanceOrder[];
  expenses: FinanceExpenseRow[];
  fromYmd: string;
  toYmd: string;
  range: { from: Date; toNext: Date };
}): FinanceDailyPoint[] {
  const { orders, expenses, fromYmd, toYmd, range } = params;
  const byDay = new Map<string, FinanceDailyPoint>();
  let cur = fromYmd;
  while (cur <= toYmd) {
    byDay.set(cur, { date: cur, revenue: 0, operatingExpenses: 0 });
    cur = addDaysYmd(cur, 1);
  }
  for (const order of orders) {
    if (!isConfirmedInRange(order, range)) continue;
    const acc = getAccountingDate(order);
    if (!acc) continue;
    const day = ymdInTz(acc, 'Asia/Almaty');
    const bucket = byDay.get(day);
    if (!bucket) continue;
    const t = order.total_sum;
    bucket.revenue += typeof t === 'number' && !Number.isNaN(t) ? t : 0;
  }
  for (const row of uniqueLiveExpenses(expenses, fromYmd, toYmd)) {
    if ((row.category || '') === FINANCE_CARGO_CUSTOMS_CATEGORY) continue;
    const day = String(row.expense_date || '').slice(0, 10);
    const bucket = byDay.get(day);
    if (!bucket) continue;
    const amount = typeof row.amount === 'number' ? row.amount : Number(row.amount);
    if (Number.isFinite(amount) && amount > 0) bucket.operatingExpenses += amount;
  }
  return [...byDay.values()].map((p) => ({
    ...p,
    revenue: Number(p.revenue.toFixed(2)),
    operatingExpenses: Number(p.operatingExpenses.toFixed(2)),
  }));
}

export function financeCogsKpi(report: AdminFinanceReport): FinanceKpi {
  return { kind: 'estimate', amount: report.cogsKnown };
}

export function financeGrossKpi(report: AdminFinanceReport): FinanceKpi {
  if (!report.cogsComplete) return { kind: 'unavailable', amount: null };
  return { kind: 'estimate', amount: report.estimatedGrossProfit };
}

export function financeNetKpi(report: AdminFinanceReport): FinanceKpi {
  if (!report.cogsComplete) return { kind: 'unavailable', amount: null };
  if (!report.expensesComplete) return { kind: 'preliminary', amount: report.preliminaryNetProfit };
  return { kind: 'estimate', amount: report.estimatedNetProfit };
}

export function financeMarginKpi(report: AdminFinanceReport): FinanceKpi {
  if (report.revenue <= 0) return { kind: 'unavailable', amount: null };
  if (!report.cogsComplete) return { kind: 'unavailable', amount: null };
  if (!report.expensesComplete) {
    if (report.preliminaryNetProfit == null) return { kind: 'unavailable', amount: null };
    return { kind: 'preliminary', amount: Number(((report.preliminaryNetProfit / report.revenue) * 100).toFixed(2)) };
  }
  return { kind: 'estimate', amount: report.netMarginPct };
}

export function isSessionOnlyExpenseCompleteness(storedOnServer: boolean): boolean {
  return storedOnServer !== true;
}
