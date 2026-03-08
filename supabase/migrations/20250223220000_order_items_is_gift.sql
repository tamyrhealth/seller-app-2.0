-- Add is_gift column to order_items for bonus items (price=0, line_sum=0, still deducted/returned)

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS is_gift boolean NOT NULL DEFAULT false;
