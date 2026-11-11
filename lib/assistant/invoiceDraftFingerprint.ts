import { nameKey } from '@/lib/assistant/nameFold';
import { normalizeCustomerPhone } from '@/lib/customerPhone';
import type { DraftResolved } from '@/lib/assistant/orderDraftTypes';

const OPEN_STATUSES = new Set(['preview', 'blocked', 'confirming']);

export type InvoiceDraftReuseRow = {
  id: string;
  idempotency_key: string;
  status: string;
  order_id?: string | null;
  order_number?: string | null;
  resolved?: DraftResolved | null;
  customer_phone?: string | null;
  created_at?: string | null;
};

function resolvedForFingerprint(row: InvoiceDraftReuseRow): DraftResolved | null {
  if (!row.resolved) return null;
  if (row.resolved.customer_phone || !row.customer_phone) return row.resolved;
  return { ...row.resolved, customer_phone: row.customer_phone };
}

export type InvoiceDraftReuseHit = {
  kind: 'open' | 'confirmed';
  row: InvoiceDraftReuseRow;
};

function itemToken(item: DraftResolved['items'][number]) {
  const productId = String(item.product_id || '');
  return {
    product_id: productId,
    raw: productId ? '' : nameKey(item.raw_name || item.product_name || ''),
    qty: Number(Number(item.qty || 0).toFixed(3)),
    is_gift: item.is_gift === true,
  };
}

/** Normalized invoice identity. Line order is kept; names collapse via product_id / nameKey. */
export function buildInvoiceDraftFingerprint(resolved: DraftResolved | null | undefined): string {
  if (!resolved) return '';
  const phone = normalizeCustomerPhone(resolved.customer_phone);
  return JSON.stringify({
    seller_id: resolved.seller_id || '',
    city_id: resolved.city_id || '',
    phone,
    customer_name: nameKey(resolved.customer_name || resolved.debt_customer_name || ''),
    payment_type: resolved.payment_type || '',
    is_debt: resolved.is_debt === true,
    is_preorder: resolved.is_preorder === true,
    items: (resolved.items || []).map(itemToken),
  });
}

export function findReusableInvoiceDraft(
  rows: InvoiceDraftReuseRow[],
  fingerprint: string,
  opts?: { forceNew?: boolean }
): InvoiceDraftReuseHit | null {
  if (opts?.forceNew || !fingerprint) return null;
  const matches = [...rows]
    .filter((row) => row.status !== 'cancelled')
    .filter((row) => buildInvoiceDraftFingerprint(resolvedForFingerprint(row) || undefined) === fingerprint)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const open = matches.find((row) => OPEN_STATUSES.has(row.status) && row.idempotency_key);
  if (open) return { kind: 'open', row: open };
  const confirmed = matches.find((row) => row.status === 'confirmed' && row.order_id);
  if (confirmed) return { kind: 'confirmed', row: confirmed };
  return null;
}

export function invoiceReuseChatMessage(hit: InvoiceDraftReuseHit): string {
  if (hit.kind === 'open') {
    return 'Эта накладная уже открыта в карточке. Подтвердите её или нажмите «Это новый заказ», если это другая продажа.';
  }
  const number = hit.row.order_number || String(hit.row.order_id || '').slice(0, 8);
  return `Этот заказ уже создан: ${number}. Повторно не подтверждаю. Если это другая продажа — нажмите «Это новый заказ».`;
}
