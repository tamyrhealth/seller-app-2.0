import { getAccountingDate, isConfirmedInRange } from '@/lib/accounting';
import {
  addDaysYmd,
  getTodayLocalISO,
  getYmdSpanRangeInTz,
  startOfMonthYmd,
  ymdInTz,
} from '@/lib/datetime';

export type StatsPeriodPreset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom';

export type StatsOrderItem = {
  product_id?: string | null;
  qty?: number | null;
  price?: number | null;
  line_sum?: number | null;
  is_gift?: boolean | null;
  product_name_snapshot?: string | null;
  product?: { name?: string | null; unit?: string | null } | { name?: string | null; unit?: string | null }[] | null;
};

export type StatsOrder = {
  id?: string;
  seller_id?: string | null;
  total_sum?: number | null;
  city_id?: string | null;
  created_at?: string | null;
  status?: string | null;
  payment_type?: string | null;
  is_preorder?: boolean | null;
  preorder_status?: string | null;
  fulfilled_at?: string | null;
  is_debt?: boolean | null;
  debt_status?: string | null;
  debt_paid_at?: string | null;
  debt_due_at?: string | null;
  order_items?: StatsOrderItem[] | null;
};

export type QtyByUnit = { unit: string; qty: number };

export type ProductStatRow = {
  key: string;
  name: string;
  unit: string;
  qty: number;
  revenue: number;
};

export type SellerProductRow = {
  key: string;
  name: string;
  unit: string;
  qty: number;
  revenue: number;
};

export type SellerStatRow = {
  key: string;
  name: string;
  revenue: number;
  orderCount: number;
  qtyByUnit: QtyByUnit[];
  sharePct: number;
  products: SellerProductRow[];
};

export type DebtSellerRow = {
  key: string;
  name: string;
  amount: number;
  orderCount: number;
};

export type DailyPoint = {
  date: string;
  revenue: number;
  orders: number;
};

export type AdminStatsResult = {
  revenue: number;
  orderCount: number;
  averageCheck: number;
  qtyByUnit: QtyByUnit[];
  productFilterActive: boolean;
  lineDiscrepancyCount: number;
  lineDiscrepancyAbs: number;
  sellers: SellerStatRow[];
  products: ProductStatRow[];
  daily: DailyPoint[];
  unpaidDebtAmount: number;
  unpaidDebtOrders: number;
  unpaidDebtBySeller: DebtSellerRow[];
  overdueDebtAmount: number | null;
  overdueDebtOrders: number | null;
  overdueAvailable: boolean;
};

function money(n: number | null | undefined): number {
  return typeof n === 'number' && !Number.isNaN(n) ? n : 0;
}

function productMeta(item: StatsOrderItem): { name: string; unit: string; productId: string } {
  const p = Array.isArray(item.product) ? item.product[0] : item.product;
  const name = (item.product_name_snapshot || p?.name || 'Товар').trim();
  const unit = p?.unit || 'pcs';
  const productId = item.product_id || name;
  return { name, unit, productId };
}

function isGift(item: StatsOrderItem): boolean {
  return item.is_gift === true;
}

export function lineAmount(item: StatsOrderItem): number {
  if (isGift(item)) return 0;
  if (item.line_sum != null && item.line_sum !== undefined) {
    const ls = Number(item.line_sum);
    if (!Number.isNaN(ls)) return ls;
  }
  const price = Number(item.price ?? 0);
  const qty = Number(item.qty ?? 0);
  return price * qty;
}

export function matchesProductFilter(item: StatsOrderItem, productId: string | 'all'): boolean {
  if (productId === 'all') return true;
  if (isGift(item)) return false;
  return (item.product_id || '') === productId;
}

type AllocatedLine = {
  item: StatsOrderItem;
  meta: { name: string; unit: string; productId: string };
  qty: number;
  revenue: number;
};

export function allocateOrderLines(order: StatsOrder): { lines: AllocatedLine[]; discrepancy: number } {
  const items = order.order_items ?? [];
  const commercial = items.filter((i) => !isGift(i));
  const lineTotal = commercial.reduce((s, i) => s + lineAmount(i), 0);
  const total = money(order.total_sum);
  let scale = 1;
  let discrepancy = 0;
  if (lineTotal > 0 && Math.abs(lineTotal - total) > 0.5) {
    scale = total / lineTotal;
    discrepancy = total - lineTotal;
  }
  const lines = commercial.map((item) => {
    const meta = productMeta(item);
    return {
      item,
      meta,
      qty: Number(item.qty ?? 0),
      revenue: lineAmount(item) * scale,
    };
  });
  return { lines, discrepancy };
}

export type PeriodSpec = {
  preset: StatsPeriodPreset;
  fromYmd: string;
  toYmd: string;
  range: { from: Date; toNext: Date };
};

