export type OrderHistoryItem = {
  name: string;
  qty: number;
  price: number | null;
  line_sum: number | null;
  is_gift: boolean;
};

const ACTION_LABELS: Record<string, string> = {
  order_create: 'Создание заказа',
  preorder_create: 'Создание предзаказа',
  debt_create: 'Создание долга',
  preorder_fulfill: 'Выдача предзаказа',
  debt_pay: 'Оплата долга',
  order_cancel: 'Отмена заказа',
  order_cancel_already: 'Повторный запрос отмены — заказ уже отменён',
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Наличные',
  kaspi: 'Kaspi QR',
  card: 'Карта',
  transfer: 'Перевод',
  debt: 'В долг',
};

export function orderHistoryActionLabel(
  action: string | null | undefined,
  details?: Record<string, unknown> | null
): string {
  if (details?.already_canceled === true) {
    return ACTION_LABELS.order_cancel_already;
  }
  const key = String(action || '').trim();
  return ACTION_LABELS[key] || key || 'Действие';
}

export function orderHistoryPaymentLabel(value: string | null | undefined): string {
  const key = String(value || '').trim();
  if (!key) return '';
  return PAYMENT_LABELS[key] || key;
}

export function parseOrderHistoryItems(details: Record<string, unknown> | null | undefined): OrderHistoryItem[] {
  const raw = details?.items;
  if (!Array.isArray(raw)) return [];
  const items: OrderHistoryItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const name = String(rec.name || rec.product_name_snapshot || '').trim();
    const qty = Number(rec.qty);
    if (!name && !(qty > 0)) continue;
    items.push({
      name: name || 'Товар',
      qty: Number.isFinite(qty) ? qty : 0,
      price: rec.price == null ? null : Number(rec.price),
      line_sum: rec.line_sum == null ? null : Number(rec.line_sum),
      is_gift: rec.is_gift === true,
    });
  }
  return items;
}

export function orderHistoryActorLabel(userName: string | null | undefined, userRole: string | null | undefined): string {
  const name = String(userName || '').trim();
  const role = String(userRole || '').trim();
  const roleLabel =
    role === 'admin' ? 'админ' : role === 'manager' ? 'менеджер' : role === 'seller' ? 'продавец' : role;
  if (name && roleLabel) return `${name} (${roleLabel})`;
  if (name) return name;
  if (roleLabel) return roleLabel;
  return 'Неизвестный автор';
}
