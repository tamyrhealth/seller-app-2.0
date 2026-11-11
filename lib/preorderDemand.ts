export type PreorderDemandOrder = {
  id: string;
  order_number?: string | null;
  seller_id: string;
  city_id: string;
  seller_name?: string | null;
  city_name?: string | null;
  pickup_date?: string | null;
  order_items?: Array<{
    product_id: string;
    product_name_snapshot?: string | null;
    qty: number;
    qty_reserved?: number | null;
  }> | null;
};

export type PreorderDemandRow = {
  order_id: string;
  order_number: string;
  seller_id: string;
  seller_name: string;
  city_id: string;
  city_name: string;
  product_id: string;
  product_name: string;
  qty: number;
  reserved: number;
  uncovered: number;
  pickup_date: string | null;
};

export function buildPreorderDemandRows(orders: PreorderDemandOrder[]): PreorderDemandRow[] {
  const rows: PreorderDemandRow[] = [];
  for (const order of orders) {
    for (const item of order.order_items || []) {
      const qty = Number(item.qty) || 0;
      if (!(qty > 0)) continue;
      const reserved = Math.min(qty, Math.max(0, Number(item.qty_reserved) || 0));
      const uncovered = Math.max(0, qty - reserved);
      rows.push({
        order_id: order.id,
        order_number: String(order.order_number || order.id.slice(0, 8)),
        seller_id: order.seller_id,
        seller_name: order.seller_name || order.seller_id.slice(0, 8),
        city_id: order.city_id,
        city_name: order.city_name || order.city_id.slice(0, 8),
        product_id: item.product_id,
        product_name: item.product_name_snapshot || item.product_id.slice(0, 8),
        qty,
        reserved,
        uncovered,
        pickup_date: order.pickup_date || null,
      });
    }
  }
  rows.sort((a, b) => {
    if (b.uncovered !== a.uncovered) return b.uncovered - a.uncovered;
    if (a.city_name !== b.city_name) return a.city_name.localeCompare(b.city_name, 'ru');
    if (a.seller_name !== b.seller_name) return a.seller_name.localeCompare(b.seller_name, 'ru');
    return a.product_name.localeCompare(b.product_name, 'ru');
  });
  return rows;
}
