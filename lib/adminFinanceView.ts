import { getAccountingDate, isConfirmedInRange } from '@/lib/accounting';
import {
  FINANCE_CARGO_CUSTOMS_CATEGORY,
  uniqueLiveExpenses,
  type AdminFinanceReport,
  type FinanceExpenseRow,
  type FinanceOrder,
  type FinanceSellerRow,
} from '@/lib/adminFinance';
import { resolvePeriod, type StatsPeriodPreset } from '@/lib/adminStats';
import { addDaysYmd, getTodayLocalISO, getYmdSpanRangeInTz, startOfYearYmd, ymdInTz } from '@/lib/datetime';

export type FinancePeriodMode =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'last90'
  | 'thisYear'
  | 'custom';

export const FINANCE_PERIOD_PRESETS: { id: FinancePeriodMode; labelKey: string }[] = [
  { id: 'today', labelKey: 'stats.today' },
  { id: 'yesterday', labelKey: 'stats.yesterday' },
  { id: 'last7', labelKey: 'stats.last7' },
  { id: 'last30', labelKey: 'stats.last30' },
  { id: 'thisMonth', labelKey: 'stats.thisMonth' },
  { id: 'lastMonth', labelKey: 'stats.lastMonth' },
  { id: 'last90', labelKey: 'finance.last90' },
  { id: 'thisYear', labelKey: 'finance.thisYear' },
  { id: 'custom', labelKey: 'finance.customPeriod' },
];

