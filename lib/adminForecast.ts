import { formatUnit } from '@/lib/adminStats';
import { addDaysYmd, getTodayLocalISO, getYmdSpanRangeInTz } from '@/lib/datetime';
import { transferRemaining } from '@/lib/stockTransfer';

export type ForecastWindow = 7 | 30 | 90;
export type ForecastRateWindow = ForecastWindow | null;
export type ForecastConfidence = 'high' | 'medium' | 'low';

export type ForecastOrderItem = {
  product_id?: string | null;
  qty?: number | null;
  is_gift?: boolean | null;
  product_name_snapshot?: string | null;
  product?: { name?: string | null; unit?: string | null } | { name?: string | null; unit?: string | null }[] | null;
};

export type ForecastOrder = {
  id?: string | null;
  city_id?: string | null;
  created_at?: string | null;
  status?: string | null;
  is_preorder?: boolean | null;
  preorder_status?: string | null;
  fulfilled_at?: string | null;
  is_debt?: boolean | null;
  debt_status?: string | null;
  debt_paid_at?: string | null;
  payment_type?: string | null;
  order_items?: ForecastOrderItem[] | null;
};

export type ForecastInventoryRow = {
  city_id: string;
  product_id: string;
  qty_on_hand: number | string | null;
};

export type ForecastTransferItem = {
  product_id?: string | null;
  qty_sent?: number | null;
  qty_received?: number | null;
  qty_lost?: number | null;
  qty_returned?: number | null;
};

export type ForecastTransfer = {
  id?: string | null;
  status?: string | null;
  from_city_id?: string | null;
  to_city_id?: string | null;
  stock_transfer_items?: ForecastTransferItem[] | null;
};

export type ForecastCatalogProduct = {
  id: string;
  name: string;
  unit: string;
  isActive: boolean;
};

export type ForecastParams = {
  leadDays: number | null;
  safetyDays: number | null;
  targetDays: number | null;
};

export type ForecastCityRow = {
  productId: string;
  name: string;
  unit: string;
  isActive: boolean;
  cityId: string;
  cityName: string;
  qty7: number;
  qty30: number;
  qty90: number;
  rate7: number;
  rate30: number;
  rate90: number;
  analysisQty: number;
  analysisRate: number;
  recRate: number;
  recRateWindow: ForecastRateWindow;
  spike: boolean;
  onHand: number;
  reserve: number;
  available: number;
  inbound: number;
  negativeStock: boolean;
  daysCover: number | null;
  exhaustYmd: string | null;
  targetStock: number | null;
  cityDeficit: number | null;
  citySurplus: number | null;
  confidence: ForecastConfidence;
};

export type ForecastTransferIdea = {
  productId: string;
  name: string;
  unit: string;
  fromCityId: string;
  fromCityName: string;
  toCityId: string;
  toCityName: string;
  qty: number;
  senderAvailableAfter: number;
  receiverCoverDaysAfter: number | null;
};

export type ForecastProductSummary = {
  productId: string;
  name: string;
  unit: string;
  isActive: boolean;
  qty7: number;
  qty30: number;
  qty90: number;
  recRate: number;
  onHand: number;
  reserve: number;
  available: number;
  inbound: number;
  companyStock: number;
  targetStock: number | null;
  purchaseQty: number | null;
  deficitCities: number;
  surplusCities: number;
};

export type AdminForecastReport = {
  complete: boolean;
  recsAvailable: boolean;
  recsBlockedReason: 'truncated' | 'missing_params' | 'target_below_lead_safety' | null;
  todayYmd: string;
  window: ForecastWindow;
  cityRows: ForecastCityRow[];
  products: ForecastProductSummary[];
  transfers: ForecastTransferIdea[];
  deficitProductCount: number;
  excessProductCount: number;
  purchaseProductCount: number;
  transferCount: number;
  negativeStockCount: number;
};

const SPIKE_RATIO = 1.5;
const TZ = 'Asia/Almaty';

