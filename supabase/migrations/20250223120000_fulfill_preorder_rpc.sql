-- RPC fulfill_preorder: выдача предзаказа, после выдачи is_preorder=false (считается обычным заказом).
-- Продавец может выполнить только свой заказ; admin — любой.

CREATE OR REPLACE FUNCTION public.fulfill_preorder(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_role text;
  v_order_rec record;
  v_item record;
  v_current_qty int;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT id, city_id, seller_id, is_preorder, preorder_status
  INTO v_order_rec
  FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order_rec.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NOT COALESCE(v_order_rec.is_preorder, false) THEN
    RAISE EXCEPTION 'Order is not a preorder';
  END IF;
  IF v_order_rec.preorder_status != 'pending' THEN
    RAISE EXCEPTION 'Preorder is not pending (already fulfilled or cancelled)';
  END IF;
  IF v_role = 'seller' AND v_order_rec.seller_id != v_uid THEN
    RAISE EXCEPTION 'Seller can only fulfill own preorders';
  END IF;

  -- Check stock for all order items
  FOR v_item IN SELECT product_id, qty FROM order_items WHERE order_id = p_order_id
  LOOP
    SELECT qty_on_hand INTO v_current_qty FROM inventory
    WHERE city_id = v_order_rec.city_id AND product_id = v_item.product_id;
    IF v_current_qty IS NULL OR v_current_qty < v_item.qty THEN
      RAISE EXCEPTION 'Insufficient stock on warehouse for one or more products';
    END IF;
  END LOOP;

  -- Deduct inventory and create movements
  FOR v_item IN SELECT product_id, qty FROM order_items WHERE order_id = p_order_id
  LOOP
    UPDATE inventory SET qty_on_hand = qty_on_hand - v_item.qty, updated_at = now()
    WHERE city_id = v_order_rec.city_id AND product_id = v_item.product_id;

    INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
    VALUES (v_order_rec.city_id, v_item.product_id, 'sale', -v_item.qty, p_order_id, v_uid);
  END LOOP;

  -- Вариант A: после выдачи — обычный заказ (is_preorder=false), preorder_status='fulfilled' для истории
  UPDATE orders
  SET preorder_status = 'fulfilled',
      fulfilled_at = now(),
      status = 'confirmed',
      is_preorder = false,
      updated_at = now()
  WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fulfill_preorder(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_preorder(uuid) TO service_role;