const STATS_ALIGNED_PRESETS: StatsPeriodPreset[] = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
  'custom',
];

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
  customFrom: string;
  customTo: string;
  todayYmd?: string;
}): { fromYmd: string; toYmd: string; range: { from: Date; toNext: Date } } | null {
  const today = opts.todayYmd || getTodayLocalISO('Asia/Almaty');
  if ((STATS_ALIGNED_PRESETS as string[]).includes(opts.mode)) {
    const spec = resolvePeriod(opts.mode as StatsPeriodPreset, opts.customFrom, opts.customTo, today);
    return spec ? { fromYmd: spec.fromYmd, toYmd: spec.toYmd, range: spec.range } : null;
  }
  let fromYmd: string;
  let toYmd: string;
  if (opts.mode === 'last90') {
    fromYmd = addDaysYmd(today, -89);
    toYmd = today;
  } else if (opts.mode === 'thisYear') {
    fromYmd = startOfYearYmd(today);
    toYmd = today;
  } else {
    return null;
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

export type FinanceSellerSort = 'gross' | 'revenue' | 'orders' | 'margin';

export function sortFinanceSellerRows(rows: FinanceSellerRow[], sort: FinanceSellerSort): FinanceSellerRow[] {
  const metric = (row: FinanceSellerRow): number => {
    if (sort === 'revenue') return row.revenue;
    if (sort === 'orders') return row.orderCount;
    if (sort === 'margin') return row.grossMarginPct ?? Number.NEGATIVE_INFINITY;
    return row.estimatedGrossProfit ?? Number.NEGATIVE_INFINITY;
  };
  return [...rows].sort(
    (a, b) =>
      metric(b) - metric(a) ||
      b.revenue - a.revenue ||
      a.sellerName.localeCompare(b.sellerName, 'ru') ||
      a.cityName.localeCompare(b.cityName, 'ru')
  );
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
  if (report.cogsIsHistorical) return { kind: 'fact', amount: report.cogsKnown };
  return { kind: 'estimate', amount: report.cogsKnown };
}

export function financeGrossKpi(report: AdminFinanceReport): FinanceKpi {
  if (!report.cogsComplete) return { kind: 'unavailable', amount: null };
  if (report.cogsIsHistorical) return { kind: 'fact', amount: report.estimatedGrossProfit };
  return { kind: 'estimate', amount: report.estimatedGrossProfit };
}

export type FinanceReliability = 'complete' | 'preliminary' | 'incomplete' | 'disconnected' | 'city';

export function financeReliability(report: AdminFinanceReport): FinanceReliability {
  if (report.cityScoped) return 'city';
  if (report.sellerPnlStatus === 'missing' || report.sellerPnlStatus === 'error') return 'disconnected';
  if (!report.cogsComplete || report.warnings.includes('seller_goods_cogs_incomplete')) return 'incomplete';
  if (report.profitReviewRequired) return 'incomplete';
  if (!report.expensesComplete) return 'preliminary';
  if (report.estimatedNetProfit == null) return 'incomplete';
  return 'complete';
}

export function financeReliabilityLabelKey(status: FinanceReliability): string {
  if (status === 'complete') return 'finance.reliabilityComplete';
  if (status === 'preliminary') return 'finance.reliabilityPreliminary';
  if (status === 'disconnected') return 'finance.pnlDisconnected';
  if (status === 'city') return 'finance.cityOperational';
  return 'finance.reliabilityIncomplete';
}

export function financeNetKpi(report: AdminFinanceReport): FinanceKpi {
  const status = financeReliability(report);
  if (status === 'disconnected' || status === 'incomplete' || status === 'city') {
    return { kind: 'unavailable', amount: null };
  }
  if (status === 'preliminary') return { kind: 'preliminary', amount: report.preliminaryNetProfit };
  if (report.cogsIsHistorical) return { kind: 'fact', amount: report.estimatedNetProfit };
  return { kind: 'estimate', amount: report.estimatedNetProfit };
}

export function sellerLiabilitySplit(balance: number): { companyOwes: number; sellerOwes: number } {
  if (balance > 0) return { companyOwes: balance, sellerOwes: 0 };
  if (balance < 0) return { companyOwes: 0, sellerOwes: -balance };
  return { companyOwes: 0, sellerOwes: 0 };
}

export type FinanceBreakdownRow = { key: string; sign: 'plus' | 'minus' | 'eq'; amount: number };

export function financeWarningKey(code: AdminFinanceReport['warnings'][number]): string {
  const map: Record<AdminFinanceReport['warnings'][number], string> = {
    cogs_is_current_catalog_not_historical: 'finance.cogsHint',
    cogs_mixed_historical_and_estimated: 'finance.cogsMixed',
    cogs_historical_unavailable: 'finance.snapshotsUnavailable',
    cogs_incomplete: 'finance.cogsMissing',
    expenses_incomplete: 'finance.expensesIncomplete',
    cargo_customs_held_out_of_net: 'finance.cargoHint',
    company_expenses_not_allocated_to_cities: 'finance.companyHint',
    zero_revenue: 'finance.empty',
    seller_payout_unclassified: 'finance.warnPayoutUnclassified',
    seller_adjustments_unclassified: 'finance.warnAdjustments',
    seller_goods_ledger_mismatch: 'finance.warnGoodsMismatch',
    seller_goods_cogs_incomplete: 'finance.warnGoodsCogs',
    seller_pnl_unavailable: 'finance.pnlDisconnected',
    seller_missing_rate: 'finance.warnMissingRate',
    seller_unpaid_debt_accrual: 'finance.warnUnpaidDebt',
    seller_goods_zero_cost: 'finance.warnGoodsZeroCost',
    seller_city_scope: 'finance.cityOperational',
  };
  return map[code];
}

export function financeProfitBreakdown(report: AdminFinanceReport): FinanceBreakdownRow[] {
  return [
    { key: 'finance.revenue', sign: 'plus', amount: report.revenue },
    { key: 'finance.salesCogs', sign: 'minus', amount: report.salesCogs },
    { key: 'finance.commissionAccrual', sign: 'minus', amount: report.commissionAccrual },
    { key: 'finance.commissionReversal', sign: 'plus', amount: report.commissionReversal },
    { key: 'finance.goodsIssueCogs', sign: 'minus', amount: report.goodsIssueCogs },
    { key: 'finance.goodsCreditAdj', sign: 'plus', amount: report.goodsSettlementCredit },
    { key: 'finance.otherOpex', sign: 'minus', amount: report.otherOperatingExpenses },
    { key: 'finance.net', sign: 'eq', amount: report.estimatedNetProfit ?? Number.NaN },
  ];
}

export function financeMarginKpi(report: AdminFinanceReport): FinanceKpi {
  if (report.revenue <= 0) return { kind: 'unavailable', amount: null };
  const net = financeNetKpi(report);
  if (net.kind === 'unavailable' || net.amount == null) return { kind: 'unavailable', amount: null };
  const pct = Number(((net.amount / report.revenue) * 100).toFixed(2));
  if (net.kind === 'preliminary') return { kind: 'preliminary', amount: pct };
  if (report.cogsIsHistorical) return { kind: 'fact', amount: pct };
  return { kind: 'estimate', amount: pct };
}

export function financeCogsHintKey(report: AdminFinanceReport): string {
  if (report.warnings.includes('cogs_historical_unavailable')) return 'finance.snapshotsUnavailable';
  if (report.cogsQuality === 'historical') return 'finance.cogsHintHistorical';
  if (report.cogsQuality === 'mixed') return 'finance.cogsHintMixed';
  return 'finance.cogsHint';
}

export function periodExpenseJournalEmpty(
  expenses: FinanceExpenseRow[] | null | undefined,
  fromYmd: string,
  toYmd: string
): boolean {
  return uniqueLiveExpenses(expenses, fromYmd, toYmd).length === 0;
}

export function financeOpexKpi(report: AdminFinanceReport, journalEmpty: boolean): FinanceKpi {
  if (journalEmpty && !report.expensesComplete) return { kind: 'unavailable', amount: null };
  if (journalEmpty && report.expensesComplete) return { kind: 'fact', amount: 0 };
  if (!report.expensesComplete) return { kind: 'estimate', amount: report.operatingExpenses };
  return { kind: 'estimate', amount: report.operatingExpenses };
}

export function expensesCompleteForPeriod(confirmedPeriodKey: string | null, periodKey: string): boolean {
  return Boolean(confirmedPeriodKey) && confirmedPeriodKey === periodKey;
}

export function isSessionOnlyExpenseCompleteness(storedOnServer: boolean): boolean {
  return storedOnServer !== true;
}