export function resolvePeriod(preset: StatsPeriodPreset, customFrom?: string, customTo?: string): PeriodSpec | null {
  const today = getTodayLocalISO('Asia/Almaty');
  let fromYmd = today;
  let toYmd = today;
  if (preset === 'today') {
    fromYmd = today;
    toYmd = today;
  } else if (preset === 'yesterday') {
    fromYmd = addDaysYmd(today, -1);
    toYmd = fromYmd;
  } else if (preset === 'last7') {
    fromYmd = addDaysYmd(today, -6);
    toYmd = today;
  } else if (preset === 'last30') {
    fromYmd = addDaysYmd(today, -29);
    toYmd = today;
  } else if (preset === 'thisMonth') {
    fromYmd = startOfMonthYmd(today);
    toYmd = today;
  } else if (preset === 'lastMonth') {
    const thisStart = startOfMonthYmd(today);
    toYmd = addDaysYmd(thisStart, -1);
    fromYmd = startOfMonthYmd(toYmd);
  } else {
    if (!customFrom || !customTo || customFrom > customTo) return null;
    fromYmd = customFrom;
    toYmd = customTo;
  }
  return {
    preset,
    fromYmd,
    toYmd,
    range: getYmdSpanRangeInTz(fromYmd, toYmd, 'Asia/Almaty'),
  };
}

function addQty(map: Map<string, number>, unit: string, qty: number) {
  if (!qty) return;
  map.set(unit, (map.get(unit) || 0) + qty);
}

function qtyList(map: Map<string, number>): QtyByUnit[] {
  return [...map.entries()]
    .map(([unit, qty]) => ({ unit, qty }))
    .sort((a, b) => b.qty - a.qty || a.unit.localeCompare(b.unit));
}

function sellerLabel(
  sellerId: string | null | undefined,
  sellerNames: Map<string, string>,
  deletedSellerLabel: string
): { key: string; name: string } {
  if (!sellerId) return { key: '__deleted__', name: deletedSellerLabel };
  const named = (sellerNames.get(sellerId) || '').trim();
  if (named) return { key: sellerId, name: named };
  return { key: sellerId, name: `${deletedSellerLabel} · ${sellerId.slice(0, 8)}` };
}

export function isUnpaidDebt(order: StatsOrder): boolean {
  if (order.status === 'canceled') return false;
  const isDebt = order.is_debt === true || order.payment_type === 'debt';
  if (!isDebt) return false;
  if (order.debt_status === 'paid' || order.debt_status === 'written_off') return false;
  if (order.debt_paid_at && String(order.debt_paid_at).trim() !== '') return false;
  return order.debt_status === 'active' || order.debt_status == null;
}

