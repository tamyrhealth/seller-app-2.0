/**
 * Управленческие финансовые расчёты.
 * Выручка — только через lib/accounting.ts.
 * Себестоимость строки: cost_price_snapshot, иначе оценка admin_product_costs().
 * Расходы — журнал admin_finance_expenses_list; закупка партии сюда не подмешивается.
 * Комиссии — admin_finance_seller_pnl: зачёт выдачи не выручка; выплаты не в P&L.
 */

import {
  isConfirmedInRange,
  sumConfirmedInRange,
  type OrderForAccounting,
} from '@/lib/accounting';
import { allocateOrderLines, type StatsOrder } from '@/lib/adminStats';
import type { ProductCostRow } from '@/lib/productCost';
import { resolveLineUnitCost, snapshotForItem } from '@/lib/adminFinanceSnapshots';

export const FINANCE_COSTS_RPC = 'admin_product_costs' as const;
export const FINANCE_EXPENSES_LIST_RPC = 'admin_finance_expenses_list' as const;
export const FINANCE_EXPENSE_CREATE_RPC = 'admin_finance_expense_create' as const;
export const FINANCE_EXPENSE_UPDATE_RPC = 'admin_finance_expense_update' as const;
export const FINANCE_EXPENSE_DELETE_RPC = 'admin_finance_expense_delete' as const;
export const FINANCE_EXPENSE_EVENTS_RPC = 'admin_finance_expense_events' as const;
export const FINANCE_SELLER_PNL_RPC = 'admin_finance_seller_pnl' as const;

export const FINANCE_CARGO_CUSTOMS_CATEGORY = 'cargo_customs' as const;
export const FINANCE_SELLER_PAYOUT_CATEGORY = 'seller_payout' as const;

export const FINANCE_EXPENSE_CATEGORIES = [
  'logistics',
  'cargo_customs',
  'ads',
  'rent',
  'tax',
  'salary',
  'seller_payout',
  'bonus',
  'other',
] as const;

export type FinanceExpenseCategory = (typeof FINANCE_EXPENSE_CATEGORIES)[number];

export const FINANCE_ORDER_SELECT =
  'id, seller_id, total_sum, city_id, created_at, status, payment_type, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at, debt_payment_method, order_items(id, product_id, qty, price, line_sum, is_gift, product_name_snapshot, product:products(name, unit))';

export type FinanceWarningCode =
  | 'cogs_is_current_catalog_not_historical'
  | 'cogs_mixed_historical_and_estimated'
  | 'cogs_historical_unavailable'
  | 'cogs_incomplete'
  | 'expenses_incomplete'
  | 'cargo_customs_held_out_of_net'
  | 'company_expenses_not_allocated_to_cities'
  | 'zero_revenue'
  | 'seller_payout_unclassified'
  | 'seller_adjustments_unclassified'
  | 'seller_goods_ledger_mismatch'
  | 'seller_goods_cogs_incomplete'
  | 'seller_pnl_unavailable'
  | 'seller_missing_rate'
  | 'seller_unpaid_debt_accrual'
  | 'seller_goods_zero_cost'
  | 'seller_city_scope';

export type SellerPnlStatus = 'skipped' | 'connected' | 'missing' | 'error';

export type FinanceCogsQuality = 'historical' | 'estimated' | 'mixed' | 'incomplete';

export type FinanceExpenseRow = {
  id?: string | null;
  expense_date?: string | null;
  category?: string | null;
  amount?: number | string | null;
  city_id?: string | null;
  comment?: string | null;
  operation_id?: string | null;
  deleted_at?: string | null;
};

export type FinanceOrderItem = {
  id?: string | null;
  product_id?: string | null;
  qty?: number | null;
  price?: number | null;
  line_sum?: number | null;
  is_gift?: boolean | null;
  product_name_snapshot?: string | null;
  product?: { name?: string | null; unit?: string | null } | { name?: string | null; unit?: string | null }[] | null;
};

export type FinanceOrder = OrderForAccounting & {
  id?: string | null;
  seller_id?: string | null;
  city_id?: string | null;
  order_items?: FinanceOrderItem[] | null;
};

export type FinanceCategoryTotal = {
  category: string;
  amount: number;
  cityTaggedAmount: number;
  companyWideAmount: number;
  count: number;
};

export type FinanceCityRow = {
  cityId: string;
  cityName: string;
  revenue: number;
  orderCount: number;
  cogsKnown: number;
  cogsComplete: boolean;
  missingCostProductCount: number;
  cityOperatingExpenses: number;
  cityCargoCustoms: number;
  companyExpensesExcluded: number;
  estimatedGrossProfit: number | null;
  estimatedNetProfit: number | null;
};

