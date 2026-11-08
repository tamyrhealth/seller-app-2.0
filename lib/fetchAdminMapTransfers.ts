import {
  MAP_TRANSFER_MAX,
  MAP_TRANSFER_PAGE,
  type MapTransferInput,
} from '@/lib/adminMapTransfers';
import { supabase } from '@/lib/supabaseClient';

export const MAP_TRANSFER_SELECT =
  'id, transfer_number, from_city_id, to_city_id, status, created_at, stock_transfer_items(product_id, qty_sent, qty_received, qty_lost, qty_returned)';

export async function fetchInTransitMapTransfers(): Promise<{
  rows: MapTransferInput[];
  truncated: boolean;
  error: string | null;
}> {
  const rows: MapTransferInput[] = [];
  let from = 0;
  let truncated = false;
  while (from < MAP_TRANSFER_MAX) {
    const to = from + MAP_TRANSFER_PAGE - 1;
    const { data, error } = await supabase
      .from('stock_transfers')
      .select(MAP_TRANSFER_SELECT)
      .eq('status', 'in_transit')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to);
    if (error) return { rows, truncated, error: error.message };
    const chunk = (data || []) as MapTransferInput[];
    rows.push(...chunk);
    if (chunk.length < MAP_TRANSFER_PAGE) return { rows, truncated, error: null };
    from += MAP_TRANSFER_PAGE;
    if (from >= MAP_TRANSFER_MAX) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated, error: null };
}
