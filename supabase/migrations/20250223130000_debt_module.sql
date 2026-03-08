-- Модуль "В долг": товар выдан сразу, деньги не получены. В выручку не входит до оплаты.

-- Колонки в orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_debt boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_status text NOT NULL DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_due_at date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_paid_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_payment_method text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_customer_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_customer_phone text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS debt_note text;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_debt_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_debt_status_check
  CHECK (debt_status IN ('none', 'active', 'paid', 'written_off'));

CREATE INDEX IF NOT EXISTS idx_orders_is_debt_debt_status ON orders(is_debt, debt_status);
CREATE INDEX IF NOT EXISTS idx_orders_debt_paid_at ON orders(debt_paid_at);

-- payment_type: разрешить 'debt' для долгов
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_type_check
  CHECK (payment_type IS NULL OR payment_type IN ('cash', 'kaspi', 'card', 'transfer', 'debt'));

-- RPC: отметить долг как погашенный
CREATE OR REPLACE FUNCTION public.mark_debt_paid(p_order_id uuid, p_payment_method text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_role text;
  v_order_rec record;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT id, seller_id, is_debt, debt_status
  INTO v_order_rec
  FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order_rec.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NOT COALESCE(v_order_rec.is_debt, false) THEN
    RAISE EXCEPTION 'Order is not a debt';
  END IF;
  IF v_role = 'seller' AND v_order_rec.seller_id != v_uid THEN
    RAISE EXCEPTION 'Seller can only mark own debts as paid';
  END IF;

  IF v_order_rec.debt_status = 'paid' THEN
    RETURN;
  END IF;

  UPDATE orders
  SET debt_status = 'paid',
      debt_paid_at = now(),
      debt_payment_method = NULLIF(trim(COALESCE(p_payment_method, '')), '')::text,
      updated_at = now()
  WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_debt_paid(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_debt_paid(uuid, text) TO service_role;
