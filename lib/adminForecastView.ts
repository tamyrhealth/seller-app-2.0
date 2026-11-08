import {
  forecastRateWindowLabel,
  formatForecastQty,
  formatForecastRate,
  type ForecastConfidence,
  type ForecastOrder,
  type ForecastWindow,
} from '@/lib/adminForecast';
import { addDaysYmd, formatYmdDmy, getTodayLocalISO, getYmdSpanRangeInTz } from '@/lib/datetime';
import { ORDER_STATS_MAX, ORDER_STATS_PAGE, ORDER_STATS_SELECT } from '@/lib/fetchAdminStatsOrders';
import { supabase } from '@/lib/supabaseClient';

export { forecastRateWindowLabel, formatForecastQty, formatForecastRate };

export function formatForecastDays(days: number | null, complete: boolean): string {
  if (!complete || days == null || !Number.isFinite(days)) return '—';
  if (days > 999) return '999+';
  return days.toFixed(1);
}

export function formatForecastDate(ymd: string | null, complete: boolean): string {
  if (!complete || !ymd) return '—';
  return formatYmdDmy(ymd);
}

export function forecastConfidenceLabel(level: ForecastConfidence, t: (key: string) => string): string {
  if (level === 'high') return t('forecast.confHigh');
  if (level === 'medium') return t('forecast.confMedium');
  return t('forecast.confLow');
}

export function physicalDemandRange90(todayYmd = getTodayLocalISO('Asia/Almaty')) {
  const fromYmd = addDaysYmd(todayYmd, -89, 'Asia/Almaty');
  return { fromYmd, toYmd: todayYmd, range: getYmdSpanRangeInTz(fromYmd, todayYmd, 'Asia/Almaty') };
}

async function fetchPaged(
  apply: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
): Promise<{ rows: ForecastOrder[]; truncated: boolean; error: string | null }> {
  const rows: ForecastOrder[] = [];
  let from = 0;
  let truncated = false;
  while (from < ORDER_STATS_MAX) {
    const to = from + ORDER_STATS_PAGE - 1;
    const { data, error } = await apply(from, to);
    if (error) return { rows, truncated, error: error.message };
    const chunk = (data || []) as ForecastOrder[];
    rows.push(...chunk);
    if (chunk.length < ORDER_STATS_PAGE) return { rows, truncated, error: null };
    from += ORDER_STATS_PAGE;
    if (from >= ORDER_STATS_MAX) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated, error: null };
}

function mergeById(batches: ForecastOrder[][]): ForecastOrder[] {
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

/** Физический спрос: created_at + fulfilled_at. Без debt_paid_at. */
export async function fetchForecastOrders(range: { from: Date; toNext: Date }): Promise<{
  orders: ForecastOrder[];
  truncated: boolean;
  error: string | null;
}> {
  const fromISO = range.from.toISOString();
  const toNextISO = range.toNext.toISOString();
  const run = (column: 'created_at' | 'fulfilled_at') =>
    fetchPaged((from, to) =>
      supabase
        .from('orders')
        .select(ORDER_STATS_SELECT)
        .gte(column, fromISO)
        .lt(column, toNextISO)
        .order('id', { ascending: true })
        .range(from, to)
    );
  const pending = fetchPaged((from, to) =>
    supabase
      .from('orders')
      .select(ORDER_STATS_SELECT)
      .eq('is_preorder', true)
      .eq('preorder_status', 'pending')
      .neq('status', 'canceled')
      .order('id', { ascending: true })
      .range(from, to)
  );
  const [created, fulfilled, pendingRows] = await Promise.all([run('created_at'), run('fulfilled_at'), pending]);
  const err = created.error || fulfilled.error || pendingRows.error;
  return {
    orders: mergeById([created.rows, fulfilled.rows, pendingRows.rows]),
    truncated: created.truncated || fulfilled.truncated || pendingRows.truncated,
    error: err,
  };
}

export function analysisWindowLabel(window: ForecastWindow, t: (key: string) => string): string {
  if (window === 7) return t('forecast.window7');
  if (window === 90) return t('forecast.window90');
  return t('forecast.window30');
}