export function qty3(n: number): number {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function isWeightOrVolume(unit: string): boolean {
  return unit === 'kg' || unit === 'l' || unit === 'g' || unit === 'ml';
}

/** Только отображение. Внутренние qty не округляются. */
export function formatForecastQty(qty: number | null, unit: string, complete = true): string {
  if (!complete || qty == null || Number.isNaN(qty)) return '—';
  const label = formatUnit(unit);
  if (isWeightOrVolume(unit)) {
    return `${Number(qty.toFixed(3)).toString()} ${label}`;
  }
  return `${Math.round(qty)} ${label}`;
}

/** Скорость: не больше 3 знаков, без подмены единиц. */
export function formatForecastRate(rate: number | null, complete = true): string {
  if (!complete || rate == null || Number.isNaN(rate)) return '—';
  return Number(rate.toFixed(3)).toString();
}

export function forecastRateWindowLabel(window: ForecastRateWindow, t: (key: string) => string): string {
  if (window === 7) return t('forecast.rateFrom7');
  if (window === 30) return t('forecast.rateFrom30');
  if (window === 90) return t('forecast.rateFrom90');
  return t('forecast.rateFromNone');
}

export function recommendQty(qty: number, unit: string): number {
  const q = qty3(Math.max(0, qty));
  if (unit === 'kg' || unit === 'l') return q;
  return Math.ceil(q - 1e-9);
}

function isCanceled(order: ForecastOrder): boolean {
  const status = String(order.status || '').toLowerCase();
  const pre = String(order.preorder_status || '').toLowerCase();
  return status === 'canceled' || status === 'cancelled' || pre === 'cancelled' || pre === 'canceled';
}

export function isPendingPreorder(order: ForecastOrder): boolean {
  if (isCanceled(order)) return false;
  return order.is_preorder === true && String(order.preorder_status || '') === 'pending';
}

/** Дата физического выбытия. Не дата признания выручки. */
export function getPhysicalDemandAt(order: ForecastOrder): Date | null {
  if (isCanceled(order)) return null;
  if (isPendingPreorder(order)) return null;
  const fulfilled = order.fulfilled_at && String(order.fulfilled_at).trim() !== '' ? new Date(order.fulfilled_at) : null;
  const wasFulfilledPreorder =
    String(order.preorder_status || '') === 'fulfilled' ||
    (order.is_preorder === true && fulfilled != null);
  if (wasFulfilledPreorder) {
    if (!fulfilled || Number.isNaN(fulfilled.getTime())) return null;
    return fulfilled;
  }
  if (!order.created_at) return null;
  const created = new Date(order.created_at);
  return Number.isNaN(created.getTime()) ? null : created;
}

export function mergeForecastOrders(batches: ForecastOrder[][]): ForecastOrder[] {
  const seen = new Set<string>();
  const out: ForecastOrder[] = [];
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

function itemMeta(item: ForecastOrderItem): { productId: string; name: string; unit: string } {
  const p = Array.isArray(item.product) ? item.product[0] : item.product;
  const name = (item.product_name_snapshot || p?.name || 'Товар').trim();
  return { productId: item.product_id || name, name, unit: p?.unit || 'pcs' };
}

function orderQtyByProduct(order: ForecastOrder): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of order.order_items || []) {
    const qty = Number(item.qty ?? 0);
    if (!(qty > 0)) continue;
    const id = itemMeta(item).productId;
    map.set(id, qty3((map.get(id) || 0) + qty));
  }
  return map;
}

