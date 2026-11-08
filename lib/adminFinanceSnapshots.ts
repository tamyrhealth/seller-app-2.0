export const FINANCE_ITEM_SNAPSHOTS_RPC = 'admin_order_item_cost_snapshots' as const;
export const FINANCE_SNAPSHOT_BATCH = 20000;

type OrderWithItems = {
  order_items?: Array<{ id?: string | null }> | null;
};

export type OrderItemCostSnapshotRow = {
  id?: string | null;
  cost_price_snapshot?: number | string | null;
};

export function collectFinanceOrderItemIds(orders: OrderWithItems[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const order of orders || []) {
    for (const item of order.order_items || []) {
      const id = item.id ? String(item.id).trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
    }
  }
  return [...seen];
}

export function chunkIds(ids: string[], batchSize = FINANCE_SNAPSHOT_BATCH): string[][] {
  const size = Math.max(1, Math.min(batchSize, FINANCE_SNAPSHOT_BATCH));
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export function parseSnapshotNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === ('' as unknown)) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function parseOrderItemCostSnapshots(rows: OrderItemCostSnapshotRow[] | null | undefined): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const row of rows || []) {
    const id = row?.id ? String(row.id).trim() : '';
    if (!id) continue;
    map.set(id, parseSnapshotNumber(row.cost_price_snapshot));
  }
  return map;
}

export type SnapshotRpc = (
  ids: string[]
) => PromiseLike<{ data: OrderItemCostSnapshotRow[] | null; error: { message?: string } | null }>;

export type LoadItemSnapshotsResult = {
  map: Map<string, number | null>;
  error: string | null;
  batches: number;
};

export async function loadOrderItemCostSnapshots(
  ids: string[],
  rpc: SnapshotRpc
): Promise<LoadItemSnapshotsResult> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { map: new Map(), error: null, batches: 0 };
  const chunks = chunkIds(unique);
  const map = new Map<string, number | null>();
  for (const chunk of chunks) {
    const { data, error } = await rpc(chunk);
    if (error) {
      return { map: new Map(), error: error.message || 'snapshot_rpc', batches: chunks.length };
    }
    const part = parseOrderItemCostSnapshots(data);
    for (const [id, value] of part) map.set(id, value);
  }
  return { map, error: null, batches: chunks.length };
}

export type LineCostSource = 'historical' | 'estimated' | 'unknown';

export function resolveLineUnitCost(opts: {
  snapshot: number | null | undefined;
  catalog: number | null;
}): { unit: number | null; source: LineCostSource } {
  if (opts.snapshot != null && Number.isFinite(opts.snapshot) && opts.snapshot >= 0) {
    return { unit: opts.snapshot, source: 'historical' };
  }
  if (opts.catalog != null && Number.isFinite(opts.catalog) && opts.catalog >= 0) {
    return { unit: opts.catalog, source: 'estimated' };
  }
  return { unit: null, source: 'unknown' };
}

export function snapshotForItem(
  item: { id?: string | null },
  snapshots: Map<string, number | null> | null | undefined
): number | null {
  const id = item.id ? String(item.id).trim() : '';
  if (!id || !snapshots) return null;
  if (!snapshots.has(id)) return null;
  return snapshots.get(id) ?? null;
}
