import {
  getAccountingDate,
  isConfirmedInRange,
  type OrderForAccounting,
} from '@/lib/accounting';
import { isUnpaidDebt, lineAmount, type StatsOrder, type StatsOrderItem } from '@/lib/adminStats';
import { normalizeCustomerPhone } from '@/lib/customerPhone';
import { ymdInTz } from '@/lib/datetime';

export const CUSTOMER_ORDER_SELECT =
  'id, order_number, seller_id, total_sum, city_id, created_at, status, payment_type, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at, debt_due_at, customer_name, customer_phone, customer_phone_canon, debt_customer_name, debt_customer_phone, order_items(product_id, qty, price, line_sum, is_gift, product_name_snapshot, product:products(name, unit))';

export type CustomerOrder = StatsOrder & {
  order_number?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_phone_canon?: string | null;
  debt_customer_name?: string | null;
  debt_customer_phone?: string | null;
};

export type CustomerProductRow = {
  key: string;
  name: string;
  unit: string;
  qty: number;
  revenue: number;
};

export type CustomerHistoryRow = {
  id: string;
  orderNumber: string | null;
  createdAt: string | null;
  recognizedAt: string | null;
  cityId: string | null;
  cityName: string;
  status: string | null;
  paymentType: string | null;
  isDebt: boolean;
  unpaidDebt: boolean;
  isPreorder: boolean;
  isCanceled: boolean;
  revenue: number;
  totalSum: number;
};

export type CustomerProfile = {
  phone: string;
  names: string[];
  displayName: string;
  cities: { id: string; name: string }[];
  lifetimeRecognizedCount: number;
  lifetimeCreatedCount: number;
  periodRecognizedCount: number;
  periodRevenue: number;
  unpaidDebtAmount: number;
  unpaidDebtOrders: number;
  firstRecognizedAt: string | null;
  lastRecognizedAt: string | null;
  lastCreatedAt: string | null;
  daysSinceLastRecognized: number | null;
  avgDaysBetweenPurchases: number | null;
  isNewInPeriod: boolean;
  isRepeat: boolean;
  inactive30: boolean;
  inactive60: boolean;
  inactive90: boolean;
  favoriteProducts: CustomerProductRow[];
  history: CustomerHistoryRow[];
};

export type CustomerCityRow = {
  cityId: string;
  cityName: string;
  customers: number;
  periodRevenue: number;
  periodOrders: number;
};

export type AdminCustomersReport = {
  complete: boolean;
  loadedOrders: number;
  totalOrders: number | null;
  identifiedOrders: number;
  unidentifiedOrders: number;
  coveragePct: number | null;
  uniqueCustomers: number;
  newCustomers: number;
  repeatCustomers: number;
  periodIdentifiedRevenue: number;
  periodIdentifiedRecognizedCount: number;
  averageCheck: number | null;
  unpaidDebtAmount: number;
  unpaidDebtOrders: number;
  inactive30: number;
  inactive60: number;
  inactive90: number;
  topByRevenue: CustomerProfile[];
  topByOrders: CustomerProfile[];
  byCity: CustomerCityRow[];
  customers: CustomerProfile[];
};

const TZ = 'Asia/Almaty';

function money(n: number | null | undefined): number {
  return typeof n === 'number' && !Number.isNaN(n) ? n : 0;
}