export function parseForecastParams(raw: {
  leadDays: string;
  safetyDays: string;
  targetDays: string;
}): ForecastParams {
  const num = (s: string) => {
    const n = Number(String(s).replace(',', '.').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    leadDays: num(raw.leadDays),
    safetyDays: num(raw.safetyDays),
    targetDays: num(raw.targetDays),
  };
}

export function forecastParamsReady(params: ForecastParams): boolean {
  return params.leadDays != null && params.safetyDays != null && params.targetDays != null;
}

export function targetBelowLeadSafety(params: ForecastParams): boolean {
  if (!forecastParamsReady(params)) return false;
  return (params.targetDays as number) + 1e-9 < (params.leadDays as number) + (params.safetyDays as number);
}

function inRange(date: Date, from: Date, toNext: Date): boolean {
  return date >= from && date < toNext;
}

function inboundRemaining(transfer: ForecastTransfer, item: ForecastTransferItem): number {
  const status = String(transfer.status || '');
  if (status === 'cancelled' || status === 'canceled') return 0;
  return qty3(
    Math.max(
      0,
      transferRemaining(Number(item.qty_sent || 0), item.qty_received, item.qty_lost, item.qty_returned)
    )
  );
}

/** Закупка: 30 дней; всплеск 7д не раздувает; нет продаж за 30д — 90д, не выбранная кнопка периода. */
export function recRateOf(
  qty7: number,
  qty30: number,
  qty90: number
): { recRate: number; spike: boolean; recRateWindow: ForecastRateWindow } {
  const rate7 = qty7 / 7;
  const rate30 = qty30 / 30;
  const rate90 = qty90 / 90;
  const spike = rate30 > 0 && rate7 > rate30 * SPIKE_RATIO;
  if (spike) return { recRate: rate30, spike: true, recRateWindow: 30 };
  if (qty30 > 0) return { recRate: rate30, spike: false, recRateWindow: 30 };
  if (qty90 > 0) return { recRate: rate90, spike: false, recRateWindow: 90 };
  if (qty7 > 0) return { recRate: rate7, spike: false, recRateWindow: 7 };
  return { recRate: 0, spike: false, recRateWindow: null };
}

function confidenceOf(opts: {
  complete: boolean;
  qty7: number;
  qty30: number;
  qty90: number;
  spike: boolean;
  negativeStock: boolean;
  saleEvents30: number;
}): ForecastConfidence {
  if (!opts.complete || opts.negativeStock) return 'low';
  if (!(opts.qty30 > 0) && !(opts.qty90 > 0) && !(opts.qty7 > 0)) return 'low';
  if (opts.spike) return 'medium';
  if (opts.saleEvents30 >= 8 && opts.qty30 > 0) return 'high';
  if (opts.qty30 > 0 || opts.saleEvents30 >= 3) return 'medium';
  return 'low';
}

function coverDays(available: number, rate: number): number | null {
  if (!(rate > 0)) return null;
  return available / rate;
}

function exhaustYmd(todayYmd: string, days: number | null): string | null {
  if (days == null || !(days >= 0) || !Number.isFinite(days)) return null;
  return addDaysYmd(todayYmd, Math.max(0, Math.floor(days)), TZ);
}

export function buildAdminForecast(input: {
  orders: ForecastOrder[];
  inventory: ForecastInventoryRow[];
  transfers: ForecastTransfer[];
  catalog: ForecastCatalogProduct[];
  cities: Array<{ id: string; name: string }>;
  todayYmd?: string;
  window: ForecastWindow;
  params: ForecastParams;
  complete: boolean;
}): AdminForecastReport {
  const todayYmd = input.todayYmd || getTodayLocalISO(TZ);
  const range7 = getYmdSpanRangeInTz(addDaysYmd(todayYmd, -6, TZ), todayYmd, TZ);
  const range30 = getYmdSpanRangeInTz(addDaysYmd(todayYmd, -29, TZ), todayYmd, TZ);
  const range90 = getYmdSpanRangeInTz(addDaysYmd(todayYmd, -89, TZ), todayYmd, TZ);

  const orders = mergeForecastOrders([input.orders]);
  const cityNames = new Map(input.cities.map((c) => [c.id, c.name]));
  const catalog = new Map(input.catalog.map((p) => [p.id, p]));

  type Acc = {
    name: string;
    unit: string;
    isActive: boolean;
    qty7: number;
    qty30: number;
    qty90: number;
    events30: number;
    onHand: number;
    reserve: number;
    inbound: number;
  };

  const acc = new Map<string, Acc>();
  const keyOf = (productId: string, cityId: string) => `${productId}\0${cityId}`;

  function ensure(productId: string, cityId: string, hint?: { name?: string; unit?: string }): Acc {
    const k = keyOf(productId, cityId);
    let row = acc.get(k);
    if (row) return row;
    const cat = catalog.get(productId);
    row = {
      name: cat?.name || hint?.name || productId,
      unit: cat?.unit || hint?.unit || 'pcs',
      isActive: cat ? cat.isActive : true,
      qty7: 0,
      qty30: 0,
      qty90: 0,
      events30: 0,
      onHand: 0,
      reserve: 0,
      inbound: 0,
    };
    acc.set(k, row);
    return row;
  }

  for (const inv of input.inventory) {
    if (!inv.city_id || !inv.product_id) continue;
    const row = ensure(inv.product_id, inv.city_id);
    row.onHand = qty3(row.onHand + Number(inv.qty_on_hand || 0));
  }

  for (const order of orders) {
    const cityId = order.city_id || '__none__';
    if (isPendingPreorder(order)) {
      for (const [productId, qty] of orderQtyByProduct(order)) {
        const meta = (order.order_items || []).find((i) => itemMeta(i).productId === productId);
        const hint = meta ? itemMeta(meta) : undefined;
        const row = ensure(productId, cityId, hint);
        row.reserve = qty3(row.reserve + qty);
      }
      continue;
    }
    const when = getPhysicalDemandAt(order);
    if (!when) continue;
    const qtys = orderQtyByProduct(order);
    for (const [productId, qty] of qtys) {
      const meta = (order.order_items || []).find((i) => itemMeta(i).productId === productId);
      const hint = meta ? itemMeta(meta) : undefined;
      const row = ensure(productId, cityId, hint);
      if (inRange(when, range90.from, range90.toNext)) row.qty90 = qty3(row.qty90 + qty);
      if (inRange(when, range30.from, range30.toNext)) {
        row.qty30 = qty3(row.qty30 + qty);
        row.events30 += 1;
      }
      if (inRange(when, range7.from, range7.toNext)) row.qty7 = qty3(row.qty7 + qty);
    }
  }

  for (const transfer of input.transfers) {
    const toCity = transfer.to_city_id;
    if (!toCity) continue;
    for (const item of transfer.stock_transfer_items || []) {
      const productId = item.product_id;
      if (!productId) continue;
      const remaining = inboundRemaining(transfer, item);
      if (!(remaining > 0)) continue;
      const row = ensure(productId, toCity);
      row.inbound = qty3(row.inbound + remaining);
    }
  }

  const paramsOk = forecastParamsReady(input.params);
  const targetBad = targetBelowLeadSafety(input.params);
  let recsBlocked: AdminForecastReport['recsBlockedReason'] = null;
  if (!input.complete) recsBlocked = 'truncated';
  else if (!paramsOk) recsBlocked = 'missing_params';
  else if (targetBad) recsBlocked = 'target_below_lead_safety';
  const recsAvailable = recsBlocked == null;
  const targetDays = recsAvailable ? (input.params.targetDays as number) : null;

  const cityRows: ForecastCityRow[] = [];
  for (const [k, row] of acc) {
    const [productId, cityId] = k.split('\0');
    const { recRate, spike, recRateWindow } = recRateOf(row.qty7, row.qty30, row.qty90);
    const available = qty3(Math.max(0, row.onHand - row.reserve));
    const analysisQty = input.window === 7 ? row.qty7 : input.window === 90 ? row.qty90 : row.qty30;
    const analysisRate = analysisQty / input.window;
    const negativeStock = row.onHand < 0;
    const daysCover = coverDays(available, recRate);
    const targetStock = targetDays != null ? qty3(recRate * targetDays) : null;
    const inbound = row.inbound;
    const cityDeficit =
      recsAvailable && targetStock != null ? qty3(Math.max(0, targetStock - available - inbound)) : null;
    const citySurplus = recsAvailable && targetStock != null ? qty3(Math.max(0, available - targetStock)) : null;
    cityRows.push({
      productId,
      name: row.name,
      unit: row.unit,
      isActive: row.isActive,
      cityId,
      cityName: cityNames.get(cityId) || cityId,
      qty7: row.qty7,
      qty30: row.qty30,
      qty90: row.qty90,
      rate7: row.qty7 / 7,
      rate30: row.qty30 / 30,
      rate90: row.qty90 / 90,
      analysisQty,
      analysisRate,
      recRate,
      recRateWindow,
      spike,
      onHand: row.onHand,
      reserve: row.reserve,
      available,
      inbound,
      negativeStock,
      daysCover,
      exhaustYmd: exhaustYmd(todayYmd, daysCover),
      targetStock,
      cityDeficit,
      citySurplus,
      confidence: confidenceOf({
        complete: input.complete,
        qty7: row.qty7,
        qty30: row.qty30,
        qty90: row.qty90,
        spike,
        negativeStock,
        saleEvents30: row.events30,
      }),
    });
  }

  cityRows.sort(
    (a, b) =>
      (b.cityDeficit || 0) - (a.cityDeficit || 0) ||
      a.name.localeCompare(b.name, 'ru') ||
      a.cityName.localeCompare(b.cityName, 'ru')
  );

  const byProduct = new Map<string, ForecastCityRow[]>();
  for (const row of cityRows) {
    const list = byProduct.get(row.productId) || [];
    list.push(row);
    byProduct.set(row.productId, list);
  }

  const products: ForecastProductSummary[] = [];
  const transfers: ForecastTransferIdea[] = [];

  for (const [productId, rows] of byProduct) {
    const first = rows[0];
    const available = qty3(rows.reduce((s, r) => s + r.available, 0));
    const inbound = qty3(rows.reduce((s, r) => s + r.inbound, 0));
    const onHand = qty3(rows.reduce((s, r) => s + r.onHand, 0));
    const reserve = qty3(rows.reduce((s, r) => s + r.reserve, 0));
    const recRate = qty3(rows.reduce((s, r) => s + r.recRate, 0));
    const targetStock = targetDays != null ? qty3(recRate * targetDays) : null;
    const companyStock = qty3(available + inbound);
    let purchaseQty: number | null = null;
    if (recsAvailable && targetStock != null && first.isActive) {
      purchaseQty = recommendQty(Math.max(0, targetStock - companyStock), first.unit);
    } else if (recsAvailable && targetStock != null) {
      purchaseQty = 0;
    }

    const deficitCities = rows.filter((r) => (r.cityDeficit || 0) > 0).length;
    const surplusCities = rows.filter((r) => (r.citySurplus || 0) > 0).length;

    if (recsAvailable && first.isActive) {
      const need = rows
        .filter((r) => (r.cityDeficit || 0) > 0)
        .map((r) => ({ row: r, left: r.cityDeficit || 0 }))
        .sort((a, b) => b.left - a.left);
      const give = rows
        .filter((r) => (r.citySurplus || 0) > 0)
        .map((r) => ({ row: r, left: r.citySurplus || 0 }))
        .sort((a, b) => b.left - a.left);
      for (const dest of need) {
        for (const src of give) {
          if (!(dest.left > 0) || !(src.left > 0)) continue;
          if (src.row.cityId === dest.row.cityId) continue;
          const raw = Math.min(src.left, dest.left);
          let qty = recommendQty(raw, first.unit);
          if (qty > src.left) qty = first.unit === 'kg' || first.unit === 'l' ? qty3(src.left) : Math.floor(src.left + 1e-9);
          if (!(qty > 0)) continue;
          if (qty3(src.row.available - qty) + 1e-9 < (src.row.targetStock || 0)) continue;
          src.left = qty3(src.left - qty);
          dest.left = qty3(dest.left - qty);
          const recvAvail = dest.row.available + dest.row.inbound + qty;
          transfers.push({
            productId,
            name: first.name,
            unit: first.unit,
            fromCityId: src.row.cityId,
            fromCityName: src.row.cityName,
            toCityId: dest.row.cityId,
            toCityName: dest.row.cityName,
            qty,
            senderAvailableAfter: qty3(src.row.available - qty),
            receiverCoverDaysAfter: coverDays(recvAvail, dest.row.recRate),
          });
        }
      }
    }

    products.push({
      productId,
      name: first.name,
      unit: first.unit,
      isActive: first.isActive,
      qty7: qty3(rows.reduce((s, r) => s + r.qty7, 0)),
      qty30: qty3(rows.reduce((s, r) => s + r.qty30, 0)),
      qty90: qty3(rows.reduce((s, r) => s + r.qty90, 0)),
      recRate,
      onHand,
      reserve,
      available,
      inbound,
      companyStock,
      targetStock,
      purchaseQty,
      deficitCities,
      surplusCities,
    });
  }

  products.sort((a, b) => (b.purchaseQty || 0) - (a.purchaseQty || 0) || a.name.localeCompare(b.name, 'ru'));

  const deficitProductCount = products.filter((p) => p.deficitCities > 0).length;
  const excessProductCount = products.filter((p) => p.surplusCities > 0 && p.deficitCities === 0).length;

  return {
    complete: input.complete,
    recsAvailable,
    recsBlockedReason: recsBlocked,
    todayYmd,
    window: input.window,
    cityRows,
    products,
    transfers,
    deficitProductCount,
    excessProductCount,
    purchaseProductCount: products.filter((p) => (p.purchaseQty || 0) > 0).length,
    transferCount: transfers.length,
    negativeStockCount: cityRows.filter((r) => r.negativeStock).length,
  };
}

export function filterForecastRows(
  rows: ForecastCityRow[],
  opts: { cityId: string | 'all'; productId: string | 'all'; problemsOnly: boolean }
): ForecastCityRow[] {
  return rows.filter((row) => {
    if (opts.cityId !== 'all' && row.cityId !== opts.cityId) return false;
    if (opts.productId !== 'all' && row.productId !== opts.productId) return false;
    if (opts.problemsOnly) {
      return (
        row.negativeStock ||
        (row.cityDeficit || 0) > 0 ||
        (row.citySurplus || 0) > 0 ||
        row.confidence === 'low'
      );
    }
    return true;
  });
}
