import type { SellerProductRow, SellerStatRow } from '@/lib/adminStats';

export const STATS_SELLER_EARNINGS_RPC = 'admin_stats_seller_earnings' as const;

export type StatsEarningsStatus = 'skipped' | 'connected' | 'missing' | 'error';

export type SellerEarningsItem = {
  sellerId: string;
  orderItemId: string | null;
  productId: string | null;
  accrued: number;
  reversed: number;
  missingRate: boolean;
};

export type SellerPeriodEarnings = {
  sellerId: string;
  accrued: number;
  reversed: number;
  earned: number;
  missingRateCount: number;
  items: SellerEarningsItem[];
};

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function int(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function statsEarningsRpcMissing(message: string | null | undefined): boolean {
  const m = (message || '').toLowerCase();
  if (!m) return false;
  if (m.includes('pgrst202') || m.includes('could not find the function')) return true;
  return m.includes('does not exist') && m.includes('admin_stats_seller_earnings');
}

export function parseSellerBalances(payload: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!payload || typeof payload !== 'object') return out;
  const items = (payload as { items?: unknown }).items;
  const list = Array.isArray(items) ? items : Array.isArray(payload) ? payload : [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.seller_id === 'string' ? r.seller_id : '';
    if (!id) continue;
    out.set(id, num(r.balance));
  }
  return out;
}

export function parseSellerEarnings(payload: unknown): Map<string, SellerPeriodEarnings> {
  const out = new Map<string, SellerPeriodEarnings>();
  if (!payload || typeof payload !== 'object') return out;
  const root = payload as Record<string, unknown>;
  const sellersRaw = Array.isArray(root.sellers) ? root.sellers : [];
  for (const row of sellersRaw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const sellerId = typeof r.seller_id === 'string' ? r.seller_id : '';
    if (!sellerId) continue;
    const itemsRaw = Array.isArray(r.items) ? r.items : [];
    const items: SellerEarningsItem[] = [];
    for (const it of itemsRaw) {
      if (!it || typeof it !== 'object') continue;
      const x = it as Record<string, unknown>;
      items.push({
        sellerId,
        orderItemId: typeof x.order_item_id === 'string' ? x.order_item_id : null,
        productId: typeof x.product_id === 'string' ? x.product_id : null,
        accrued: num(x.accrued),
        reversed: num(x.reversed),
        missingRate: x.missing_rate === true,
      });
    }
    out.set(sellerId, {
      sellerId,
      accrued: num(r.accrued),
      reversed: num(r.reversed),
      earned: num(r.earned),
      missingRateCount: int(r.missing_rate_count),
      items,
    });
  }
  return out;
}

export type RankedSellerProduct = SellerProductRow & {
  commission: number | null;
  commissionKnown: boolean;
};

export type RankedSeller = {
  place: number;
  key: string;
  sellerId: string | null;
  name: string;
  revenue: number;
  orderCount: number;
  unitsSold: number;
  qtyByUnit: SellerStatRow['qtyByUnit'];
  earned: number | null;
  earnedKnown: boolean;
  payable: number | null;
  incomplete: boolean;
  missingRate: boolean;
  products: RankedSellerProduct[];
};

export function commissionScopeAllowed(cityId: string | 'all', productId: string | 'all'): boolean {
  return cityId === 'all' && productId === 'all';
}

/** Attach ledger rows only by unique order_item_id. Never split by product_id. */
export function allocateProductCommissions(
  products: SellerProductRow[],
  items: SellerEarningsItem[],
  connected: boolean
): { products: RankedSellerProduct[]; ambiguous: boolean } {
  const owners = new Map<string, number[]>();
  products.forEach((p, index) => {
    for (const id of p.saleItemIds) {
      const list = owners.get(id) || [];
      list.push(index);
      owners.set(id, list);
    }
  });

  const assigned: SellerEarningsItem[][] = products.map(() => []);
  let ambiguous = false;
  for (const it of items) {
    if (!it.orderItemId) {
      if (it.accrued || it.reversed || it.missingRate) ambiguous = true;
      continue;
    }
    const idxs = owners.get(it.orderItemId) || [];
    if (idxs.length === 0) continue;
    if (idxs.length > 1) {
      ambiguous = true;
      continue;
    }
    assigned[idxs[0]].push(it);
  }

  return {
    ambiguous,
    products: products.map((p, index) => {
      const pItems = assigned[index];
      const pMissing = pItems.some((it) => it.missingRate);
      const ids = [...new Set(p.saleItemIds)];
      const matchedIds = new Set(pItems.map((it) => it.orderItemId).filter((id): id is string => Boolean(id)));
      const allMatched = ids.length > 0 && ids.every((id) => matchedIds.has(id));
      const pKnown = connected && !pMissing && !ambiguous && allMatched;
      const pEarned = pItems.reduce((s, it) => s + it.accrued - it.reversed, 0);
      return {
        ...p,
        commission: pKnown ? Number(pEarned.toFixed(2)) : null,
        commissionKnown: pKnown,
      };
    }),
  };
}

export function buildSellerRanking(params: {
  sellers: SellerStatRow[];
  earnings: Map<string, SellerPeriodEarnings> | null;
  balances: Map<string, number> | null;
  commissionAllowed: boolean;
  earningsStatus: StatsEarningsStatus;
  limit?: number;
}): RankedSeller[] {
  const limit = params.limit ?? 5;
  const sorted = [...params.sellers].sort(
    (a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru')
  );
  return sorted.slice(0, limit).map((seller, index) => {
    const period = seller.sellerId ? params.earnings?.get(seller.sellerId) : undefined;
    const missingRate = (period?.missingRateCount ?? 0) > 0;
    const connected = params.commissionAllowed && params.earningsStatus === 'connected';
    const itemSet = new Set(
      (period?.items || []).map((it) => it.orderItemId).filter((id): id is string => Boolean(id))
    );
    const unmatchedSales = connected && seller.saleItemIds.some((id) => !itemSet.has(id));
    const allocated = allocateProductCommissions(
      seller.products,
      period?.items || [],
      connected && !missingRate
    );
    const incomplete = connected && (missingRate || unmatchedSales || allocated.ambiguous);
    const earnedKnown = connected && !missingRate;
    const earned = earnedKnown ? period?.earned ?? 0 : null;
    return {
      place: index + 1,
      key: seller.key,
      sellerId: seller.sellerId,
      name: seller.name,
      revenue: seller.revenue,
      orderCount: seller.orderCount,
      unitsSold: seller.unitsSold,
      qtyByUnit: seller.qtyByUnit,
      earned,
      earnedKnown,
      payable:
        params.commissionAllowed && seller.sellerId && params.balances?.has(seller.sellerId)
          ? params.balances.get(seller.sellerId) ?? null
          : null,
      incomplete,
      missingRate,
      products: allocated.products,
    };
  });
}