export type FinanceSellerRow = {
  key: string;
  sellerId: string;
  sellerName: string;
  cityId: string;
  cityName: string;
  orderCount: number;
  revenue: number;
  cogsKnown: number;
  cogsComplete: boolean;
  missingCostProductCount: number;
  estimatedGrossProfit: number | null;
  grossMarginPct: number | null;
};

export type FinanceProductRow = {
  productId: string;
  name: string;
  unit: string;
  qtySold: number;
  qtyGift: number;
  revenue: number;
  unitCost: number | null;
  cogsKnown: number;
  costMissing: boolean;
  estimatedGrossProfit: number | null;
};

export type SellerFinancePnl = {
  loaded: boolean;
  commissionAccrued: number;
  commissionReversed: number;
  goodsCogs: number;
  goodsCredit: number;
  goodsCogsComplete: boolean;
  goodsUnknownCostLineCount: number;
  goodsZeroCostLineCount: number;
  goodsIssueCount: number;
  goodsReturnCount: number;
  goodsAdvanceCredit: number;
  goodsSettlementCredit: number;
  ledgerGoodsSigned: number;
  goodsLedgerDelta: number;
  goodsLedgerConsistent: boolean;
  cashPayout: number;
  cashAdvance: number;
  liabilityBalanceEnd: number;
  adjustmentsSigned: number;
  adjustmentsCount: number;
  sellerCompensationNet: number;
  payoutLegacyOpex: number;
  payoutDuplicate: number;
  payoutUnclassified: number;
  payoutUnclassifiedCount: number;
  cutoverDate: string | null;
  missingRateCount: number;
  unpaidDebtAccrued: number;
};

export type AdminFinanceReport = {
  revenue: number;
  grossRevenue: number;
  recognizedOrderCount: number;
  averageCheck: number;
  cogsKnown: number;
  salesCogs: number;
  cogsComplete: boolean;
  missingCostProductCount: number;
  missingCostLineCount: number;
  giftCogsKnown: number;
  estimatedGrossProfit: number | null;
  partialGrossProfit: number;
  expensesByCategory: FinanceCategoryTotal[];
  operatingExpenses: number;
  otherOperatingExpenses: number;
  cargoCustomsExpenses: number;
  companyWideExpenses: number;
  cityTaggedExpenses: number;
  expensesComplete: boolean;
  commissionAccrual: number;
  commissionReversal: number;
  goodsIssueCogs: number;
  goodsSettlementCredit: number;
  sellerCompensationNet: number;
  sellerLiability: number;
  cashPayouts: number;
  cashAdvances: number;
  sellerPayoutLegacyOpex: number;
  sellerPayoutDuplicate: number;
  sellerPayoutUnclassified: number;
  sellerAdjustmentsSigned: number;
  sellerAdjustmentsCount: number;
  goodsAdvanceCredit: number;
  goodsIssueSettlementCredit: number;
  goodsIssueCount: number;
  goodsReturnCount: number;
  missingRateCount: number;
  unpaidDebtAccrued: number;
  goodsZeroCostLineCount: number;
  sellerPnlStatus: SellerPnlStatus;
  cityScoped: boolean;
  goodsLedgerDelta: number;
  goodsLedgerConsistent: boolean;
  profitReviewRequired: boolean;
  computedNetProfit: number | null;
  estimatedNetProfit: number | null;
  preliminaryNetProfit: number | null;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  cityRows: FinanceCityRow[];
  sellerRows: FinanceSellerRow[];
  productRows: FinanceProductRow[];
  warnings: FinanceWarningCode[];
  profitReliable: boolean;
  cogsQuality: FinanceCogsQuality;
  cogsIsHistorical: boolean;
};

export type BuildAdminFinanceInput = {
  orders: FinanceOrder[];
  range: { from: Date; toNext: Date };
  fromYmd: string;
  toYmd: string;
  costs: ProductCostRow[] | null | undefined;
  expenses: FinanceExpenseRow[] | null | undefined;
  cityNames?: Map<string, string>;
  sellerNames?: Map<string, string>;
  deletedSellerLabel?: string;
  noSellerLabel?: string;
  unnamedCityLabel?: string;
  expensesInputComplete?: boolean;
  itemSnapshots?: Map<string, number | null> | null;
  itemSnapshotsUnavailable?: boolean;
  sellerPnl?: SellerFinancePnl | null;
  sellerPnlStatus?: SellerPnlStatus;
  cityScoped?: boolean;
};

function money(n: number): number {
  return Number(n.toFixed(2));
}

