export type ProductCostRow = { id: string; cost_price: number | null };

export function isMissingCostBackend(message: string | null | undefined): boolean {
  const m = (message || '').toLowerCase();
  if (!m) return false;
  return (
    m.includes('admin_product_costs') ||
    m.includes('cost_price') ||
    m.includes('could not find the function') ||
    m.includes('schema cache') ||
    m.includes('42703') ||
    m.includes('pgrst202')
  );
}

export function productCatalogPayload(input: {
  name: string;
  category: string | null;
  unit: string;
  price_retail: number;
  is_active: boolean;
}): {
  name: string;
  category: string | null;
  unit: string;
  price_retail: number;
  is_active: boolean;
} {
  return {
    name: input.name,
    category: input.category,
    unit: input.unit,
    price_retail: input.price_retail,
    is_active: input.is_active,
  };
}

export function mergeProductCosts<T extends { id: string }>(
  products: T[],
  costs: ProductCostRow[] | null | undefined
): Array<T & { cost_price: number | null }> {
  const costById = new Map((costs || []).map((row) => [row.id, row.cost_price]));
  return products.map((p) => ({
    ...p,
    cost_price: costById.has(p.id) ? costById.get(p.id) ?? null : null,
  }));
}
