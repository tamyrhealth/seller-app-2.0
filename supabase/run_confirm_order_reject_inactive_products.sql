-- Reject hidden products on NEW confirm_order calls.
-- Existing orders and idempotent retries are unchanged.
-- Do not apply until explicitly allowed.

BEGIN;

CREATE OR REPLACE FUNCTION public.confirm_order(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_seller_id uuid;
  v_city_id uuid;
  v_role text;
  v_order_id uuid;
  v_items jsonb;
  v_item jsonb;
  v_total numeric := 0;
  v_product_name text;
  v_price numeric;
  v_qty numeric;
  v_line_sum numeric;
  v_is_debt boolean;
  v_is_preorder boolean;
  v_is_gift boolean;
  v_key text;
  v_fp text;
  v_existing_fp text;
  v_pid uuid;
  v_need numeric;
  v_upd int;
  v_payment_type text;
  v_comment text;
  v_pickup text;
  v_debt_phone text;
  v_debt_name text;
  v_debt_due text;
  v_debt_note text;
  v_constraint text;
  v_active boolean;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_seller_id := v_actor_id;
  SELECT role, city_id INTO v_role, v_city_id FROM profiles WHERE id = v_actor_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  IF v_role IN ('admin', 'manager') THEN
    v_city_id := (payload->>'city_id')::uuid;
    v_seller_id := (payload->>'seller_id')::uuid;
    IF v_city_id IS NULL OR v_seller_id IS NULL THEN
      RAISE EXCEPTION 'Admin or manager must provide city_id and seller_id';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles s
      WHERE s.id = v_seller_id
        AND s.role = 'seller'
        AND COALESCE(s.is_active, true)
        AND s.city_id IS NOT NULL
        AND s.city_id = v_city_id
    ) THEN
      RAISE EXCEPTION 'Seller not found';
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
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) e
    WHERE (e->>'qty')::numeric IS NULL OR (e->>'qty')::numeric <= 0
  ) THEN
    RAISE EXCEPTION 'Invalid qty in order items';
  END IF;

  v_is_preorder := (payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true');
  v_is_debt := COALESCE((payload->>'is_debt' = 'true' OR (payload->'is_debt')::text = 'true'), false);
  v_debt_phone := NULLIF(trim(COALESCE(payload->>'debt_customer_phone', '')), '');
  v_debt_name := NULLIF(trim(COALESCE(payload->>'debt_customer_name', '')), '');
  v_debt_due := NULLIF(trim(COALESCE(payload->>'debt_due_at', '')), '');
  v_debt_note := NULLIF(trim(COALESCE(payload->>'debt_note', '')), '');
  IF v_is_debt AND v_debt_phone IS NULL THEN
    RAISE EXCEPTION 'Phone required for debt orders';
  END IF;

  v_payment_type := CASE
    WHEN v_is_debt THEN 'debt'
    ELSE NULLIF(payload->>'payment_type', '')
  END;
  v_comment := NULLIF(payload->>'comment', '');
  v_pickup := CASE
    WHEN v_is_preorder THEN COALESCE(
      NULLIF(trim(COALESCE(payload->>'pickup_date', '')), ''),
      current_date::text
    )
    ELSE NULL
  END;

  v_key := NULLIF(trim(COALESCE(payload->>'idempotency_key', '')), '');

  v_fp := md5((
    jsonb_build_object(
      'actor_id', v_actor_id::text,
      'seller_id', v_seller_id::text,
      'city_id', v_city_id::text,
      'is_preorder', v_is_preorder,
      'is_debt', v_is_debt,
      'payment_type', COALESCE(v_payment_type, ''),
      'comment', COALESCE(v_comment, ''),
      'pickup_date', COALESCE(v_pickup, ''),
      'debt_customer_phone', COALESCE(v_debt_phone, ''),
      'debt_customer_name', COALESCE(v_debt_name, ''),
      'debt_due_at', COALESCE(v_debt_due, ''),
      'debt_note', COALESCE(v_debt_note, ''),
      'items', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'product_id', e->>'product_id',
            'qty', round((e->>'qty')::numeric, 3),
            'price', COALESCE(e->>'price', ''),
            'is_gift', COALESCE(e->>'is_gift' = 'true' OR (e->'is_gift')::text = 'true', false)
          ) ORDER BY e->>'product_id', COALESCE(e->>'is_gift', ''), round((e->>'qty')::numeric, 3), COALESCE(e->>'price', '')
        ), '[]'::jsonb)
        FROM jsonb_array_elements(v_items) e
      )
    )
  )::text);

  IF v_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtext('confirm_order:' || v_actor_id::text),
      hashtext(v_key)
    );

    SELECT id, idempotency_fingerprint
      INTO v_order_id, v_existing_fp
    FROM orders
    WHERE idempotency_key = v_key
      AND idempotency_actor_id = v_actor_id;

    IF v_order_id IS NOT NULL THEN
      IF v_existing_fp IS DISTINCT FROM v_fp THEN
        RAISE EXCEPTION 'Idempotency key reused with a different order payload';
      END IF;
      RETURN v_order_id;
    END IF;
  END IF;

  FOR v_pid IN
    SELECT DISTINCT (e->>'product_id')::uuid
    FROM jsonb_array_elements(v_items) e
    ORDER BY 1
  LOOP
    SELECT p.is_active INTO v_active
    FROM public.products p
    WHERE p.id = v_pid
    FOR UPDATE;
    IF NOT FOUND OR COALESCE(v_active, true) = false THEN
      RAISE EXCEPTION 'Product is not available';
    END IF;
  END LOOP;

  IF NOT v_is_preorder THEN
    FOR v_pid, v_need IN
      SELECT (e->>'product_id')::uuid, SUM((e->>'qty')::numeric)
      FROM jsonb_array_elements(v_items) e
      GROUP BY 1
      ORDER BY 1
    LOOP
      PERFORM 1 FROM inventory
      WHERE city_id = v_city_id AND product_id = v_pid
      FOR UPDATE;

      UPDATE inventory
      SET qty_on_hand = qty_on_hand - v_need
      WHERE city_id = v_city_id
        AND product_id = v_pid
        AND qty_on_hand >= v_need;
      GET DIAGNOSTICS v_upd = ROW_COUNT;
      IF v_upd = 0 THEN
        RAISE EXCEPTION 'Insufficient stock for product %', v_pid;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO orders (
    seller_id, city_id, status, payment_type, comment, total_sum,
    is_preorder, preorder_status, pickup_date,
    is_debt, debt_status, debt_due_at, debt_customer_name, debt_customer_phone, debt_note,
    idempotency_key, idempotency_fingerprint, idempotency_actor_id
  )
  VALUES (
    v_seller_id,
    v_city_id,
    'confirmed',
    v_payment_type,
    v_comment,
    0,
    v_is_preorder,
    CASE WHEN v_is_preorder THEN 'pending' ELSE 'pending' END,
    CASE WHEN v_is_preorder THEN v_pickup::date ELSE NULL END,
    v_is_debt,
    CASE WHEN v_is_debt THEN 'active' ELSE 'none' END,
    CASE WHEN v_is_debt THEN v_debt_due::date ELSE NULL END,
    CASE WHEN v_is_debt THEN v_debt_name ELSE NULL END,
    CASE WHEN v_is_debt THEN v_debt_phone ELSE NULL END,
    CASE WHEN v_is_debt THEN v_debt_note ELSE NULL END,
    v_key,
    v_fp,
    CASE WHEN v_key IS NOT NULL THEN v_actor_id ELSE NULL END
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    SELECT name, price_retail INTO v_product_name, v_price
    FROM products WHERE id = (v_item->>'product_id')::uuid;

    v_qty := (v_item->>'qty')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid qty for product %', v_item->>'product_id';
    END IF;
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
    VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_product_name,
      v_price,
      v_qty,
      v_line_sum,
      COALESCE(v_is_gift, false)
    );

    IF NOT v_is_preorder THEN
      INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_city_id, (v_item->>'product_id')::uuid, 'sale', -v_qty, v_order_id, v_actor_id);
    END IF;
  END LOOP;

  UPDATE orders SET total_sum = v_total WHERE id = v_order_id;

  RETURN v_order_id;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS NOT NULL
       AND v_constraint IS DISTINCT FROM 'orders_idempotency_actor_key_uidx' THEN
      RAISE;
    END IF;
    IF v_key IS NULL THEN
      RAISE;
    END IF;
    SELECT id, idempotency_fingerprint
      INTO v_order_id, v_existing_fp
    FROM orders
    WHERE idempotency_key = v_key
      AND idempotency_actor_id = v_actor_id;
    IF v_order_id IS NULL THEN
      RAISE;
    END IF;
    IF v_existing_fp IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'Idempotency key reused with a different order payload';
    END IF;
    RETURN v_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_order(jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_order(jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.confirm_order(jsonb) TO service_role;

COMMIT;