function asAmount(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ymdOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function inYmdSpan(dateYmd: string, fromYmd: string, toYmd: string): boolean {
  return dateYmd >= fromYmd && dateYmd <= toYmd;
}

function productLabel(item: FinanceOrderItem): { name: string; unit: string } {
  const p = Array.isArray(item.product) ? item.product[0] : item.product;
  return {
    name: (item.product_name_snapshot || p?.name || 'Товар').trim(),
    unit: p?.unit || 'pcs',
  };
}

export function costByProductId(costs: ProductCostRow[] | null | undefined): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const row of costs || []) {
    if (!row?.id) continue;
    const raw = row.cost_price;
    if (raw == null || raw === ('' as unknown)) {
      map.set(row.id, null);
      continue;
    }
    const n = Number(raw);
    map.set(row.id, Number.isFinite(n) ? n : null);
  }
  return map;
}

export function lookupUnitCost(costMap: Map<string, number | null>, productId: string | null | undefined): number | null {
  if (!productId) return null;
  if (!costMap.has(productId)) return null;
  const v = costMap.get(productId);
  return v == null || Number.isNaN(v) ? null : v;
}

/** Живые строки журнала: без soft-delete, в периоде, без дублей id/operation_id. */
export function uniqueLiveExpenses(
  expenses: FinanceExpenseRow[] | null | undefined,
  fromYmd: string,
  toYmd: string
): FinanceExpenseRow[] {
  const out: FinanceExpenseRow[] = [];
  const seenId = new Set<string>();
  const seenOp = new Set<string>();
  for (const row of expenses || []) {
    if (row.deleted_at != null && String(row.deleted_at).trim() !== '') continue;
    const day = ymdOf(row.expense_date);
    if (!day || !inYmdSpan(day, fromYmd, toYmd)) continue;
    const id = row.id ? String(row.id) : '';
    const op = row.operation_id ? String(row.operation_id) : '';
    if (id && seenId.has(id)) continue;
    if (op && seenOp.has(op)) continue;
    if (id) seenId.add(id);
    if (op) seenOp.add(op);
    out.push(row);
  }
  return out;
}

function parseJsonbItems<T>(payload: unknown): T[] {
  let value: unknown = payload;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (value == null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'object' && value !== null && 'items' in value) {
    let items: unknown = (value as { items?: unknown }).items;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        return [];
      }
    }
    return Array.isArray(items) ? (items as T[]) : [];
  }
  return [];
}

export function parseFinanceExpensesList(payload: unknown): FinanceExpenseRow[] {
  return parseJsonbItems<FinanceExpenseRow>(payload);
}

function jsonNum(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function jsonInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function jsonBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function nested(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function emptySellerFinancePnl(): SellerFinancePnl {
  return {
    loaded: false,
    commissionAccrued: 0,
    commissionReversed: 0,
    goodsCogs: 0,
    goodsCredit: 0,
    goodsCogsComplete: true,
    goodsUnknownCostLineCount: 0,
    goodsZeroCostLineCount: 0,
    goodsIssueCount: 0,
    goodsReturnCount: 0,
    goodsAdvanceCredit: 0,
    goodsSettlementCredit: 0,
    ledgerGoodsSigned: 0,
    goodsLedgerDelta: 0,
    goodsLedgerConsistent: true,
    cashPayout: 0,
    cashAdvance: 0,
    liabilityBalanceEnd: 0,
    adjustmentsSigned: 0,
    adjustmentsCount: 0,
    sellerCompensationNet: 0,
    payoutLegacyOpex: 0,
    payoutDuplicate: 0,
    payoutUnclassified: 0,
    payoutUnclassifiedCount: 0,
    cutoverDate: null,
    missingRateCount: 0,
    unpaidDebtAccrued: 0,
  };
}

export function parseSellerFinancePnl(payload: unknown): SellerFinancePnl {
  const empty = emptySellerFinancePnl();
  let value: unknown = payload;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return empty;
    }
  }
  if (!value || typeof value !== 'object') return empty;
  const root = value as Record<string, unknown>;
  const commissions = nested(root, 'commissions');
  const goods = nested(root, 'goods');
  const cash = nested(root, 'cash');
  const liability = nested(root, 'liability');
  const adjustments = nested(root, 'adjustments');
  const manual = nested(root, 'manual_seller_payout');
  const pnl = nested(root, 'pnl');
  const accrued = jsonNum(commissions.accrued ?? pnl.commission_accrued);
  const reversed = jsonNum(commissions.reversed ?? pnl.commission_reversed);
  const goodsCogs = jsonNum(goods.cogs ?? pnl.goods_cogs);
  const goodsCredit = jsonNum(goods.credit ?? pnl.goods_credit);
  const compensation = jsonNum(
    pnl.seller_compensation_net ?? accrued - reversed + goodsCogs - goodsCredit,
  );
  const cutover = manual.cutover_date;
  return {
    loaded: true,
    commissionAccrued: accrued,
    commissionReversed: reversed,
    goodsCogs,
    goodsCredit,
    goodsCogsComplete: jsonBool(goods.cogs_complete, true),
    goodsUnknownCostLineCount: jsonInt(goods.unknown_cost_line_count),
    goodsZeroCostLineCount: jsonInt(goods.zero_cost_line_count),
    goodsIssueCount: jsonInt(goods.issue_count),
    goodsReturnCount: jsonInt(goods.return_count),
    goodsAdvanceCredit: jsonNum(goods.advance_credit),
    goodsSettlementCredit: jsonNum(goods.settlement_credit),
    ledgerGoodsSigned: jsonNum(goods.ledger_goods_signed),
    goodsLedgerDelta: jsonNum(goods.ledger_delta ?? goodsCredit + jsonNum(goods.ledger_goods_signed)),
    goodsLedgerConsistent: jsonBool(goods.ledger_consistent, Math.abs(jsonNum(goods.ledger_delta)) < 0.005),
    cashPayout: jsonNum(cash.payout),
    cashAdvance: jsonNum(cash.advance),
    liabilityBalanceEnd: jsonNum(liability.balance_end),
    adjustmentsSigned: jsonNum(adjustments.signed),
    adjustmentsCount: jsonInt(adjustments.count),
    sellerCompensationNet: compensation,
    payoutLegacyOpex: jsonNum(manual.legacy_opex_amount),
    payoutDuplicate: jsonNum(manual.settlement_duplicate_amount),
    payoutUnclassified: jsonNum(manual.unclassified_amount),
    payoutUnclassifiedCount: jsonInt(manual.unclassified_count),
    cutoverDate: typeof cutover === 'string' && cutover ? cutover.slice(0, 10) : null,
    missingRateCount: jsonInt(commissions.missing_rate_count),
    unpaidDebtAccrued: jsonNum(commissions.unpaid_debt_accrued),
  };
}

