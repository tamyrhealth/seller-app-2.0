import { availableQty } from '@/lib/inventoryAvailable';
import { PRODUCT_CATALOG_SELECT, type Product } from '@/lib/types';

export const CATALOG_INVENTORY_SELECT = 'product_id, qty_on_hand, qty_reserved';

export type CatalogStock = {
  qty_on_hand: number;
  qty_reserved: number;
  qty_available: number;
};

export type CatalogProduct = Product & { inventory?: CatalogStock };

export function stockFromInventoryRow(row: {
  qty_on_hand?: number | string | null;
  qty_reserved?: number | string | null;
}): CatalogStock {
  const onHand = Number(row.qty_on_hand || 0);
  const reserved = Number(row.qty_reserved || 0);
  return {
    qty_on_hand: onHand,
    qty_reserved: reserved,
    qty_available: availableQty(onHand, reserved),
  };
}

export { PRODUCT_CATALOG_SELECT };
