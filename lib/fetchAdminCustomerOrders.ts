import { CUSTOMER_ORDER_SELECT, type CustomerOrder } from '@/lib/adminCustomers';
import { customerOrdersFetchStatus } from '@/lib/adminCustomersView';
import { ORDER_STATS_MAX, ORDER_STATS_PAGE } from '@/lib/fetchAdminStatsOrders';
import { supabase } from '@/lib/supabaseClient';

export { CUSTOMER_ORDER_SELECT };

export type FetchCustomerOrdersResult = {
  orders: CustomerOrder[];
  truncated: boolean;
  complete: boolean;
  loaded: number;
  total: number | null;
  error: string | null;
};

export async function fetchAllCustomerOrders(): Promise<FetchCustomerOrdersResult> {
  const countRes = await supabase.from('orders').select('id', { count: 'exact', head: true });
  if (countRes.error) {
    return {
      orders: [],
      truncated: false,
      complete: false,
      loaded: 0,
      total: null,
      error: countRes.error.message,
    };
  }
  const total = typeof countRes.count === 'number' ? countRes.count : null;

  const rows: CustomerOrder[] = [];
  let from = 0;
  let lastChunkLength = 0;
  while (from < ORDER_STATS_MAX) {
    const to = from + ORDER_STATS_PAGE - 1;
    const { data, error } = await supabase
      .from('orders')
      .select(CUSTOMER_ORDER_SELECT)
      .order('id', { ascending: true })
      .range(from, to);
    if (error) {
      return { orders: rows, truncated: true, complete: false, loaded: rows.length, total, error: error.message };
    }
    const chunk = (data || []) as CustomerOrder[];
    lastChunkLength = chunk.length;
    rows.push(...chunk);
    if (chunk.length < ORDER_STATS_PAGE) break;
    from += ORDER_STATS_PAGE;
    if (from >= ORDER_STATS_MAX) break;
  }

  const status = customerOrdersFetchStatus({
    loaded: rows.length,
    total,
    lastChunkLength,
    pageSize: ORDER_STATS_PAGE,
    max: ORDER_STATS_MAX,
  });
  return {
    orders: rows,
    truncated: status.truncated,
    complete: status.complete,
    loaded: rows.length,
    total,
    error: null,
  };
}
