import { supabase } from '@/lib/supabaseClient';
import { isUnpaidDebt, type StatsOrder } from '@/lib/adminStats';

const PAGE = 1000;
const MAX = 20000;

export const ORDER_STATS_SELECT =
  'id, seller_id, total_sum, city_id, created_at, status, payment_type, is_preorder, preorder_status, fulfilled_at, is_debt, debt_status, debt_paid_at, debt_due_at, order_items(product_id, qty, price, line_sum, is_gift, product_name_snapshot, product:products(name, unit))';

export type FetchOrdersResult = {
  orders: StatsOrder[];
  truncated: boolean;
};

async function fetchPaged(
  apply: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
): Promise<{ rows: StatsOrder[]; truncated: boolean; error: string | null }> {
  const rows: StatsOrder[] = [];
  let from = 0;
  let truncated = false;
  while (from < MAX) {
    const to = from + PAGE - 1;
    const { data, error } = await apply(from, to);
    if (error) return { rows, truncated, error: error.message };
    const chunk = (data || []) as StatsOrder[];
    rows.push(...chunk);
    if (chunk.length < PAGE) return { rows, truncated, error: null };
    from += PAGE;
    if (from >= MAX) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated, error: null };
}

export async function fetchRecognizedWindow(range: {
  from: Date;
  toNext: Date;
}): Promise<FetchOrdersResult & { error: string | null }> {
  const fromISO = range.from.toISOString();
  const toNextISO = range.toNext.toISOString();

  const run = (column: 'created_at' | 'fulfilled_at' | 'debt_paid_at') =>
    fetchPaged((from, to) =>
      supabase
        .from('orders')
        .select(ORDER_STATS_SELECT)
        .gte(column, fromISO)
        .lt(column, toNextISO)
        .order('id', { ascending: true })
        .range(from, to)
    );

  const [created, fulfilled, debtPaid] = await Promise.all([
    run('created_at'),
    run('fulfilled_at'),
    run('debt_paid_at'),
  ]);
  const err = created.error || fulfilled.error || debtPaid.error;
  const seen = new Set<string>();
  const orders: StatsOrder[] = [];
  for (const row of [...created.rows, ...fulfilled.rows, ...debtPaid.rows]) {
    if (row.id) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
    }
    orders.push(row);
  }
  return {
    orders,
    truncated: created.truncated || fulfilled.truncated || debtPaid.truncated,
    error: err,
  };
}

export async function fetchUnpaidDebts(): Promise<FetchOrdersResult & { error: string | null }> {
  const fetched = await fetchPaged((from, to) =>
    supabase
      .from('orders')
      .select(ORDER_STATS_SELECT)
      .or('is_debt.eq.true,payment_type.eq.debt')
      .or('debt_status.eq.active,debt_status.is.null')
      .neq('status', 'canceled')
      .order('id', { ascending: true })
      .range(from, to)
  );
  if (fetched.error) return { orders: [], truncated: false, error: fetched.error };
  const seen = new Set<string>();
  const orders: StatsOrder[] = [];
  for (const row of fetched.rows) {
    if (row.id) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
    }
    if (!isUnpaidDebt(row)) continue;
    orders.push(row);
  }
  return { orders, truncated: fetched.truncated, error: null };
}
