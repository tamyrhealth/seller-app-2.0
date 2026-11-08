import type { AbcProductRow, AdminAbcReport } from '@/lib/adminAbc';
import { formatCustomerKpi, resolveCustomerRange, type CustomerPeriodMode } from '@/lib/adminCustomersView';

export type AbcPeriodMode = CustomerPeriodMode;
export type AbcSortKey = 'share' | 'revenue' | 'profit' | 'qty' | 'name';

export { formatCustomerKpi as formatAbcKpi, lastMonthRangeYmd, yearRangeYmd } from '@/lib/adminCustomersView';

export function resolveAbcRange(opts: {
  mode: AbcPeriodMode;
  year: number;
  month: number;
  customFrom: string;
  customTo: string;
  todayYmd: string;
}) {
  return resolveCustomerRange(opts);
}

export function formatAbcPct(value: number | null, complete: boolean): string {
  if (!complete || value == null || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function visibleAbcTableRows(report: AdminAbcReport): AbcProductRow[] {
  return report.rows.filter((row) => !row.displayExcluded);
}

export function sortAbcRows(rows: AbcProductRow[], key: AbcSortKey): AbcProductRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (key === 'name') return a.name.localeCompare(b.name, 'ru') || a.productId.localeCompare(b.productId);
    if (key === 'revenue') return b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru');
    if (key === 'profit') {
      const pa = a.estimatedGrossProfit;
      const pb = b.estimatedGrossProfit;
      if (pa == null && pb == null) return a.name.localeCompare(b.name, 'ru');
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pb - pa || a.name.localeCompare(b.name, 'ru');
    }
    if (key === 'qty') return b.qtySold + b.qtyGift - (a.qtySold + a.qtyGift) || a.name.localeCompare(b.name, 'ru');
    const sa = a.share;
    const sb = b.share;
    if (sa == null && sb == null) return a.name.localeCompare(b.name, 'ru');
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sb - sa || a.name.localeCompare(b.name, 'ru');
  });
  return copy;
}

export function paretoPoints(rows: AbcProductRow[]): Array<{
  name: string;
  sharePct: number;
  cumPct: number;
  abcClass: string;
}> {
  return rows
    .filter((row) => row.abcClass && row.share != null && row.cumShare != null && !row.displayExcluded)
    .sort((a, b) => (a.cumShare || 0) - (b.cumShare || 0) || a.name.localeCompare(b.name, 'ru'))
    .map((row) => ({
      name: row.name,
      sharePct: Math.round((row.share || 0) * 1000) / 10,
      cumPct: Math.round((row.cumShare || 0) * 1000) / 10,
      abcClass: row.abcClass as string,
    }));
}
