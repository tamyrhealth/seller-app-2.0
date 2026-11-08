import { getYmdSpanRangeInTz } from '@/lib/datetime';
import { parseOrderNumberQuery } from '@/lib/orderNumber';
import type { OrderHistoryItem } from '@/lib/orderActionHistory';
import { parseOrderHistoryItems } from '@/lib/orderActionHistory';

export const ACTIVITY_PAGE_SIZE = 50;

export const ACTIVITY_ACTION_VALUES = [
  'order_create',
  'preorder_create',
  'debt_create',
  'preorder_fulfill',
  'debt_pay',
  'order_cancel',
] as const;

export type ActivityActionValue = (typeof ACTIVITY_ACTION_VALUES)[number];

export type ActivityLogRow = {
  id: string;
  created_at: string;
  action: string | null;
  user_id: string | null;
  user_name: string | null;
  user_role: string | null;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
};

export type ActivityFilters = {
  fromYmd: string;
  toYmd: string;
  userId: string;
  action: string;
  numberSearch: string;
  page: number;
};

type FilterQuery = {
  eq: (column: string, value: unknown) => FilterQuery;
  gte: (column: string, value: string) => FilterQuery;
  lt: (column: string, value: string) => FilterQuery;
};

export function isActivityDateRangeInvalid(fromYmd: string, toYmd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(toYmd)) return true;
  return fromYmd > toYmd;
}

export function activityPageRange(page: number, pageSize = ACTIVITY_PAGE_SIZE): { from: number; to: number; page: number } {
  const safe = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const from = (safe - 1) * pageSize;
  return { from, to: from + pageSize - 1, page: safe };
}

export function activityOrderHref(entityId: string | null | undefined): string | null {
  const id = String(entityId || '').trim();
  if (!id) return null;
  return `/admin/orders?id=${encodeURIComponent(id)}`;
}

export function readOrderIdFromSearch(search: string): string | null {
  const raw = search.startsWith('?') ? search : `?${search}`;
  const id = new URLSearchParams(raw).get('id');
  const trimmed = String(id || '').trim();
  return trimmed || null;
}

export function activityOrderNumber(details: Record<string, unknown> | null | undefined): string | null {
  const raw = details?.order_number;
  if (typeof raw !== 'string') return null;
  const n = raw.trim();
  return n || null;
}

export function activityTotalSum(details: Record<string, unknown> | null | undefined): number | null {
  if (details == null || details.total_sum == null || details.total_sum === '') return null;
  const n = Number(details.total_sum);
  return Number.isFinite(n) ? n : null;
}

const CREATE_ACTIONS = new Set(['order_create', 'preorder_create', 'debt_create']);

function hasLoggedItemSnapshot(details: Record<string, unknown> | null | undefined): boolean {
  return Array.isArray(details?.items);
}

/** Old INSERT trigger stored total_sum=0 before confirm_order and had no items snapshot. */
export function activitySumDisplay(
  action: string | null | undefined,
  details: Record<string, unknown> | null | undefined
): { kind: 'unrecorded' } | { kind: 'hidden' } | { kind: 'value'; value: number } {
  const sum = activityTotalSum(details);
  const create = CREATE_ACTIONS.has(String(action || ''));
  if (create && !hasLoggedItemSnapshot(details) && (sum === null || sum === 0)) {
    return { kind: 'unrecorded' };
  }
  if (sum === null) return { kind: 'hidden' };
  return { kind: 'value', value: sum };
}

export function activityCancelReturnedStock(details: Record<string, unknown> | null | undefined): boolean | null {
  if (!details || details.already_canceled === true) return null;
  if (details.returned_stock === true) return true;
  if (details.returned_stock === false) return false;
  return null;
}

export function activityItems(details: Record<string, unknown> | null | undefined): OrderHistoryItem[] {
  return parseOrderHistoryItems(details);
}