export type FinanceExpenseEventRow = {
  id?: string | null;
  expense_id?: string | null;
  action?: string | null;
  actor_id?: string | null;
  created_at?: string | null;
  before_row?: unknown;
  after_row?: unknown;
};

export function parseFinanceExpenseEvents(payload: unknown): FinanceExpenseEventRow[] {
  return parseJsonbItems<FinanceExpenseEventRow>(payload);
}

export type FinanceRpcErrorKind = 'permission' | 'network' | 'conflict' | 'missing' | 'other';

export function financeRpcErrorKind(message: string | null | undefined): FinanceRpcErrorKind {
  const m = (message || '').toLowerCase();
  if (!m) return 'other';
  if (
    m.includes('could not find the function') ||
    m.includes('pgrst202') ||
    m.includes('function public.admin_finance_seller_pnl') ||
    (m.includes('does not exist') && m.includes('admin_finance_seller_pnl'))
  ) {
    return 'missing';
  }
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed')) return 'network';
  if (
    m.includes('42501') ||
    m.includes('permission denied') ||
    m.includes('not authenticated') ||
    m.includes('finance permission denied') ||
    m.includes('account is inactive') ||
    m.includes('only admin can read product cost')
  ) {
    return 'permission';
  }
  if (m.includes('idempotency key reused')) return 'conflict';
  return 'other';
}

export function sellerPnlFromRpc(
  data: unknown,
  errorMessage: string | null | undefined
): { pnl: SellerFinancePnl | null; status: SellerPnlStatus } {
  if (errorMessage) {
    return {
      pnl: null,
      status: financeRpcErrorKind(errorMessage) === 'missing' ? 'missing' : 'error',
    };
  }
  const parsed = parseSellerFinancePnl(data);
  if (!parsed.loaded) return { pnl: null, status: 'error' };
  return { pnl: parsed, status: 'connected' };
}

export function mergeFinanceOrders(batches: FinanceOrder[][]): FinanceOrder[] {
  const seen = new Set<string>();
  const out: FinanceOrder[] = [];
  for (const batch of batches) {
    for (const order of batch) {
      if (order.id) {
        if (seen.has(order.id)) continue;
        seen.add(order.id);
      }
      out.push(order);
    }
  }
  return out;
}

