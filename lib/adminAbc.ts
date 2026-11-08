import {
  buildAdminFinance,
  mergeFinanceOrders,
  type FinanceCogsQuality,
  type FinanceOrder,
  type FinanceProductRow,
} from '@/lib/adminFinance';
import { ordersForCityView } from '@/lib/adminFinanceView';
import type { ProductCostRow } from '@/lib/productCost';

export type AbcClass = 'A' | 'B' | 'C';
export type AbcMode = 'revenue' | 'profit';
export type AbcCatalogFilter = 'all' | 'active' | 'archived';

export type AbcProductRow = {
  productId: string;
  name: string;
  unit: string;
  isActive: boolean | null;
  qtySold: number;
  qtyGift: number;
  revenue: number;
  cogsKnown: number;
  costMissing: boolean;
  estimatedGrossProfit: number | null;
  share: number | null;
  cumShare: number | null;
  abcClass: AbcClass | null;
  rankTag: 'ranked' | 'zero_revenue' | 'zero_profit' | 'loss' | 'no_cost';
  displayExcluded: boolean;
};

export type AdminAbcReport = {
  complete: boolean;
  revenue: number;
  estimatedGrossProfit: number | null;
  cogsComplete: boolean;
  missingCostProductCount: number;
  cogsQuality: FinanceCogsQuality;
  cogsIsHistorical: boolean;
  profitAbcAvailable: boolean;
  profitAbcBlockedReason: 'truncated' | 'missing_cost' | 'non_positive_total' | null;
  countA: number;
  countB: number;
  countC: number;
  excludedDisplayCount: number;
  rows: AbcProductRow[];
};

const ABC_A = 0.8;
const ABC_B = 0.95;

function qtyMoved(row: Pick<FinanceProductRow, 'qtySold' | 'qtyGift'>): number {
  return (row.qtySold || 0) + (row.qtyGift || 0);
}

export function assignAbcClasses<T>(
  items: T[],
  metricOf: (item: T) => number,
  tieKey: (item: T) => string
): Array<{ item: T; share: number; cumShare: number; abcClass: AbcClass }> {
  const ranked = [...items]
    .filter((item) => metricOf(item) > 0)
    .sort((a, b) => metricOf(b) - metricOf(a) || tieKey(a).localeCompare(tieKey(b), 'ru'));
  const total = ranked.reduce((sum, item) => sum + metricOf(item), 0);
  const out: Array<{ item: T; share: number; cumShare: number; abcClass: AbcClass }> = [];
  if (!(total > 0)) return out;

  let i = 0;
  let running = 0;
  while (i < ranked.length) {
    const value = metricOf(ranked[i]);
    let j = i + 1;
    while (j < ranked.length && metricOf(ranked[j]) === value) j += 1;
    const prevRatio = running / total;
    const abcClass: AbcClass = prevRatio < ABC_A ? 'A' : prevRatio < ABC_B ? 'B' : 'C';
    for (let k = i; k < j; k += 1) {
      running += metricOf(ranked[k]);
      out.push({
        item: ranked[k],
        share: metricOf(ranked[k]) / total,
        cumShare: running / total,
        abcClass,
      });
    }
    i = j;
  }
  return out;
}

function tagRevenue(row: FinanceProductRow): AbcProductRow['rankTag'] {
  if (row.revenue > 0) return 'ranked';
  return 'zero_revenue';
}

function tagProfit(row: FinanceProductRow): AbcProductRow['rankTag'] {
  if (row.costMissing || row.estimatedGrossProfit == null) return 'no_cost';
  if (row.estimatedGrossProfit < 0) return 'loss';
  if (row.estimatedGrossProfit === 0) return 'zero_profit';
  return 'ranked';
}

