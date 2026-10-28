import { isConfirmedInRange, sumConfirmedInRange } from '@/lib/accounting';

export type OrderItemRow = {
  product_id?: string | null;
  qty?: number | null;
  is_gift?: boolean | null;
  product_name_snapshot?: string | null;
  product?: { name?: string | null; unit?: string | null } | { name?: string | null; unit?: string | null }[] | null;
};

export type OrderRow = {
  id?: string;
  seller_id?: string | null;
  total_sum?: number;
  city_id?: string;
  created_at?: string;
  status?: string;
  payment_type?: string | null;
  is_preorder?: boolean;
  preorder_status?: string;
  fulfilled_at?: string;
  is_debt?: boolean;
  debt_status?: string;
  debt_paid_at?: string;
  order_items?: OrderItemRow[] | null;
};

export type ProductQty = {
  key: string;
  name: string;
  unit: string;
  qty: number;
};

export type SellerTodayRow = {
  key: string;
  name: string;
  revenue: number;
  products: ProductQty[];
};

export type CityRevenue = {
  city_name: string;
  revenue: number;
  order_count: number;
};

export type TodaySalesDashboard = {
  todayRevenue: number;
  todayOrders: number;
  cityRevenues: CityRevenue[];
  sellerRows: SellerTodayRow[];
  productRows: ProductQty[];
  sellersTotal: number;
};

function productFromItem(item: OrderItemRow): { name: string; unit: string; productId: string } {
  const p = Array.isArray(item.product) ? item.product[0] : item.product;
  const name = (item.product_name_snapshot || p?.name || 'Товар').trim();
  const unit = p?.unit || 'pcs';
  const productId = item.product_id || name;
  return { name, unit, productId };
}

export function addProductQty(map: Map<string, ProductQty>, item: OrderItemRow) {
  if (item.is_gift === true) return;
  const qty = Number(item.qty ?? 0);
  if (!qty) return;
  const { name, unit, productId } = productFromItem(item);
  const key = `${productId}::${unit}`;
  const cur = map.get(key);
  if (cur) cur.qty += qty;
  else map.set(key, { key, name, unit, qty });
}

export function sortProducts(list: ProductQty[]): ProductQty[] {
  return [...list].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'ru'));
}

function moneyOf(order: OrderRow): number {
  const t = order.total_sum;
  return typeof t === 'number' && !Number.isNaN(t) ? t : 0;
}

export function buildTodaySalesDashboard(params: {
  orders: OrderRow[];
  range: { from: Date; toNext: Date };
  sellerNames: Map<string, string>;
  cityNames: Map<string, string>;
  deletedSellerLabel: string;
}): TodaySalesDashboard {
  const { orders, range, sellerNames, cityNames, deletedSellerLabel } = params;
  const recognized = orders.filter((o) => isConfirmedInRange(o, range));
  const todayRevenue = sumConfirmedInRange(orders, range);

  const cityMap = new Map<string, { revenue: number; count: number }>();
  for (const o of recognized) {
    const cid = o.city_id ?? '';
    const cur = cityMap.get(cid) || { revenue: 0, count: 0 };
    cur.revenue += Number(o.total_sum ?? 0);
    cur.count += 1;
    cityMap.set(cid, cur);
  }

  const sellerMap = new Map<string, { name: string; revenue: number; products: Map<string, ProductQty> }>();
  const allProducts = new Map<string, ProductQty>();

  for (const o of recognized) {
    const key = o.seller_id || '__deleted__';
    const name = o.seller_id ? sellerNames.get(o.seller_id) || deletedSellerLabel : deletedSellerLabel;
    let bucket = sellerMap.get(key);
    if (!bucket) {
      bucket = { name, revenue: 0, products: new Map() };
      sellerMap.set(key, bucket);
    }
    bucket.revenue += moneyOf(o);
    for (const item of o.order_items ?? []) {
      addProductQty(bucket.products, item);
      addProductQty(allProducts, item);
    }
  }

  const sellerRows = Array.from(sellerMap.entries())
    .map(([key, v]) => ({
      key,
      name: v.name,
      revenue: v.revenue,
      products: sortProducts([...v.products.values()]),
    }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru'));

  const sellersTotal = sellerRows.reduce((s, r) => s + r.revenue, 0);

  return {
    todayRevenue,
    todayOrders: recognized.length,
    cityRevenues: Array.from(cityMap.entries()).map(([id, v]) => ({
      city_name: cityNames.get(id) ?? id,
      revenue: v.revenue,
      order_count: v.count,
    })),
    sellerRows,
    productRows: sortProducts([...allProducts.values()]),
    sellersTotal,
  };
}
