-- Безопасная миграция: добавить колонки предзаказов в orders (можно запускать повторно).

-- is_preorder
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'is_preorder'
  ) THEN
    ALTER TABLE orders ADD COLUMN is_preorder boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- preorder_status
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'preorder_status'
  ) THEN
    ALTER TABLE orders ADD COLUMN preorder_status text NOT NULL DEFAULT 'pending';
  END IF;
END $$;

-- pickup_date
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'pickup_date'
  ) THEN
    ALTER TABLE orders ADD COLUMN pickup_date date;
  END IF;
END $$;

-- fulfilled_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'fulfilled_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN fulfilled_at timestamptz;
  END IF;
END $$;

-- Constraint для preorder_status (удаляем если есть, затем добавляем)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_preorder_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_preorder_status_check
  CHECK (preorder_status IN ('pending', 'fulfilled', 'cancelled'));

-- Индексы (IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_orders_is_preorder ON orders(is_preorder);
CREATE INDEX IF NOT EXISTS idx_orders_preorder_status ON orders(preorder_status);
