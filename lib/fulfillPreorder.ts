import type { SupabaseClient } from '@supabase/supabase-js';

type OrderRow = {
  id: string;
  city_id: string;
  is_preorder?: boolean;
  preorder_status?: string;
  order_items?: Array<{ product_id: string; qty: number }>;
};

export type FulfillResult = { success: true } | { success: false; error: string };

/**
 * Выдача предзаказа без RPC: проверка остатков, списание inventory, движения, обновление заказа.
 * Модель: is_preorder остаётся true, preorder_status = 'fulfilled', fulfilled_at = now(), status = 'confirmed'.
 */
export async function fulfillPreorder(
  supabase: SupabaseClient,
  orderId: string,
  userId: string
): Promise<FulfillResult> {
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, city_id, is_preorder, preorder_status, order_items(product_id, qty)')
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    return { success: false, error: orderError?.message ?? 'Заказ не найден' };
  }

  const row = order as unknown as OrderRow;
  if (!row.order_items?.length) {
    return { success: false, error: 'В заказе нет позиций' };
  }
  if (!row.is_preorder || row.preorder_status !== 'pending') {
    return { success: false, error: 'Заказ не является ожидающим предзаказом' };
  }

  const cityId = row.city_id;
  const productIds = [...new Set(row.order_items.map((i) => i.product_id))];

  const { data: invRows, error: invError } = await supabase
    .from('inventory')
    .select('product_id, qty_on_hand')
    .eq('city_id', cityId)
    .in('product_id', productIds);

  if (invError) {
    return { success: false, error: invError.message };
  }

  const invMap = new Map<string, number>();
  (invRows ?? []).forEach((r: { product_id: string; qty_on_hand: number }) => {
    invMap.set(r.product_id, r.qty_on_hand);
  });

  const needByProduct = new Map<string, number>();
  for (const item of row.order_items) {
    const cur = needByProduct.get(item.product_id) ?? 0;
    needByProduct.set(item.product_id, cur + item.qty);
  }

  for (const [productId, need] of needByProduct.entries()) {
    const onHand = invMap.get(productId) ?? 0;
    if (onHand < need) {
      return { success: false, error: 'Недостаточно остатков на складе' };
    }
  }

  for (const [productId, qty] of needByProduct.entries()) {
    const onHand = invMap.get(productId) ?? 0;
    const newQty = onHand - qty;
    const { error: updErr } = await supabase
      .from('inventory')
      .update({ qty_on_hand: newQty })
      .eq('city_id', cityId)
      .eq('product_id', productId);
    if (updErr) {
      return { success: false, error: updErr.message };
    }
  }

  for (const item of row.order_items) {
    const { error: movErr } = await supabase.from('inventory_movements').insert({
      city_id: cityId,
      product_id: item.product_id,
      type: 'sale',
      qty_delta: -item.qty,
      order_id: orderId,
      created_by: userId,
    });
    if (movErr) {
      return { success: false, error: movErr.message };
    }
  }

  const now = new Date().toISOString();
  const { error: orderUpdErr } = await supabase
    .from('orders')
    .update({
      preorder_status: 'fulfilled',
      fulfilled_at: now,
      status: 'confirmed',
      updated_at: now,
    })
    .eq('id', orderId);

  if (orderUpdErr) {
    return { success: false, error: orderUpdErr.message };
  }

  return { success: true };
}
