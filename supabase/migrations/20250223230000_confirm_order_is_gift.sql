-- Update confirm_order to support is_gift (bonus items: price=0, line_sum=0, still deducted)

CREATE OR REPLACE FUNCTION confirm_order(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seller_id uuid;
  v_city_id uuid;
  v_role text;
  v_order_id uuid;
  v_items jsonb;
  v_item jsonb;
  v_total numeric := 0;
  v_product_name text;
  v_price numeric;
  v_qty int;
  v_line_sum numeric;
  v_current_qty int;
  v_is_debt boolean;
  v_is_gift boolean;
BEGIN
  v_seller_id := auth.uid();
  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, city_id INTO v_role, v_city_id FROM profiles WHERE id = v_seller_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  IF v_role = 'admin' THEN
    v_city_id := (payload->>'city_id')::uuid;
    v_seller_id := (payload->>'seller_id')::uuid;
    IF v_city_id IS NULL OR v_seller_id IS NULL THEN
      RAISE EXCEPTION 'Admin must provide city_id and seller_id';
    END IF;
  ELSIF v_role = 'seller' THEN
    IF v_city_id IS NULL THEN
      RAISE EXCEPTION 'Seller has no city assigned';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid role';
  END IF;

  v_items := payload->'items';
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'No items in order';
  END IF;

  -- Preorder: do not check stock and do not deduct at creation. Debt and ordinary: check and deduct.
  IF NOT (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true') THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      SELECT qty_on_hand INTO v_current_qty FROM inventory
      WHERE city_id = v_city_id AND product_id = (v_item->>'product_id')::uuid;
      IF v_current_qty IS NULL OR v_current_qty < (v_item->>'qty')::int THEN
        RAISE EXCEPTION 'Insufficient stock for product %', v_item->>'product_id';
      END IF;
    END LOOP;
  END IF;

  v_is_debt := (payload->>'is_debt' = 'true' OR (payload->'is_debt')::text = 'true');
  IF v_is_debt AND (NULLIF(trim(COALESCE(payload->>'debt_customer_phone', '')), '') IS NULL) THEN
    RAISE EXCEPTION 'Phone required for debt orders';
  END IF;

  INSERT INTO orders (
    seller_id, city_id, status, payment_type, comment, total_sum,
    is_preorder, preorder_status, pickup_date,
    is_debt, debt_status, debt_due_at, debt_customer_name, debt_customer_phone, debt_note
  )
  VALUES (
    v_seller_id,
    v_city_id,
    'confirmed',
    CASE WHEN v_is_debt THEN 'debt' ELSE NULLIF(payload->>'payment_type', '')::text END,
    NULLIF(payload->>'comment', '')::text,
    0,
    (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true'),
    CASE WHEN (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true') THEN 'pending' ELSE 'pending' END,
    CASE
      WHEN (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true') THEN COALESCE(
        NULLIF(trim(COALESCE(payload->>'pickup_date', '')), '')::date,
        current_date
      )
      ELSE NULL
    END,
    v_is_debt,
    CASE WHEN v_is_debt THEN 'active' ELSE 'none' END,
    CASE WHEN v_is_debt THEN NULLIF(trim(COALESCE(payload->>'debt_due_at', '')), '')::date ELSE NULL END,
    CASE WHEN v_is_debt THEN NULLIF(trim(payload->>'debt_customer_name'), '') ELSE NULL END,
    CASE WHEN v_is_debt THEN NULLIF(trim(payload->>'debt_customer_phone'), '') ELSE NULL END,
    CASE WHEN v_is_debt THEN NULLIF(trim(payload->>'debt_note'), '') ELSE NULL END
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    SELECT name, price_retail INTO v_product_name, v_price
    FROM products WHERE id = (v_item->>'product_id')::uuid;

    v_qty := (v_item->>'qty')::int;
    v_is_gift := (v_item->>'is_gift' = 'true' OR (v_item->'is_gift')::text = 'true');

    IF v_is_gift THEN
      v_price := 0;
      v_line_sum := 0;
    ELSE
      IF (v_item->>'price') IS NOT NULL AND (v_item->>'price') != '' THEN
        v_price := (v_item->>'price')::numeric;
      END IF;
      v_line_sum := v_price * v_qty;
      v_total := v_total + v_line_sum;
    END IF;

    INSERT INTO order_items (order_id, product_id, product_name_snapshot, price, qty, line_sum, is_gift)
    VALUES (v_order_id, (v_item->>'product_id')::uuid, v_product_name, v_price, v_qty, v_line_sum, COALESCE(v_is_gift, false));

    IF NOT (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true') THEN
      UPDATE inventory SET qty_on_hand = qty_on_hand - v_qty
      WHERE city_id = v_city_id AND product_id = (v_item->>'product_id')::uuid;

      INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_city_id, (v_item->>'product_id')::uuid, 'sale', -v_qty, v_order_id, auth.uid());
    END IF;
  END LOOP;

  UPDATE orders SET total_sum = v_total WHERE id = v_order_id;

  RETURN v_order_id;
END;
$$;
