-- mark_debt_paid: при закрытии долга обновлять payment_type на cash/kaspi
-- чтобы в UI и отчётах отображалась правильная оплата

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
  v_pt text;
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

  v_pt := NULLIF(trim(COALESCE(p_payment_method, '')), '')::text;
  IF v_pt NOT IN ('cash', 'kaspi', 'card', 'transfer') THEN
    v_pt := 'cash';
  END IF;

  UPDATE orders
  SET debt_status = 'paid',
      debt_paid_at = now(),
      debt_payment_method = v_pt,
      payment_type = v_pt,
      updated_at = now()
  WHERE id = p_order_id;
END;
$$;