export function buildAdminAbc(params: {
  orders: FinanceOrder[];
  costs: ProductCostRow[];
  range: { from: Date; toNext: Date };
  fromYmd: string;
  toYmd: string;
  cityId: string | 'all';
  catalog: Map<string, { isActive: boolean }>;
  catalogFilter: AbcCatalogFilter;
  mode: AbcMode;
  complete: boolean;
  itemSnapshots?: Map<string, number | null> | null;
  itemSnapshotsUnavailable?: boolean;
}): AdminAbcReport {
  const cityOrders = ordersForCityView(mergeFinanceOrders([params.orders]), params.cityId);
  const finance = buildAdminFinance({
    orders: cityOrders,
    range: params.range,
    fromYmd: params.fromYmd,
    toYmd: params.toYmd,
    costs: params.costs,
    expenses: [],
    cityNames: new Map(),
    expensesInputComplete: true,
    itemSnapshots: params.itemSnapshots,
    itemSnapshotsUnavailable: params.itemSnapshotsUnavailable,
  });

  const missingCostWithQty = finance.productRows.some((row) => qtyMoved(row) > 0 && row.costMissing);
  const profitTotal = finance.estimatedGrossProfit;
  let profitBlocked: AdminAbcReport['profitAbcBlockedReason'] = null;
  if (!params.complete) profitBlocked = 'truncated';
  else if (missingCostWithQty || !finance.cogsComplete) profitBlocked = 'missing_cost';
  else if (profitTotal == null || !(profitTotal > 0)) profitBlocked = 'non_positive_total';
  const profitAbcAvailable = profitBlocked == null;

  const ranked =
    params.mode === 'revenue'
      ? params.complete
        ? assignAbcClasses(
            finance.productRows.filter((row) => row.revenue > 0),
            (row) => row.revenue,
            (row) => `${row.name}\0${row.productId}`
          )
        : []
      : profitAbcAvailable
        ? assignAbcClasses(
            finance.productRows.filter((row) => (row.estimatedGrossProfit || 0) > 0),
            (row) => row.estimatedGrossProfit || 0,
            (row) => `${row.name}\0${row.productId}`
          )
        : [];

  const rankedMap = new Map(ranked.map((entry) => [entry.item.productId, entry]));

  const rows: AbcProductRow[] = finance.productRows.map((row) => {
    const isActive = params.catalog.has(row.productId) ? params.catalog.get(row.productId)!.isActive : null;
    const displayExcluded =
      params.catalogFilter === 'active'
        ? isActive === false
        : params.catalogFilter === 'archived'
          ? isActive !== false
          : false;
    const hit = rankedMap.get(row.productId);
    const rankTag = params.mode === 'revenue' ? tagRevenue(row) : tagProfit(row);
    return {
      productId: row.productId,
      name: row.name,
      unit: row.unit,
      isActive,
      qtySold: row.qtySold,
      qtyGift: row.qtyGift,
      revenue: row.revenue,
      cogsKnown: row.cogsKnown,
      costMissing: row.costMissing,
      estimatedGrossProfit: row.estimatedGrossProfit,
      share: hit ? hit.share : null,
      cumShare: hit ? hit.cumShare : null,
      abcClass: hit ? hit.abcClass : null,
      rankTag: hit ? 'ranked' : rankTag,
      displayExcluded,
    };
  });

  rows.sort((a, b) => {
    if (a.abcClass && b.abcClass) return (b.share || 0) - (a.share || 0) || a.name.localeCompare(b.name, 'ru');
    if (a.abcClass) return -1;
    if (b.abcClass) return 1;
    return a.name.localeCompare(b.name, 'ru');
  });

  return {
    complete: params.complete,
    revenue: finance.revenue,
    estimatedGrossProfit: finance.estimatedGrossProfit,
    cogsComplete: finance.cogsComplete,
    missingCostProductCount: finance.missingCostProductCount,
    cogsQuality: finance.cogsQuality,
    cogsIsHistorical: finance.cogsIsHistorical,
    profitAbcAvailable,
    profitAbcBlockedReason: profitBlocked,
    countA: params.complete ? rows.filter((row) => row.abcClass === 'A').length : 0,
    countB: params.complete ? rows.filter((row) => row.abcClass === 'B').length : 0,
    countC: params.complete ? rows.filter((row) => row.abcClass === 'C').length : 0,
    excludedDisplayCount: rows.filter((row) => row.displayExcluded).length,
    rows,
  };
}

export function visibleAbcRows(report: AdminAbcReport): AbcProductRow[] {
  return report.rows.filter((row) => !row.displayExcluded);
}

export function visibleClassCounts(report: AdminAbcReport): { a: number; b: number; c: number } {
  const rows = visibleAbcRows(report);
  return {
    a: rows.filter((row) => row.abcClass === 'A').length,
    b: rows.filter((row) => row.abcClass === 'B').length,
    c: rows.filter((row) => row.abcClass === 'C').length,
  };
}