export function applyActivityLogFilters<Q extends FilterQuery>(
  query: Q,
  opts: {
    fromISO: string;
    toNextISO: string;
    userId?: string;
    action?: string;
    entityId?: string;
  }
): Q {
  let q: FilterQuery = query.eq('entity_type', 'order');
  q = q.gte('created_at', opts.fromISO).lt('created_at', opts.toNextISO);
  if (opts.userId) q = q.eq('user_id', opts.userId);
  if (opts.action) q = q.eq('action', opts.action);
  if (opts.entityId) q = q.eq('entity_id', opts.entityId);
  return q as Q;
}

export function unrecordedOrderIds(rows: ActivityLogRow[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (activitySumDisplay(row.action, row.details).kind !== 'unrecorded') continue;
    const id = String(row.entity_id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export type ActivitySupabase = {
  from: (table: string) => {
    select: (columns: string, opts?: { count?: 'exact' }) => unknown;
  };
};

export async function fetchCurrentOrderSums(
  client: ActivitySupabase,
  ids: string[]
): Promise<{ sums: Map<string, number>; error: string | null }> {
  const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (unique.length === 0) return { sums: new Map(), error: null };
  const { data, error } = (await (
    client.from('orders').select('id, total_sum') as {
      in: (
        column: string,
        values: string[]
      ) => Promise<{ data: { id: string; total_sum: unknown }[] | null; error: { message: string } | null }>;
    }
  ).in('id', unique)) as {
    data: { id: string; total_sum: unknown }[] | null;
    error: { message: string } | null;
  };
  if (error) return { sums: new Map(), error: error.message };
  const sums = new Map<string, number>();
  for (const row of data || []) {
    const n = Number(row.total_sum);
    if (row.id && Number.isFinite(n)) sums.set(String(row.id), n);
  }
  return { sums, error: null };
}

export async function fetchAdminOrderActivity(
  client: ActivitySupabase,
  filters: ActivityFilters
): Promise<{ rows: ActivityLogRow[]; total: number; error: string | null; page: number }> {
  const pageRange = activityPageRange(filters.page);
  if (isActivityDateRangeInvalid(filters.fromYmd, filters.toYmd)) {
    return { rows: [], total: 0, error: 'date_range_invalid', page: pageRange.page };
  }

  const trimmedSearch = filters.numberSearch.trim();
  const numberQ = parseOrderNumberQuery(trimmedSearch);
  if (trimmedSearch && !numberQ) {
    return { rows: [], total: 0, error: null, page: 1 };
  }

  const span = getYmdSpanRangeInTz(filters.fromYmd, filters.toYmd);
  const fromISO = span.from.toISOString();
  const toNextISO = span.toNext.toISOString();

  let entityId: string | undefined;
  if (numberQ) {
    const { data: orders, error: orderError } = (await (
      client.from('orders').select('id') as {
        eq: (c: string, v: string) => {
          limit: (n: number) => Promise<{ data: { id: string }[] | null; error: { message: string } | null }>;
        };
      }
    )
      .eq('order_number', numberQ)
      .limit(1)) as { data: { id: string }[] | null; error: { message: string } | null };
    if (orderError) {
      return { rows: [], total: 0, error: orderError.message, page: pageRange.page };
    }
    const foundId = orders?.[0]?.id;
    if (!foundId) {
      return { rows: [], total: 0, error: null, page: 1 };
    }
    entityId = String(foundId);
  }

  const selectQuery = client.from('action_logs').select(
    'id, created_at, action, user_id, user_name, user_role, entity_type, entity_id, details',
    { count: 'exact' }
  ) as FilterQuery & {
    order: (column: string, opts: { ascending: boolean }) => {
      range: (
        from: number,
        to: number
      ) => Promise<{
        data: ActivityLogRow[] | null;
        error: { message: string } | null;
        count: number | null;
      }>;
    };
  };

  const filtered = applyActivityLogFilters(selectQuery, {
    fromISO,
    toNextISO,
    userId: filters.userId.trim() || undefined,
    action: filters.action.trim() || undefined,
    entityId,
  });
  const { data, error, count } = await filtered.order('created_at', { ascending: false }).range(pageRange.from, pageRange.to);

  if (error) {
    return { rows: [], total: 0, error: error.message, page: pageRange.page };
  }

  return {
    rows: (data || []) as ActivityLogRow[],
    total: count ?? 0,
    error: null,
    page: pageRange.page,
  };
}