function uniq(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

function productMeta(item: StatsOrderItem): { name: string; unit: string; key: string } {
  const p = Array.isArray(item.product) ? item.product[0] : item.product;
  const name = (item.product_name_snapshot || p?.name || 'Товар').trim();
  const unit = p?.unit || 'pcs';
  return { name, unit, key: item.product_id || name };
}

export function orderCustomerCanon(order: CustomerOrder): string | null {
  return (
    normalizeCustomerPhone(order.customer_phone_canon) ||
    normalizeCustomerPhone(order.customer_phone) ||
    normalizeCustomerPhone(order.debt_customer_phone)
  );
}

export function orderDisplayName(order: CustomerOrder): string | null {
  const name = String(order.customer_name || order.debt_customer_name || '').trim();
  return name || null;
}

export function orderRecognizedRevenue(order: CustomerOrder): number {
  if (order.status === 'canceled') return 0;
  if (!getAccountingDate(order as OrderForAccounting)) return 0;
  const items = order.order_items || [];
  if (items.length > 0) {
    return items.reduce((sum, item) => sum + lineAmount(item), 0);
  }
  return money(order.total_sum);
}

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const from = new Date(`${fromYmd}T12:00:00+05:00`);
  const to = new Date(`${toYmd}T12:00:00+05:00`);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function uniqueOrders(orders: CustomerOrder[]): CustomerOrder[] {
  const seen = new Set<string>();
  const out: CustomerOrder[] = [];
  for (const order of orders) {
    if (order.id) {
      if (seen.has(order.id)) continue;
      seen.add(order.id);
    }
    out.push(order);
  }
  return out;
}

export function buildAdminCustomers(params: {
  orders: CustomerOrder[];
  range: { from: Date; toNext: Date };
  cityId: string | 'all';
  cityNames: Map<string, string>;
  complete: boolean;
  totalOrders?: number | null;
  now?: Date;
}): AdminCustomersReport {
  const now = params.now ?? new Date();
  const todayYmd = ymdInTz(now, TZ);
  const unique = uniqueOrders(params.orders);
  const coverageScope =
    params.cityId === 'all' ? unique : unique.filter((o) => o.city_id === params.cityId);

  let identifiedOrders = 0;
  let unidentifiedOrders = 0;
  for (const order of coverageScope) {
    if (order.status === 'canceled') continue;
    if (orderCustomerCanon(order)) identifiedOrders += 1;
    else unidentifiedOrders += 1;
  }

  const byPhone = new Map<string, CustomerOrder[]>();
  for (const order of unique) {
    const phone = orderCustomerCanon(order);
    if (!phone) continue;
    const list = byPhone.get(phone) || [];
    list.push(order);
    byPhone.set(phone, list);
  }

  const coverageDenom = identifiedOrders + unidentifiedOrders;
  const coveragePct = coverageDenom > 0 ? (identifiedOrders / coverageDenom) * 100 : null;

  const cityName = (id: string | null | undefined) => {
    if (!id) return '—';
    return (params.cityNames.get(id) || '').trim() || id.slice(0, 8);
  };

  const customers: CustomerProfile[] = [];
  const cityMap = new Map<string, CustomerCityRow>();

  for (const [phone, allRows] of byPhone) {
    if (
      params.cityId !== 'all' &&
      !allRows.some((row) => row.city_id === params.cityId && row.status !== 'canceled')
    ) {
      continue;
    }
    const rows = allRows;
    const cityRows = params.cityId === 'all' ? rows : rows.filter((row) => row.city_id === params.cityId);
    const names = uniq(rows.map((row) => orderDisplayName(row) || '').filter(Boolean));
    const cityIds = uniq(rows.map((row) => row.city_id || '').filter(Boolean));
    const recognizedAll = rows
      .map((row) => ({ row, at: getAccountingDate(row as OrderForAccounting) }))
      .filter((x): x is { row: CustomerOrder; at: Date } => x.at != null)
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const first = recognizedAll[0]?.at || null;
    const last = recognizedAll[recognizedAll.length - 1]?.at || null;
    const firstYmd = first ? ymdInTz(first, TZ) : null;
    const lastYmd = last ? ymdInTz(last, TZ) : null;
    const daysSince = lastYmd ? daysBetweenYmd(lastYmd, todayYmd) : null;
    const avgDays =
      recognizedAll.length >= 2 && firstYmd && lastYmd
        ? daysBetweenYmd(firstYmd, lastYmd) / (recognizedAll.length - 1)
        : null;

    const periodRows = recognizedAll.filter(
      (x) => isConfirmedInRange(x.row, params.range) && (params.cityId === 'all' || x.row.city_id === params.cityId)
    );
    const periodRevenue = periodRows.reduce((sum, x) => sum + orderRecognizedRevenue(x.row), 0);
    const unpaid = cityRows.filter((row) => isUnpaidDebt(row));
    const unpaidAmount = unpaid.reduce((sum, row) => sum + money(row.total_sum), 0);

    const createdSorted = [...rows].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const lastCreated = createdSorted[createdSorted.length - 1]?.created_at || null;

    const productMap = new Map<string, CustomerProductRow>();
    for (const { row } of recognizedAll) {
      for (const item of row.order_items || []) {
        if (item.is_gift === true) continue;
        const meta = productMeta(item);
        const prev = productMap.get(meta.key) || {
          key: meta.key,
          name: meta.name,
          unit: meta.unit,
          qty: 0,
          revenue: 0,
        };
        prev.qty += Number(item.qty || 0);
        prev.revenue += lineAmount(item);
        productMap.set(meta.key, prev);
      }
    }

    const isNewInPeriod = first != null && first >= params.range.from && first < params.range.toNext;
    const profile: CustomerProfile = {
      phone,
      names,
      displayName: names[0] || phone,
      cities: cityIds.map((id) => ({ id, name: cityName(id) })),
      lifetimeRecognizedCount: recognizedAll.length,
      lifetimeCreatedCount: rows.length,
      periodRecognizedCount: periodRows.length,
      periodRevenue,
      unpaidDebtAmount: unpaidAmount,
      unpaidDebtOrders: unpaid.length,
      firstRecognizedAt: first ? first.toISOString() : null,
      lastRecognizedAt: last ? last.toISOString() : null,
      lastCreatedAt: lastCreated,
      daysSinceLastRecognized: daysSince,
      avgDaysBetweenPurchases: avgDays,
      isNewInPeriod,
      isRepeat: recognizedAll.length >= 2,
      inactive30: daysSince != null && daysSince >= 30,
      inactive60: daysSince != null && daysSince >= 60,
      inactive90: daysSince != null && daysSince >= 90,
      favoriteProducts: [...productMap.values()].sort(
        (a, b) => b.revenue - a.revenue || b.qty - a.qty || a.name.localeCompare(b.name, 'ru')
      ),
      history: [...rows]
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .map((row) => {
          const recognized = getAccountingDate(row as OrderForAccounting);
          return {
            id: row.id || '',
            orderNumber: row.order_number || null,
            createdAt: row.created_at || null,
            recognizedAt: recognized ? recognized.toISOString() : null,
            cityId: row.city_id || null,
            cityName: cityName(row.city_id),
            status: row.status || null,
            paymentType: row.payment_type || null,
            isDebt: row.is_debt === true || row.payment_type === 'debt',
            unpaidDebt: isUnpaidDebt(row),
            isPreorder: row.is_preorder === true,
            isCanceled: row.status === 'canceled',
            revenue: orderRecognizedRevenue(row),
            totalSum: money(row.total_sum),
          };
        }),
    };
    customers.push(profile);

    for (const city of profile.cities) {
      const acc = cityMap.get(city.id) || {
        cityId: city.id,
        cityName: city.name,
        customers: 0,
        periodRevenue: 0,
        periodOrders: 0,
      };
      acc.customers += 1;
      cityMap.set(city.id, acc);
    }
    for (const { row } of periodRows) {
      const id = row.city_id || '';
      if (!id) continue;
      const acc = cityMap.get(id) || {
        cityId: id,
        cityName: cityName(id),
        customers: 0,
        periodRevenue: 0,
        periodOrders: 0,
      };
      acc.periodRevenue += orderRecognizedRevenue(row);
      acc.periodOrders += 1;
      cityMap.set(id, acc);
    }
  }

  const sorted = [...customers].sort(
    (a, b) => b.periodRevenue - a.periodRevenue || b.lifetimeRecognizedCount - a.lifetimeRecognizedCount
  );
  const periodIdentifiedRevenue = sorted.reduce((s, c) => s + c.periodRevenue, 0);
  const periodIdentifiedRecognizedCount = sorted.reduce((s, c) => s + c.periodRecognizedCount, 0);

  return {
    complete: params.complete,
    loadedOrders: unique.length,
    totalOrders: params.totalOrders ?? unique.length,
    identifiedOrders,
    unidentifiedOrders,
    coveragePct,
    uniqueCustomers: sorted.length,
    newCustomers: sorted.filter((c) => c.isNewInPeriod).length,
    repeatCustomers: sorted.filter((c) => c.isRepeat).length,
    periodIdentifiedRevenue,
    periodIdentifiedRecognizedCount,
    averageCheck:
      periodIdentifiedRecognizedCount > 0 ? periodIdentifiedRevenue / periodIdentifiedRecognizedCount : null,
    unpaidDebtAmount: sorted.reduce((s, c) => s + c.unpaidDebtAmount, 0),
    unpaidDebtOrders: sorted.reduce((s, c) => s + c.unpaidDebtOrders, 0),
    inactive30: sorted.filter((c) => c.inactive30).length,
    inactive60: sorted.filter((c) => c.inactive60).length,
    inactive90: sorted.filter((c) => c.inactive90).length,
    topByRevenue: sorted.filter((c) => c.periodRevenue > 0).slice(0, 10),
    topByOrders: [...sorted]
      .sort(
        (a, b) =>
          b.periodRecognizedCount - a.periodRecognizedCount || b.periodRevenue - a.periodRevenue
      )
      .filter((c) => c.periodRecognizedCount > 0)
      .slice(0, 10),
    byCity: [...cityMap.values()].sort((a, b) => b.periodRevenue - a.periodRevenue || b.customers - a.customers),
    customers: sorted,
  };
}

export type CustomerInactiveFilter = 'all' | '30' | '60' | '90';
export type CustomerSortKey = 'revenue' | 'orders' | 'last';

export function filterCustomerRows(
  customers: CustomerProfile[],
  opts: {
    nameQuery: string;
    phoneQuery: string;
    inactive: CustomerInactiveFilter;
  }
): CustomerProfile[] {
  const nameQ = opts.nameQuery.trim().toLowerCase();
  const phoneDigits = opts.phoneQuery.replace(/\D/g, '');
  return customers.filter((c) => {
    if (opts.inactive === '30' && !c.inactive30) return false;
    if (opts.inactive === '60' && !c.inactive60) return false;
    if (opts.inactive === '90' && !c.inactive90) return false;
    if (nameQ && !c.names.some((n) => n.toLowerCase().includes(nameQ)) && !c.displayName.toLowerCase().includes(nameQ)) {
      return false;
    }
    if (phoneDigits && !c.phone.replace(/\D/g, '').includes(phoneDigits)) return false;
    return true;
  });
}

export function sortCustomerRows(customers: CustomerProfile[], sort: CustomerSortKey): CustomerProfile[] {
  const rows = [...customers];
  if (sort === 'orders') {
    rows.sort((a, b) => b.lifetimeRecognizedCount - a.lifetimeRecognizedCount || b.periodRevenue - a.periodRevenue);
  } else if (sort === 'last') {
    rows.sort((a, b) => String(b.lastRecognizedAt || '').localeCompare(String(a.lastRecognizedAt || '')));
  } else {
    rows.sort((a, b) => b.periodRevenue - a.periodRevenue || b.lifetimeRecognizedCount - a.lifetimeRecognizedCount);
  }
  return rows;
}
