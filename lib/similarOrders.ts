import { normalizeCustomerPhone as normalizeReliableCustomerPhone } from './customerPhone';

export const SIMILAR_ORDER_WINDOW_SECONDS = 900;
export const SIMILAR_SQL_HINT = 'Сначала примените SQL этапа 5.4.1. Поиск похожих заказов недоступен — подтверждение остановлено.';

export type SimilarOrderItem = {
  product_id: string;
  qty: number;
  is_gift?: boolean;
};

export type SimilarOrderMatch = {
  order_id: string;
  order_number: string | null;
  created_at: string | null;
  status: string | null;
};

export type SimilarOrdersResult = {
  checked_at: string | null;
  window_seconds: number;
  identity_kind: 'phone' | 'anonymous';
  matches: SimilarOrderMatch[];
};

export type SimilarAck = {
  composition: string;
  matchIds: string[];
};

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeCustomerPhone(raw: string | null | undefined): string | null {
  return normalizeReliableCustomerPhone(raw);
}

export function buildSimilarItemBag(items: SimilarOrderItem[]): Array<{ product_id: string; qty: number; is_gift: boolean }> {
  const map = new Map<string, { product_id: string; qty: number; is_gift: boolean }>();
  for (const item of items) {
    const product_id = String(item.product_id || '');
    const qty = Number(Number(item.qty || 0).toFixed(3));
    if (!product_id || !(qty > 0)) continue;
    const is_gift = item.is_gift === true;
    const key = `${product_id}:${is_gift ? 1 : 0}`;
    const prev = map.get(key);
    if (prev) prev.qty = Number((prev.qty + qty).toFixed(3));
    else map.set(key, { product_id, qty, is_gift });
  }
  return [...map.values()].sort(
    (a, b) => a.product_id.localeCompare(b.product_id) || Number(a.is_gift) - Number(b.is_gift)
  );
}

export function similarCompositionKey(input: {
  sellerId: string;
  cityId: string;
  customerPhone: string | null | undefined;
  items: SimilarOrderItem[];
}): string {
  return JSON.stringify({
    seller_id: input.sellerId,
    city_id: input.cityId,
    phone: normalizeCustomerPhone(input.customerPhone),
    items: buildSimilarItemBag(input.items),
  });
}

export function similarMatchIds(matches: SimilarOrderMatch[]): string[] {
  return [...new Set(matches.map((m) => m.order_id).filter(Boolean))].sort();
}

export function similarMatchesAcknowledged(ack: SimilarAck | null, composition: string, matches: SimilarOrderMatch[]): boolean {
  if (!ack || ack.composition !== composition) return false;
  const current = similarMatchIds(matches);
  if (current.length === 0) return true;
  const known = new Set(ack.matchIds);
  return current.every((id) => known.has(id));
}

export function parseSimilarOrdersResult(data: unknown): SimilarOrdersResult {
  const row = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const rawMatches = Array.isArray(row.matches) ? row.matches : [];
  const matches: SimilarOrderMatch[] = [];
  for (const item of rawMatches) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const order_id = String(rec.order_id || '');
    if (!UUID_RE.test(order_id)) continue;
    matches.push({
      order_id,
      order_number: rec.order_number == null ? null : String(rec.order_number),
      created_at: rec.created_at == null ? null : String(rec.created_at),
      status: rec.status == null ? null : String(rec.status),
    });
  }
  return {
    checked_at: row.checked_at == null ? null : String(row.checked_at),
    window_seconds: Number(row.window_seconds || SIMILAR_ORDER_WINDOW_SECONDS),
    identity_kind: row.identity_kind === 'phone' ? 'phone' : 'anonymous',
    matches,
  };
}

export function formatSimilarLookupError(message: string | null | undefined): string {
  const text = String(message || '').trim();
  if (!text) return 'Не удалось проверить похожие заказы. Подтверждение остановлено.';
  if (
    /find_similar_orders/i.test(text) ||
    /schema cache/i.test(text) ||
    /could not find the function/i.test(text) ||
    /function .* does not exist/i.test(text)
  ) {
    return SIMILAR_SQL_HINT;
  }
  if (/Not authenticated/i.test(text)) return 'Нужна авторизация.';
  if (/Account is inactive/i.test(text)) return 'Профиль недоступен.';
  if (/Similar-order lookup permission denied|Invalid role/i.test(text)) {
    return 'Нет права искать похожие заказы.';
  }
  if (/Seller not found|Seller has no city/i.test(text)) return 'Продавец или город недоступны для проверки.';
  if (/Invalid similar-order payload/i.test(text)) return 'Некорректные данные для поиска похожих заказов.';
  return `Проверка похожих заказов не удалась: ${text}`;
}

export function similarOrderOpenHref(role: string | null | undefined, orderId: string): string {
  if (role === 'seller') return `/seller/orders?id=${orderId}`;
  if (role === 'manager') return `/manager/orders?id=${orderId}`;
  return `/admin/orders?id=${orderId}`;
}

export function displaySimilarOrderNumber(match: SimilarOrderMatch): string {
  const n = (match.order_number || '').trim();
  return n || match.order_id.slice(0, 8);
}

export async function lookupSimilarOrders(
  client: RpcClient,
  input: {
    sellerId: string;
    cityId: string;
    items: SimilarOrderItem[];
    customerPhone?: string | null;
    excludeIdempotencyKey?: string | null;
  }
): Promise<{ ok: true; result: SimilarOrdersResult } | { ok: false; error: string }> {
  const bag = buildSimilarItemBag(input.items);
  if (!input.sellerId || !input.cityId || bag.length === 0) {
    return { ok: false, error: 'Некорректные данные для поиска похожих заказов.' };
  }
  const { data, error } = await client.rpc('find_similar_orders', {
    p: {
      seller_id: input.sellerId,
      city_id: input.cityId,
      items: bag,
      customer_phone: input.customerPhone ?? null,
      exclude_idempotency_key: input.excludeIdempotencyKey ?? null,
    },
  });
  if (error) return { ok: false, error: formatSimilarLookupError(error.message) };
  return { ok: true, result: parseSimilarOrdersResult(data) };
}
