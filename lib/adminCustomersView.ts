import { monthRangeYmd } from '@/lib/adminFinanceView';
import { getYmdSpanRangeInTz } from '@/lib/datetime';

export type CustomerPeriodMode = 'thisMonth' | 'lastMonth' | 'year' | 'custom';

export function customerOrdersFetchStatus(opts: {
  loaded: number;
  total: number | null;
  lastChunkLength: number;
  pageSize: number;
  max: number;
}): { truncated: boolean; complete: boolean } {
  const { loaded, total, lastChunkLength, pageSize, max } = opts;
  if (total != null) {
    const complete = loaded >= total;
    return { complete, truncated: !complete };
  }
  const maybeMore = loaded >= max && lastChunkLength >= pageSize;
  return { complete: !maybeMore, truncated: maybeMore };
}

export function yearRangeYmd(year: number): { fromYmd: string; toYmd: string } {
  const y = Math.trunc(year);
  return { fromYmd: `${y}-01-01`, toYmd: `${y}-12-31` };
}

export function lastMonthRangeYmd(todayYmd: string): { fromYmd: string; toYmd: string } {
  const year = Number(todayYmd.slice(0, 4));
  const month = Number(todayYmd.slice(5, 7));
  if (month <= 1) return monthRangeYmd(year - 1, 12);
  return monthRangeYmd(year, month - 1);
}

export function resolveCustomerRange(opts: {
  mode: CustomerPeriodMode;
  year: number;
  month: number;
  customFrom: string;
  customTo: string;
  todayYmd: string;
}): { fromYmd: string; toYmd: string; range: { from: Date; toNext: Date } } | null {
  let fromYmd: string;
  let toYmd: string;
  if (opts.mode === 'thisMonth') {
    const span = monthRangeYmd(Number(opts.todayYmd.slice(0, 4)), Number(opts.todayYmd.slice(5, 7)));
    fromYmd = span.fromYmd;
    toYmd = span.toYmd;
  } else if (opts.mode === 'lastMonth') {
    const span = lastMonthRangeYmd(opts.todayYmd);
    fromYmd = span.fromYmd;
    toYmd = span.toYmd;
  } else if (opts.mode === 'year') {
    const span = yearRangeYmd(opts.year);
    fromYmd = span.fromYmd;
    toYmd = span.toYmd;
  } else {
    fromYmd = opts.customFrom;
    toYmd = opts.customTo;
  }
  if (!fromYmd || !toYmd || fromYmd > toYmd) return null;
  return { fromYmd, toYmd, range: getYmdSpanRangeInTz(fromYmd, toYmd, 'Asia/Almaty') };
}

export function formatCustomerKpi(value: number | null, complete: boolean, suffix = ''): string {
  if (!complete || value == null || Number.isNaN(value)) return '—';
  const text = new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(value);
  return suffix ? `${text}${suffix}` : text;
}
