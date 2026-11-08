/**
 * Управленческие финансовые расчёты (этап 5.5.2).
 * Выручка — только через lib/accounting.ts.
 * Себестоимость — только текущий каталог из admin_product_costs(); это оценка, не история.
 * Расходы — журнал admin_finance_expenses_list; закупка партии сюда не подмешивается.
 */

import {
  isConfirmedInRange,
  sumConfirmedInRange,
  type OrderForAccounting,
} from '@/lib/accounting';
import { allocateOrderLines, type StatsOrder } from '@/lib/adminStats';
import type { ProductCostRow } from '@/lib/productCost';

export const FINANCE_COSTS_RPC = 'admin_product_costs' as const;
export const FINANCE_EXPENSES_LIST_RPC = 'admin_finance_expenses_list' as const;
export const FINANCE_EXPENSE_CREATE_RPC = 'admin_finance_expense_create' as const;
export const FINANCE_EXPENSE_UPDATE_RPC = 'admin_finance_expense_update' as const;
export const FINANCE_EXPENSE_DELETE_RPC = 'admin_finance_expense_delete' as const;
export const FINANCE_EXPENSE_EVENTS_RPC = 'admin_finance_expense_events' as const;

export const FINANCE_CARGO_CUSTOMS_CATEGORY = 'cargo_customs' as const;

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
  'id, seller_id, total_sum, city_id, created_at, status, payment_type, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at, debt_payment_method, order_items(product_id, qty, price, line_sum, is_gift, product_name_snapshot, product:products(name, unit))';

export type FinanceWarningCode =
  | 'cogs_is_current_catalog_not_historical'
  | 'cogs_incomplete'
  | 'expenses_incomplete'
  | 'cargo_customs_held_out_of_net'
  | 'company_expenses_not_allocated_to_cities'
  | 'zero_revenue';

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

export type AdminFinanceReport = {
  revenue: number;
  recognizedOrderCount: number;
  averageCheck: number;
  cogsKnown: number;
  cogsComplete: boolean;
  missingCostProductCount: number;
  missingCostLineCount: number;
  giftCogsKnown: number;
  estimatedGrossProfit: number | null;
  partialGrossProfit: number;
  expensesByCategory: FinanceCategoryTotal[];
  operatingExpenses: number;
  cargoCustomsExpenses: number;
  companyWideExpenses: number;
  cityTaggedExpenses: number;
  expensesComplete: boolean;
  estimatedNetProfit: number | null;
  preliminaryNetProfit: number | null;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  cityRows: FinanceCityRow[];
  sellerRows: FinanceSellerRow[];
  productRows: FinanceProductRow[];
  warnings: FinanceWarningCode[];
  profitReliable: boolean;
  cogsIsHistorical: false;
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

export type FinanceRpcErrorKind = 'permission' | 'network' | 'conflict' | 'other';

export function financeRpcErrorKind(message: string | null | undefined): FinanceRpcErrorKind {
  const m = (message || '').toLowerCase();
  if (!m) return 'other';
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
  } = input;

  const uniqueOrders = mergeFinanceOrders([orders]);
  const recognized = uniqueOrders.filter((o) => isConfirmedInRange(o, range));
  const revenue = money(sumConfirmedInRange(uniqueOrders, range));
  const costMap = costByProductId(costs);
  const liveExpenses = uniqueLiveExpenses(expenses, fromYmd, toYmd);

  let cogsKnown = 0;
  let giftCogsKnown = 0;
  let missingCostLineCount = 0;
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

  const addCogs = (productId: string, qty: number, isGift: boolean, city: CityAcc, seller: SellerAcc) => {
    if (!(qty > 0)) return;
    const unit = lookupUnitCost(costMap, productId);
    if (unit == null) {
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
          unitCost: lookupUnitCost(costMap, pid),
          cogsKnown: 0,
          costMissing: lookupUnitCost(costMap, pid) == null,
        };
        productMap.set(pid, prod);
      }
      prod.qtySold += line.qty;
      prod.revenue = money(prod.revenue + line.revenue);
      const unit = lookupUnitCost(costMap, pid);
      if (unit == null) prod.costMissing = true;
      else prod.cogsKnown = money(prod.cogsKnown + line.qty * unit);
    }

    for (const item of order.order_items ?? []) {
      const qty = Number(item.qty ?? 0);
      const pid = item.product_id || productLabel(item).name;
      const gift = item.is_gift === true;
      addCogs(pid, qty, gift, city, seller);
      if (gift && qty > 0) {
        const { name, unit } = productLabel(item);
        let prod = productMap.get(pid);
        if (!prod) {
          prod = {
            name,
            unit,
            qtySold: 0,
            qtyGift: 0,
            revenue: 0,
            unitCost: lookupUnitCost(costMap, pid),
            cogsKnown: 0,
            costMissing: lookupUnitCost(costMap, pid) == null,
          };
          productMap.set(pid, prod);
        }
        prod.qtyGift += qty;
        const unitCost = lookupUnitCost(costMap, pid);
        if (unitCost == null) prod.costMissing = true;
        else prod.cogsKnown = money(prod.cogsKnown + qty * unitCost);
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
      } else {
        city.cityOperating = money(city.cityOperating + amount);
      }
    } else {
      cat.companyWideAmount = money(cat.companyWideAmount + amount);
      companyWideExpenses = money(companyWideExpenses + amount);
    }
    if (category === FINANCE_CARGO_CUSTOMS_CATEGORY) {
      cargoCustomsExpenses = money(cargoCustomsExpenses + amount);
    } else {
      operatingExpenses = money(operatingExpenses + amount);
    }
  }

  const cogsComplete = missingCostLineCount === 0;
  const missingCostProductCount = missingProducts.size;
  const partialGrossProfit = money(revenue - cogsKnown);
  const estimatedGrossProfit = cogsComplete ? partialGrossProfit : null;
  const workingNet = money(partialGrossProfit - operatingExpenses);
  const estimatedNetProfit =
    cogsComplete && expensesInputComplete ? money((estimatedGrossProfit ?? 0) - operatingExpenses) : null;
  const preliminaryNetProfit = cogsComplete && !expensesInputComplete ? workingNet : null;
  const profitReliable = cogsComplete && expensesInputComplete;

  const warnings: FinanceWarningCode[] = ['cogs_is_current_catalog_not_historical'];
  if (!cogsComplete) warnings.push('cogs_incomplete');
  if (!expensesInputComplete) warnings.push('expenses_incomplete');
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
      unitCost: acc.unitCost,
      cogsKnown: acc.cogsKnown,
      costMissing: acc.costMissing,
      estimatedGrossProfit: acc.costMissing ? null : money(acc.revenue - acc.cogsKnown),
    }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru'));

  return {
    revenue,
    recognizedOrderCount: recognized.length,
    averageCheck: recognized.length > 0 ? money(revenue / recognized.length) : 0,
    cogsKnown,
    cogsComplete,
    missingCostProductCount,
    missingCostLineCount,
    giftCogsKnown,
    estimatedGrossProfit,
    partialGrossProfit,
    expensesByCategory: [...categoryMap.values()].sort((a, b) => a.category.localeCompare(b.category)),
    operatingExpenses,
    cargoCustomsExpenses,
    companyWideExpenses,
    cityTaggedExpenses,
    expensesComplete: expensesInputComplete,
    estimatedNetProfit,
    preliminaryNetProfit,
    grossMarginPct,
    netMarginPct,
    cityRows,
    sellerRows,
    productRows,
    warnings,
    profitReliable,
    cogsIsHistorical: false,
  };
}
