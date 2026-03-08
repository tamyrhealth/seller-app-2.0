-- Pre-orders: pay now, pick up later. Inventory is deducted only on fulfillment.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_preorder boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preorder_status text NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_date date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

-- Constraint: preorder_status only applies when is_preorder; allow same values for all for simplicity
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_preorder_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_preorder_status_check
  CHECK (preorder_status IN ('pending', 'fulfilled', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_orders_is_preorder ON orders(is_preorder);
CREATE INDEX IF NOT EXISTS idx_orders_preorder_status ON orders(preorder_status);