export function buildAdminFinance(input: BuildAdminFinanceInput): AdminFinanceReport {
  const {
    orders,
    range,
    fromYmd,
    toYmd,
    costs,
    expenses,
    cityNames,
    sellerNames,
    deletedSellerLabel = 'Удалённый продавец',
    noSellerLabel = 'Без продавца',
    unnamedCityLabel = 'Без города',
    expensesInputComplete = false,
    itemSnapshots = new Map(),
    itemSnapshotsUnavailable = false,
    sellerPnl: sellerPnlInput = null,
    sellerPnlStatus = 'skipped',
    cityScoped = false,
  } = input;
  const snapshotMap = itemSnapshotsUnavailable ? null : itemSnapshots;
  const sellerPnl = sellerPnlInput?.loaded ? sellerPnlInput : emptySellerFinancePnl();
  const sellerPnlLoaded = sellerPnl.loaded;

  const uniqueOrders = mergeFinanceOrders([orders]);
  const recognized = uniqueOrders.filter((o) => isConfirmedInRange(o, range));
  const revenue = money(sumConfirmedInRange(uniqueOrders, range));
  const costMap = costByProductId(costs);
  const liveExpenses = uniqueLiveExpenses(expenses, fromYmd, toYmd);

  let cogsKnown = 0;
  let giftCogsKnown = 0;
  let missingCostLineCount = 0;
  let historicalLineCount = 0;
  let estimatedLineCount = 0;
  const missingProducts = new Set<string>();

  type CityAcc = {
    revenue: number;
    orderCount: number;
    cogsKnown: number;
    missing: Set<string>;
    cityOperating: number;
    cityCargo: number;
  };
  const cityMap = new Map<string, CityAcc>();

  type SellerAcc = {
    sellerId: string;
    sellerName: string;
    cityId: string;
    revenue: number;
    orderCount: number;
    cogsKnown: number;
    missing: Set<string>;
  };
  const sellerMap = new Map<string, SellerAcc>();

  const sellerIdentity = (sellerId: string | null | undefined): { id: string; name: string } => {
    if (!sellerId) return { id: '__none__', name: noSellerLabel };
    const named = (sellerNames?.get(sellerId) || '').trim();
    if (named) return { id: sellerId, name: named };
    return { id: sellerId, name: `${deletedSellerLabel} · ${sellerId.slice(0, 8)}` };
  };

  type ProdAcc = {
    name: string;
    unit: string;
    qtySold: number;
    qtyGift: number;
    revenue: number;
    unitCost: number | null;
    cogsKnown: number;
    costMissing: boolean;
    units: Set<number>;
  };
  const productMap = new Map<string, ProdAcc>();

  const ensureCity = (cityId: string): CityAcc => {
    let acc = cityMap.get(cityId);
    if (!acc) {
      acc = {
        revenue: 0,
        orderCount: 0,
        cogsKnown: 0,
        missing: new Set(),
        cityOperating: 0,
        cityCargo: 0,
      };
      cityMap.set(cityId, acc);
    }
    return acc;
  };

  const addCogs = (
    productId: string,
    qty: number,
    isGift: boolean,
    city: CityAcc,
    seller: SellerAcc,
    unit: number | null,
    source: 'historical' | 'estimated' | 'unknown'
  ) => {
    if (!(qty > 0)) return;
    if (source === 'historical') historicalLineCount += 1;
    else if (source === 'estimated') estimatedLineCount += 1;
    if (unit == null || source === 'unknown') {
      missingCostLineCount += 1;
      missingProducts.add(productId || '__unknown__');
      city.missing.add(productId || '__unknown__');
      seller.missing.add(productId || '__unknown__');
      return;
    }
    const line = money(qty * unit);
    cogsKnown = money(cogsKnown + line);
    city.cogsKnown = money(city.cogsKnown + line);
    seller.cogsKnown = money(seller.cogsKnown + line);
    if (isGift) giftCogsKnown = money(giftCogsKnown + line);
  };

  for (const order of recognized) {
    const cityId = order.city_id || '__none__';
    const city = ensureCity(cityId);
    city.revenue = money(city.revenue + asAmount(order.total_sum));
    city.orderCount += 1;
    const ident = sellerIdentity(order.seller_id);
    const sellerKey = `${ident.id}::${cityId}`;
    let seller = sellerMap.get(sellerKey);
    if (!seller) {
      seller = {
        sellerId: ident.id,
        sellerName: ident.name,
        cityId,
        revenue: 0,
        orderCount: 0,
        cogsKnown: 0,
        missing: new Set(),
      };
      sellerMap.set(sellerKey, seller);
    }
    seller.revenue = money(seller.revenue + asAmount(order.total_sum));
    seller.orderCount += 1;

    const allocated = allocateOrderLines(order as StatsOrder);
    for (const line of allocated.lines) {
      const pid = line.meta.productId;
      let prod = productMap.get(pid);
      if (!prod) {
        prod = {
          name: line.meta.name,
          unit: line.meta.unit,
          qtySold: 0,
          qtyGift: 0,
          revenue: 0,
          unitCost: null,
          cogsKnown: 0,
          costMissing: false,
          units: new Set(),
        };
        productMap.set(pid, prod);
      }
      prod.qtySold += line.qty;
      prod.revenue = money(prod.revenue + line.revenue);
    }

    for (const item of order.order_items ?? []) {
      const qty = Number(item.qty ?? 0);
      const pid = item.product_id || productLabel(item).name;
      const gift = item.is_gift === true;
      const catalog = lookupUnitCost(costMap, pid);
      const resolved = resolveLineUnitCost({
        snapshot: snapshotForItem(item, snapshotMap),
        catalog,
      });
      addCogs(pid, qty, gift, city, seller, resolved.unit, resolved.source);
      if (!(qty > 0)) continue;
      const { name, unit } = productLabel(item);
      let prod = productMap.get(pid);
      if (!prod) {
        prod = {
          name,
          unit,
          qtySold: 0,
          qtyGift: 0,
          revenue: 0,
          unitCost: null,
          cogsKnown: 0,
          costMissing: false,
          units: new Set(),
        };
        productMap.set(pid, prod);
      }
      if (gift) prod.qtyGift += qty;
      if (resolved.unit == null || resolved.source === 'unknown') prod.costMissing = true;
      else {
        prod.cogsKnown = money(prod.cogsKnown + qty * resolved.unit);
        prod.units.add(resolved.unit);
      }
    }
  }

  const categoryMap = new Map<string, FinanceCategoryTotal>();
  let operatingExpenses = 0;
  let cargoCustomsExpenses = 0;
  let companyWideExpenses = 0;
  let cityTaggedExpenses = 0;

  for (const row of liveExpenses) {
    const amount = money(asAmount(row.amount));
    if (!(amount > 0)) continue;
    const category = (row.category || 'other').trim() || 'other';
    const cityId = row.city_id ? String(row.city_id) : null;
    let cat = categoryMap.get(category);
    if (!cat) {
      cat = { category, amount: 0, cityTaggedAmount: 0, companyWideAmount: 0, count: 0 };
      categoryMap.set(category, cat);
    }
    cat.amount = money(cat.amount + amount);
    cat.count += 1;
    if (cityId) {
      cat.cityTaggedAmount = money(cat.cityTaggedAmount + amount);
      cityTaggedExpenses = money(cityTaggedExpenses + amount);
      const city = ensureCity(cityId);
      if (category === FINANCE_CARGO_CUSTOMS_CATEGORY) {
        city.cityCargo = money(city.cityCargo + amount);
      } else if (!((sellerPnlLoaded || cityScoped) && category === FINANCE_SELLER_PAYOUT_CATEGORY)) {
        city.cityOperating = money(city.cityOperating + amount);
      }
    } else if (!((sellerPnlLoaded || cityScoped) && category === FINANCE_SELLER_PAYOUT_CATEGORY)) {
      cat.companyWideAmount = money(cat.companyWideAmount + amount);
      companyWideExpenses = money(companyWideExpenses + amount);
    }
    const skipPayoutInOpex = (sellerPnlLoaded || cityScoped) && category === FINANCE_SELLER_PAYOUT_CATEGORY;
    if (category === FINANCE_CARGO_CUSTOMS_CATEGORY) {
      cargoCustomsExpenses = money(cargoCustomsExpenses + amount);
    } else if (!skipPayoutInOpex) {
      operatingExpenses = money(operatingExpenses + amount);
    }
  }

  const applySellerCompensation = sellerPnlLoaded && !cityScoped;
  if (applySellerCompensation && sellerPnl.payoutLegacyOpex > 0) {
    operatingExpenses = money(operatingExpenses + sellerPnl.payoutLegacyOpex);
    companyWideExpenses = money(companyWideExpenses + sellerPnl.payoutLegacyOpex);
  }

  const cogsComplete = missingCostLineCount === 0;
  const goodsCogsComplete = sellerPnl.goodsCogsComplete;
  const missingCostProductCount = missingProducts.size;
  const partialGrossProfit = money(revenue - cogsKnown);
  const estimatedGrossProfit = cogsComplete ? partialGrossProfit : null;
  const sellerCompensationNet = applySellerCompensation ? money(sellerPnl.sellerCompensationNet) : 0;
  const otherOperatingExpenses = operatingExpenses;
  const computedNetProfit =
    !cityScoped && cogsComplete && goodsCogsComplete
      ? money(partialGrossProfit - sellerCompensationNet - otherOperatingExpenses)
      : null;
  const profitReviewRequired =
    cityScoped ||
    sellerPnl.adjustmentsCount > 0 ||
    sellerPnl.payoutUnclassified > 0 ||
    sellerPnl.payoutUnclassifiedCount > 0 ||
    sellerPnl.missingRateCount > 0 ||
    !sellerPnl.goodsLedgerConsistent;
  const pnlDisconnected = sellerPnlStatus === 'missing' || sellerPnlStatus === 'error';
  const netInputsComplete =
    !cityScoped &&
    !pnlDisconnected &&
    cogsComplete &&
    goodsCogsComplete &&
    expensesInputComplete &&
    !profitReviewRequired;
  const estimatedNetProfit = netInputsComplete ? computedNetProfit : null;
  const preliminaryNetProfit =
    !pnlDisconnected && cogsComplete && goodsCogsComplete && !expensesInputComplete && !profitReviewRequired
      ? computedNetProfit
      : null;
  const profitReliable = netInputsComplete;

  const lineCount = historicalLineCount + estimatedLineCount + missingCostLineCount;
  let cogsQuality: FinanceCogsQuality = 'estimated';
  if (missingCostLineCount > 0) cogsQuality = 'incomplete';
  else if (historicalLineCount > 0 && estimatedLineCount > 0) cogsQuality = 'mixed';
  else if (historicalLineCount > 0 && estimatedLineCount === 0) cogsQuality = 'historical';
  else cogsQuality = 'estimated';
  if (itemSnapshotsUnavailable && cogsQuality === 'historical') cogsQuality = 'estimated';
  const cogsIsHistorical = cogsQuality === 'historical' && !itemSnapshotsUnavailable && lineCount > 0;

  const warnings: FinanceWarningCode[] = [];
  if (itemSnapshotsUnavailable) warnings.push('cogs_historical_unavailable');
  if (cogsQuality === 'mixed') warnings.push('cogs_mixed_historical_and_estimated');
  else if (cogsQuality === 'estimated' && lineCount > 0 && !itemSnapshotsUnavailable) {
    warnings.push('cogs_is_current_catalog_not_historical');
  }
  if (!cogsComplete) warnings.push('cogs_incomplete');
  if (!goodsCogsComplete) warnings.push('seller_goods_cogs_incomplete');
  if (!expensesInputComplete) warnings.push('expenses_incomplete');
  if (sellerPnl.payoutUnclassified > 0 || sellerPnl.payoutUnclassifiedCount > 0) {
    warnings.push('seller_payout_unclassified');
  }
  if (sellerPnl.adjustmentsCount > 0) warnings.push('seller_adjustments_unclassified');
  if (!sellerPnl.goodsLedgerConsistent) warnings.push('seller_goods_ledger_mismatch');
  if (pnlDisconnected) warnings.push('seller_pnl_unavailable');
  if (sellerPnl.missingRateCount > 0) warnings.push('seller_missing_rate');
  if (sellerPnl.unpaidDebtAccrued > 0) warnings.push('seller_unpaid_debt_accrual');
  if (sellerPnl.goodsZeroCostLineCount > 0) warnings.push('seller_goods_zero_cost');
  if (cityScoped) warnings.push('seller_city_scope');
  warnings.push('cargo_customs_held_out_of_net');
  if (companyWideExpenses > 0) warnings.push('company_expenses_not_allocated_to_cities');
  if (revenue === 0) warnings.push('zero_revenue');

  const grossMarginPct =
    revenue > 0 && estimatedGrossProfit != null ? money((estimatedGrossProfit / revenue) * 100) : null;
  const netMarginPct =
    revenue > 0 && estimatedNetProfit != null ? money((estimatedNetProfit / revenue) * 100) : null;

  const cityRows: FinanceCityRow[] = Array.from(cityMap.entries())
    .map(([cityId, acc]) => {
      const cityCogsComplete = acc.missing.size === 0;
      const estimatedGross = cityCogsComplete ? money(acc.revenue - acc.cogsKnown) : null;
      return {
        cityId,
        cityName: cityNames?.get(cityId) || unnamedCityLabel,
        revenue: acc.revenue,
        orderCount: acc.orderCount,
        cogsKnown: acc.cogsKnown,
        cogsComplete: cityCogsComplete,
        missingCostProductCount: acc.missing.size,
        cityOperatingExpenses: acc.cityOperating,
        cityCargoCustoms: acc.cityCargo,
        companyExpensesExcluded: companyWideExpenses,
        estimatedGrossProfit: estimatedGross,
        estimatedNetProfit:
          cityCogsComplete && expensesInputComplete ? money((estimatedGross ?? 0) - acc.cityOperating) : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || a.cityName.localeCompare(b.cityName, 'ru'));

  const sellerRows: FinanceSellerRow[] = Array.from(sellerMap.entries())
    .map(([key, acc]) => {
      const sellerCogsComplete = acc.missing.size === 0;
      const estimatedGross = sellerCogsComplete ? money(acc.revenue - acc.cogsKnown) : null;
      return {
        key,
        sellerId: acc.sellerId,
        sellerName: acc.sellerName,
        cityId: acc.cityId,
        cityName: cityNames?.get(acc.cityId) || unnamedCityLabel,
        orderCount: acc.orderCount,
        revenue: acc.revenue,
        cogsKnown: acc.cogsKnown,
        cogsComplete: sellerCogsComplete,
        missingCostProductCount: acc.missing.size,
        estimatedGrossProfit: estimatedGross,
        grossMarginPct:
          acc.revenue > 0 && estimatedGross != null ? money((estimatedGross / acc.revenue) * 100) : null,
      };
    })
    .sort(
      (a, b) =>
        (b.estimatedGrossProfit ?? Number.NEGATIVE_INFINITY) - (a.estimatedGrossProfit ?? Number.NEGATIVE_INFINITY) ||
        b.revenue - a.revenue ||
        a.sellerName.localeCompare(b.sellerName, 'ru') ||
        a.cityName.localeCompare(b.cityName, 'ru')
    );

  const productRows: FinanceProductRow[] = Array.from(productMap.entries())
    .map(([productId, acc]) => ({
      productId,
      name: acc.name,
      unit: acc.unit,
      qtySold: acc.qtySold,
      qtyGift: acc.qtyGift,
      revenue: acc.revenue,
      unitCost: acc.units.size === 1 ? [...acc.units][0] : null,
      cogsKnown: acc.cogsKnown,
      costMissing: acc.costMissing,
      estimatedGrossProfit: acc.costMissing ? null : money(acc.revenue - acc.cogsKnown),
    }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru'));

  return {
    revenue,
    grossRevenue: revenue,
    recognizedOrderCount: recognized.length,
    averageCheck: recognized.length > 0 ? money(revenue / recognized.length) : 0,
    cogsKnown,
    salesCogs: cogsKnown,
    cogsComplete,
    missingCostProductCount,
    missingCostLineCount,
    giftCogsKnown,
    estimatedGrossProfit,
    partialGrossProfit,
    expensesByCategory: [...categoryMap.values()].sort((a, b) => a.category.localeCompare(b.category)),
    operatingExpenses,
    otherOperatingExpenses,
    cargoCustomsExpenses,
    companyWideExpenses,
    cityTaggedExpenses,
    expensesComplete: expensesInputComplete,
    commissionAccrual: sellerPnl.commissionAccrued,
    commissionReversal: sellerPnl.commissionReversed,
    goodsIssueCogs: sellerPnl.goodsCogs,
    goodsSettlementCredit: sellerPnl.goodsCredit,
    sellerCompensationNet,
    sellerLiability: sellerPnl.liabilityBalanceEnd,
    cashPayouts: sellerPnl.cashPayout,
    cashAdvances: sellerPnl.cashAdvance,
    sellerPayoutLegacyOpex: sellerPnl.payoutLegacyOpex,
    sellerPayoutDuplicate: sellerPnl.payoutDuplicate,
    sellerPayoutUnclassified: sellerPnl.payoutUnclassified,
    sellerAdjustmentsSigned: sellerPnl.adjustmentsSigned,
    sellerAdjustmentsCount: sellerPnl.adjustmentsCount,
    goodsAdvanceCredit: sellerPnl.goodsAdvanceCredit,
    goodsIssueSettlementCredit: sellerPnl.goodsSettlementCredit,
    goodsIssueCount: sellerPnl.goodsIssueCount,
    goodsReturnCount: sellerPnl.goodsReturnCount,
    missingRateCount: sellerPnl.missingRateCount,
    unpaidDebtAccrued: sellerPnl.unpaidDebtAccrued,
    goodsZeroCostLineCount: sellerPnl.goodsZeroCostLineCount,
    sellerPnlStatus,
    cityScoped,
    goodsLedgerDelta: sellerPnl.goodsLedgerDelta,
    goodsLedgerConsistent: sellerPnl.goodsLedgerConsistent,
    profitReviewRequired,
    computedNetProfit,
    estimatedNetProfit,
    preliminaryNetProfit,
    grossMarginPct,
    netMarginPct,
    cityRows,
    sellerRows,
    productRows,
    warnings,
    profitReliable,
    cogsQuality,
    cogsIsHistorical,
  };
}
