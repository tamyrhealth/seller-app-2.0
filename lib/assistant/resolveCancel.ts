import type { SupabaseClient } from '@supabase/supabase-js';
import { paymentLabel } from '@/lib/assistant/paymentParse';
import type { PaymentType } from '@/lib/types';
import type { CancelPreview } from '@/lib/assistant/cancelTypes';
import { parseOrderNumberQuery } from '@/lib/orderNumber';

function isCanceled(status: string | null | undefined, preorderStatus: string | null | undefined): boolean {
  const s = (status || '').toLowerCase();
  return s === 'canceled' || s === 'cancelled' || preorderStatus === 'cancelled';
}

export function actorCanCancel(role: string | null | undefined, canCancelOrders: boolean): {
  allowed: boolean;
  code: string;
  message: string;
} {
  if (role === 'admin') return { allowed: true, code: 'ok', message: '' };
  if (role === 'manager') {
    if (canCancelOrders) return { allowed: true, code: 'ok', message: '' };
    return {
      allowed: false,
      code: 'cancel_forbidden',
      message: 'Отмена заказов для этой учётки запрещена (can_cancel_orders = false).',
    };
  }
  return {
    allowed: false,
    code: 'cancel_forbidden',
    message: 'Недостаточно прав для отмены заказа.',
  };
}

export async function resolveCancelPreview(
  db: SupabaseClient,
  orderQuery: string | null,
  actor: { role: string | null; can_cancel_orders: boolean }
): Promise<{ content: string; preview: CancelPreview | null }> {
  const perm = actorCanCancel(actor.role, actor.can_cancel_orders === true);
  const canonical = orderQuery ? parseOrderNumberQuery(orderQuery) : null;
  if (!canonical) {
    return {
      content: 'Укажите номер заказа, например N000033. Отмена выполняется только после кнопки в карточке.',
      preview: null,
    };
  }

  const { data: order, error } = await db
    .from('orders')
    .select(
      'id, order_number, created_at, status, payment_type, total_sum, city_id, seller_id, is_preorder, preorder_status, is_debt, fulfilled_at, order_items(product_name_snapshot, qty, is_gift)'
    )
    .eq('order_number', canonical)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) {
    return {
      content: `Заказ ${canonical} не найден. Новый заказ не отменяю.`,
      preview: null,
    };
  }

  const [{ data: city }, { data: seller }] = await Promise.all([
    db.from('cities').select('name').eq('id', order.city_id).maybeSingle(),
    db.from('profiles').select('display_name').eq('id', order.seller_id).maybeSingle(),
  ]);

  const items = (
    (order.order_items as { product_name_snapshot?: string; qty?: number; is_gift?: boolean }[]) || []
  ).map((it) => ({
    name: String(it.product_name_snapshot || 'товар'),
    qty: Number(it.qty || 0),
    is_gift: it.is_gift === true,
  }));

  const canceled = isCanceled(order.status as string, order.preorder_status as string);
  const willReturn =
    !canceled &&
    (order.is_preorder !== true || order.preorder_status === 'fulfilled');
  const stockNote = canceled
    ? 'Заказ уже отменён. Повторная отмена остатки не увеличит.'
    : willReturn
      ? 'При отмене списанные остатки вернутся на склад, включая подарки. Движения cancel_sale запишутся в историю.'
      : 'Это невыданный предзаказ: остатки не списывались и при отмене не изменятся.';

  const errors: CancelPreview['errors'] = [];
  if (!perm.allowed) errors.push({ code: perm.code, message: perm.message });
  if (canceled) {
    errors.push({
      code: 'already_canceled',
      message: `Заказ ${canonical} уже отменён.`,
    });
  }

  const preview: CancelPreview = {
    order_id: order.id as string,
    order_number: String(order.order_number),
    seller_name: seller ? String(seller.display_name || '') : null,
    city_name: city ? String(city.name || '') : null,
    created_at: String(order.created_at),
    status: String(order.status || ''),
    payment_label: paymentLabel((order.payment_type as PaymentType) || null, order.is_debt === true),
    total_sum: Number(order.total_sum || 0),
    is_preorder: order.is_preorder === true,
    is_debt: order.is_debt === true,
    items,
    will_return_stock: willReturn,
    stock_note: stockNote,
    can_cancel: perm.allowed && !canceled,
    errors,
  };

  if (canceled) {
    return { content: `Заказ ${canonical} уже отменён. Повторно остатки не возвращаю.`, preview };
  }
  if (!perm.allowed) {
    return { content: perm.message, preview };
  }
  return {
    content: `Найден заказ ${canonical}. Проверьте карточку и подтвердите отмену кнопкой.`,
    preview,
  };
}