export function buildAdminStats(params: {
  orders: StatsOrder[];
  unpaidDebts: StatsOrder[];
  range: { from: Date; toNext: Date };
  sellerId: string | 'all';
  cityId: string | 'all';
  productId: string | 'all';
  sellerNames: Map<string, string>;
  deletedSellerLabel: string;
  now?: Date;
}): AdminStatsResult {
  const {
    orders,
    unpaidDebts,
    range,
    sellerId,
    cityId,
    productId,
    sellerNames,
    deletedSellerLabel,
  } = params;
  const now = params.now ?? new Date();
  const productFilterActive = productId !== 'all';

  const seen = new Set<string>();
  const unique: StatsOrder[] = [];
  for (const o of orders) {
    if (o.id) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
    }
    unique.push(o);
  }

  const scoped = unique.filter((o) => {
    if (sellerId !== 'all' && o.seller_id !== sellerId) return false;
    if (cityId !== 'all' && o.city_id !== cityId) return false;
    return true;
  });

  const recognized = scoped.filter((o) => isConfirmedInRange(o, range));

  type SellerAcc = {
    name: string;
    revenue: number;
    orderCount: number;
    qty: Map<string, number>;
    products: Map<string, SellerProductRow>;
  };
  const sellerMap = new Map<string, SellerAcc>();
  const productMap = new Map<string, ProductStatRow>();
  const dailyMap = new Map<string, DailyPoint>();
  const qtyAll = new Map<string, number>();
  let revenue = 0;
  let orderCount = 0;
  let lineDiscrepancyCount = 0;
  let lineDiscrepancyAbs = 0;

  for (const o of recognized) {
    const { lines, discrepancy } = allocateOrderLines(o);
    if (Math.abs(discrepancy) > 0.5) {
      lineDiscrepancyCount += 1;
      lineDiscrepancyAbs += Math.abs(discrepancy);
    }
    const matched = productFilterActive
      ? lines.filter((l) => l.meta.productId === productId && l.qty)
      : lines;
    if (productFilterActive && matched.length === 0) continue;

    const orderRevenue = productFilterActive
      ? matched.reduce((s, l) => s + l.revenue, 0)
      : money(o.total_sum);

    const accDate = getAccountingDate(o);
    const dayKey = accDate ? ymdInTz(accDate, 'Asia/Almaty') : '';
    if (dayKey) {
      const d = dailyMap.get(dayKey) || { date: dayKey, revenue: 0, orders: 0 };
      d.revenue += orderRevenue;
      d.orders += 1;
      dailyMap.set(dayKey, d);
    }

    revenue += orderRevenue;
    orderCount += 1;

    const sl = sellerLabel(o.seller_id, sellerNames, deletedSellerLabel);
    let bucket = sellerMap.get(sl.key);
    if (!bucket) {
      bucket = { name: sl.name, revenue: 0, orderCount: 0, qty: new Map(), products: new Map() };
      sellerMap.set(sl.key, bucket);
    }
    bucket.revenue += orderRevenue;
    bucket.orderCount += 1;

    for (const line of matched) {
      if (!line.qty && !line.revenue) continue;
      addQty(qtyAll, line.meta.unit, line.qty);
      addQty(bucket.qty, line.meta.unit, line.qty);
      const pkey = `${line.meta.productId}::${line.meta.unit}`;
      const sp = bucket.products.get(pkey);
      if (sp) {
        sp.qty += line.qty;
        sp.revenue += line.revenue;
      } else {
        bucket.products.set(pkey, {
          key: pkey,
          name: line.meta.name,
          unit: line.meta.unit,
          qty: line.qty,
          revenue: line.revenue,
        });
      }
      const pr = productMap.get(pkey);
      if (pr) {
        pr.qty += line.qty;
        pr.revenue += line.revenue;
      } else {
        productMap.set(pkey, {
          key: pkey,
          name: line.meta.name,
          unit: line.meta.unit,
          qty: line.qty,
          revenue: line.revenue,
        });
      }
    }
  }

  const sellers: SellerStatRow[] = Array.from(sellerMap.entries())
    .map(([key, v]) => ({
      key,
      name: v.name,
      revenue: v.revenue,
      orderCount: v.orderCount,
      qtyByUnit: qtyList(v.qty),
      sharePct: revenue > 0 ? (v.revenue / revenue) * 100 : 0,
      products: [...v.products.values()].sort((a, b) => b.revenue - a.revenue || b.qty - a.qty),
    }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru'));

  const debtSeen = new Set<string>();
  const debtSeller = new Map<string, { name: string; amount: number; orderCount: number }>();
  let unpaidDebtAmount = 0;
  let unpaidDebtOrders = 0;
  let overdueDebtAmount = 0;
  let overdueDebtOrders = 0;
  let overdueKnown = false;

  for (const o of unpaidDebts) {
    if (o.id) {
      if (debtSeen.has(o.id)) continue;
      debtSeen.add(o.id);
    }
    if (sellerId !== 'all' && o.seller_id !== sellerId) continue;
    if (cityId !== 'all' && o.city_id !== cityId) continue;
    if (!isUnpaidDebt(o)) continue;
    if (productFilterActive) {
      const has = (o.order_items ?? []).some((i) => matchesProductFilter(i, productId) && !isGift(i));
      if (!has) continue;
    }
    const amount = money(o.total_sum);
    unpaidDebtAmount += amount;
    unpaidDebtOrders += 1;
    const sl = sellerLabel(o.seller_id, sellerNames, deletedSellerLabel);
    const ds = debtSeller.get(sl.key) || { name: sl.name, amount: 0, orderCount: 0 };
    ds.amount += amount;
    ds.orderCount += 1;
    debtSeller.set(sl.key, ds);
    if (o.debt_due_at && String(o.debt_due_at).trim() !== '') {
      overdueKnown = true;
      const due = new Date(o.debt_due_at);
      if (!Number.isNaN(due.getTime()) && due.getTime() < now.getTime()) {
        overdueDebtAmount += amount;
        overdueDebtOrders += 1;
      }
    }
  }

  return {
    revenue,
    orderCount,
    averageCheck: orderCount > 0 ? revenue / orderCount : 0,
    qtyByUnit: qtyList(qtyAll),
    productFilterActive,
    lineDiscrepancyCount,
    lineDiscrepancyAbs,
    sellers,
    products: [...productMap.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue),
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    unpaidDebtAmount,
    unpaidDebtOrders,
    unpaidDebtBySeller: [...debtSeller.entries()]
      .map(([key, v]) => ({ key, name: v.name, amount: v.amount, orderCount: v.orderCount }))
      .sort((a, b) => b.amount - a.amount),
    overdueAvailable: overdueKnown,
    overdueDebtAmount: overdueKnown ? overdueDebtAmount : null,
    overdueDebtOrders: overdueKnown ? overdueDebtOrders : null,
  };
}

export const UNIT_LABELS: Record<string, string> = {
  pcs: 'шт.',
  kg: 'кг',
  g: 'г',
  l: 'л',
  ml: 'мл',
};

export function formatUnit(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}

export function formatQtyValue(qty: number, unit: string): string {
  const label = formatUnit(unit);
  if (unit === 'kg') return `${Number(qty.toFixed(3)).toString()} ${label}`;
  return `${qty} ${label}`;
}

export function formatQtyByUnit(list: QtyByUnit[]): string {
  if (list.length === 0) return '—';
  return list.map((q) => formatQtyValue(q.qty, q.unit)).join(', ');
}
