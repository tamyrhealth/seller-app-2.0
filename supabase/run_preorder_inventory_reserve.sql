-- 5.20.2B Preorder physical vs reserved stock.
-- Local apply only until Production is explicitly allowed. Do not weaken Phase 2 / P0.

BEGIN;

ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS qty_reserved numeric(12,3) DEFAULT 0 NOT NULL;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS qty_reserved numeric(12,3) DEFAULT 0 NOT NULL;

UPDATE public.inventory SET qty_reserved = 0 WHERE qty_reserved IS NULL;
UPDATE public.order_items SET qty_reserved = 0 WHERE qty_reserved IS NULL;

ALTER TABLE public.inventory
  DROP CONSTRAINT IF EXISTS inventory_qty_reserved_chk;
ALTER TABLE public.inventory
  ADD CONSTRAINT inventory_qty_reserved_chk
  CHECK (qty_reserved >= 0 AND qty_reserved <= GREATEST(qty_on_hand, 0));

ALTER TABLE public.order_items
  DROP CONSTRAINT IF EXISTS order_items_qty_reserved_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_qty_reserved_chk
  CHECK (qty_reserved >= 0 AND qty_reserved <= qty);

CREATE OR REPLACE FUNCTION public.inventory_lock_sku(p_city_id uuid, p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_city_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'Invalid inventory sku';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('inv:' || p_city_id::text), hashtext(p_product_id::text));
  INSERT INTO public.inventory (city_id, product_id, qty_on_hand, qty_reserved, updated_at)
  VALUES (p_city_id, p_product_id, 0, 0, now())
  ON CONFLICT (city_id, product_id) DO NOTHING;
  PERFORM 1 FROM public.inventory
  WHERE city_id = p_city_id AND product_id = p_product_id
  FOR UPDATE;
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_available_of(p_on_hand numeric, p_reserved numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT GREATEST(COALESCE(p_on_hand, 0), 0) - GREATEST(COALESCE(p_reserved, 0), 0);
$$;

CREATE OR REPLACE FUNCTION public.inventory_deduct_available(
  p_city_id uuid,
  p_product_id uuid,
  p_need numeric
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_upd integer;
  v_need numeric;
BEGIN
  v_need := round(COALESCE(p_need, 0), 3);
  IF v_need <= 0 THEN
    RAISE EXCEPTION 'Invalid qty';
  END IF;
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);
  UPDATE public.inventory
  SET qty_on_hand = qty_on_hand - v_need,
      updated_at = now()
  WHERE city_id = p_city_id
    AND product_id = p_product_id
    AND public.inventory_available_of(qty_on_hand, qty_reserved) >= v_need;
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  IF v_upd = 0 THEN
    RAISE EXCEPTION 'Insufficient stock';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_reserve_up_to(
  p_city_id uuid,
  p_product_id uuid,
  p_need numeric
)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_need numeric;
  v_take numeric;
BEGIN
  v_need := round(GREATEST(COALESCE(p_need, 0), 0), 3);
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);
  IF v_need <= 0 THEN
    RETURN 0;
  END IF;
  SELECT LEAST(v_need, public.inventory_available_of(qty_on_hand, qty_reserved))
    INTO v_take
  FROM public.inventory
  WHERE city_id = p_city_id AND product_id = p_product_id;
  v_take := round(GREATEST(COALESCE(v_take, 0), 0), 3);
  IF v_take > 0 THEN
    UPDATE public.inventory
    SET qty_reserved = qty_reserved + v_take,
        updated_at = now()
    WHERE city_id = p_city_id AND product_id = p_product_id;
  END IF;
  RETURN v_take;
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_release_reserve(
  p_city_id uuid,
  p_product_id uuid,
  p_qty numeric
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_qty numeric;
  v_upd integer;
BEGIN
  v_qty := round(GREATEST(COALESCE(p_qty, 0), 0), 3);
  IF v_qty <= 0 THEN
    RETURN;
  END IF;
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);
  UPDATE public.inventory
  SET qty_reserved = qty_reserved - v_qty,
      updated_at = now()
  WHERE city_id = p_city_id
    AND product_id = p_product_id
    AND qty_reserved >= v_qty;
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  IF v_upd = 0 THEN
    RAISE EXCEPTION 'Insufficient reserved qty';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_fulfill_sku(
  p_city_id uuid,
  p_product_id uuid,
  p_need numeric,
  p_reserved numeric
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_need numeric;
  v_reserved numeric;
  v_upd integer;
BEGIN
  v_need := round(COALESCE(p_need, 0), 3);
  v_reserved := round(GREATEST(COALESCE(p_reserved, 0), 0), 3);
  IF v_need <= 0 THEN
    RAISE EXCEPTION 'Invalid qty';
  END IF;
  IF v_reserved > v_need THEN
    RAISE EXCEPTION 'Reserved qty exceeds fulfill qty';
  END IF;
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);
  UPDATE public.inventory
  SET qty_on_hand = qty_on_hand - v_need,
      qty_reserved = qty_reserved - v_reserved,
      updated_at = now()
  WHERE city_id = p_city_id
    AND product_id = p_product_id
    AND qty_on_hand >= v_need
    AND qty_reserved >= v_reserved
    AND (qty_reserved - v_reserved) <= GREATEST(qty_on_hand - v_need, 0);
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  IF v_upd = 0 THEN
    RAISE EXCEPTION 'Insufficient stock';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_allocate_pending_preorders(
  p_city_id uuid,
  p_product_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id uuid;
  v_take numeric;
  v_upd integer;
  v_guard integer := 0;
BEGIN
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);
  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 10000 THEN
      RAISE EXCEPTION 'allocate pending preorders did not converge';
    END IF;
    SELECT oi.id,
           LEAST(
             oi.qty - COALESCE(oi.qty_reserved, 0),
             public.inventory_available_of(inv.qty_on_hand, inv.qty_reserved)
           )
      INTO v_item_id, v_take
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.inventory inv
      ON inv.city_id = o.city_id AND inv.product_id = oi.product_id
    WHERE o.city_id = p_city_id
      AND oi.product_id = p_product_id
      AND COALESCE(o.is_preorder, false)
      AND o.preorder_status = 'pending'
      AND o.status IS DISTINCT FROM 'canceled'
      AND o.status IS DISTINCT FROM 'cancelled'
      AND oi.qty > COALESCE(oi.qty_reserved, 0)
      AND public.inventory_available_of(inv.qty_on_hand, inv.qty_reserved) > 0
    ORDER BY o.created_at, o.id, oi.id
    LIMIT 1;

    IF v_item_id IS NULL OR COALESCE(v_take, 0) <= 0 THEN
      EXIT;
    END IF;
    v_take := round(v_take, 3);

    UPDATE public.order_items oi
    SET qty_reserved = oi.qty_reserved + v_take
    FROM public.orders o
    WHERE oi.id = v_item_id
      AND o.id = oi.order_id
      AND COALESCE(o.is_preorder, false)
      AND o.preorder_status = 'pending'
      AND o.status IS DISTINCT FROM 'canceled'
      AND o.status IS DISTINCT FROM 'cancelled'
      AND oi.qty_reserved + v_take <= oi.qty;
    GET DIAGNOSTICS v_upd = ROW_COUNT;
    IF v_upd = 0 THEN
      CONTINUE;
    END IF;

    UPDATE public.inventory
    SET qty_reserved = qty_reserved + v_take,
        updated_at = now()
    WHERE city_id = p_city_id AND product_id = p_product_id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_add_physical(
  p_city_id uuid,
  p_product_id uuid,
  p_qty numeric
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_qty numeric;
BEGIN
  v_qty := round(COALESCE(p_qty, 0), 3);
  IF v_qty <= 0 THEN
    RAISE EXCEPTION 'Invalid qty';
  END IF;
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);
  UPDATE public.inventory
  SET qty_on_hand = qty_on_hand + v_qty,
      updated_at = now()
  WHERE city_id = p_city_id AND product_id = p_product_id;
  PERFORM public.inventory_allocate_pending_preorders(p_city_id, p_product_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_set_physical(
  p_city_id uuid,
  p_product_id uuid,
  p_new_qty numeric
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_new numeric;
  v_reserved numeric;
BEGIN
  v_new := round(COALESCE(p_new_qty, -1), 3);
  IF v_new < 0 THEN
    RAISE EXCEPTION 'Invalid qty';
  END IF;
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);
  SELECT qty_reserved INTO v_reserved
  FROM public.inventory
  WHERE city_id = p_city_id AND product_id = p_product_id;
  IF v_reserved IS NULL THEN
    RAISE EXCEPTION 'Inventory row not found';
  END IF;
  IF v_new < v_reserved THEN
    RAISE EXCEPTION 'Cannot set qty below reserved';
  END IF;
  UPDATE public.inventory
  SET qty_on_hand = v_new,
      updated_at = now()
  WHERE city_id = p_city_id AND product_id = p_product_id;
  PERFORM public.inventory_allocate_pending_preorders(p_city_id, p_product_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_backfill_pending_preorder_reserves()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_city uuid;
  v_pid uuid;
  v_item uuid;
  v_need numeric;
  v_take numeric;
BEGIN
  UPDATE public.inventory SET qty_reserved = 0;
  UPDATE public.order_items oi
  SET qty_reserved = 0
  FROM public.orders o
  WHERE o.id = oi.order_id
    AND COALESCE(o.is_preorder, false)
    AND o.preorder_status = 'pending'
    AND o.status IS DISTINCT FROM 'canceled'
    AND o.status IS DISTINCT FROM 'cancelled';

  FOR v_city, v_pid, v_item, v_need IN
    SELECT o.city_id, oi.product_id, oi.id, oi.qty
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE COALESCE(o.is_preorder, false)
      AND o.preorder_status = 'pending'
      AND o.status IS DISTINCT FROM 'canceled'
      AND o.status IS DISTINCT FROM 'cancelled'
    ORDER BY o.created_at, o.id, oi.id
  LOOP
    PERFORM public.inventory_lock_sku(v_city, v_pid);
    v_take := public.inventory_reserve_up_to(v_city, v_pid, v_need);
    UPDATE public.order_items SET qty_reserved = v_take WHERE id = v_item;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_lock_sku(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_available_of(numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_deduct_available(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_reserve_up_to(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_release_reserve(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_fulfill_sku(uuid, uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_allocate_pending_preorders(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_add_physical(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_set_physical(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_backfill_pending_preorder_reserves() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.confirm_order__session_body(payload jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
  v_cost numeric;
  v_qty numeric;
  v_line_sum numeric;
  v_is_debt boolean;
  v_is_preorder boolean;
  v_is_gift boolean;
  v_key text;
  v_fp text;
  v_fp_obj jsonb;
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
  v_cust_name text;
  v_cust_phone text;
  v_cust_canon text;
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

  v_is_preorder := COALESCE((payload->>'is_preorder' = 'true' OR (payload->'is_preorder')::text = 'true'), false);
  v_is_debt := COALESCE((payload->>'is_debt' = 'true' OR (payload->'is_debt')::text = 'true'), false);
  v_debt_phone := NULLIF(trim(COALESCE(payload->>'debt_customer_phone', '')), '');
  v_debt_name := NULLIF(trim(COALESCE(payload->>'debt_customer_name', '')), '');
  v_debt_due := NULLIF(trim(COALESCE(payload->>'debt_due_at', '')), '');
  v_debt_note := NULLIF(trim(COALESCE(payload->>'debt_note', '')), '');
  IF v_is_debt AND v_debt_phone IS NULL THEN
    RAISE EXCEPTION 'Phone required for debt orders';
  END IF;

  v_cust_name := NULLIF(trim(COALESCE(payload->>'customer_name', '')), '');
  v_cust_phone := NULLIF(trim(COALESCE(payload->>'customer_phone', '')), '');
  IF v_is_debt THEN
    v_cust_name := v_debt_name;
    v_cust_phone := v_debt_phone;
  END IF;
  v_cust_canon := public.kz_normalize_customer_phone(v_cust_phone);

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

  v_fp_obj := jsonb_build_object(
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
  );
  IF NOT v_is_debt AND (v_cust_name IS NOT NULL OR v_cust_phone IS NOT NULL) THEN
    v_fp_obj := v_fp_obj || jsonb_build_object(
      'customer_name', COALESCE(v_cust_name, ''),
      'customer_phone', COALESCE(v_cust_phone, '')
    );
  END IF;
  v_fp := md5(v_fp_obj::text);

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

  FOR v_pid IN
    SELECT DISTINCT (e->>'product_id')::uuid
    FROM jsonb_array_elements(v_items) e
    ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(v_city_id, v_pid);
  END LOOP;

  IF NOT v_is_preorder THEN
    FOR v_pid, v_need IN
      SELECT (e->>'product_id')::uuid, SUM((e->>'qty')::numeric)
      FROM jsonb_array_elements(v_items) e
      GROUP BY 1
      ORDER BY 1
    LOOP
      PERFORM public.inventory_deduct_available(v_city_id, v_pid, v_need);
    END LOOP;
  END IF;

  INSERT INTO orders (
    seller_id, city_id, status, payment_type, comment, total_sum,
    is_preorder, preorder_status, pickup_date,
    is_debt, debt_status, debt_due_at, debt_customer_name, debt_customer_phone, debt_note,
    customer_name, customer_phone, customer_phone_canon,
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
    v_cust_name,
    v_cust_phone,
    v_cust_canon,
    v_key,
    v_fp,
    CASE WHEN v_key IS NOT NULL THEN v_actor_id ELSE NULL END
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    SELECT name, price_retail, cost_price INTO v_product_name, v_price, v_cost
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

    INSERT INTO order_items (order_id, product_id, product_name_snapshot, price, qty, line_sum, is_gift, cost_price_snapshot)
    VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_product_name,
      v_price,
      v_qty,
      v_line_sum,
      COALESCE(v_is_gift, false),
      v_cost
    );

    IF NOT v_is_preorder THEN
      INSERT INTO inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_city_id, (v_item->>'product_id')::uuid, 'sale', -v_qty, v_order_id, v_actor_id);
    END IF;
  END LOOP;

  IF v_is_preorder THEN
    UPDATE public.order_items oi
    SET qty_reserved = public.inventory_reserve_up_to(v_city_id, oi.product_id, oi.qty)
    WHERE oi.order_id = v_order_id;
  END IF;

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


CREATE OR REPLACE FUNCTION public.fulfill_preorder__session_body(p_order_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_order record;
  v_item record;
  v_pid uuid;
  v_need numeric;
  v_upd int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT id, city_id, seller_id, is_preorder, preorder_status, status, order_number
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status IN ('canceled', 'cancelled') THEN
    RAISE EXCEPTION 'Order is canceled';
  END IF;
  IF NOT COALESCE(v_order.is_preorder, false) THEN
    RAISE EXCEPTION 'Order is not a preorder';
  END IF;
  IF v_order.preorder_status = 'fulfilled' THEN
    RETURN;
  END IF;
  IF v_order.preorder_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Preorder is not pending';
  END IF;
  IF v_role = 'seller' AND v_order.seller_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Seller can only fulfill own preorders';
  END IF;

  FOR v_pid IN
    SELECT DISTINCT product_id
    FROM public.order_items
    WHERE order_id = p_order_id
    ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(v_order.city_id, v_pid);
  END LOOP;

  FOR v_item IN
    SELECT product_id,
           SUM(qty) AS qty,
           SUM(COALESCE(qty_reserved, 0)) AS qty_reserved
    FROM public.order_items
    WHERE order_id = p_order_id
    GROUP BY 1
    ORDER BY 1
  LOOP
    PERFORM public.inventory_fulfill_sku(
      v_order.city_id,
      v_item.product_id,
      v_item.qty,
      v_item.qty_reserved
    );
  END LOOP;

  UPDATE public.order_items
  SET qty_reserved = 0
  WHERE order_id = p_order_id;

  FOR v_item IN
    SELECT product_id, qty FROM public.order_items WHERE order_id = p_order_id
  LOOP
    INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
    VALUES (v_order.city_id, v_item.product_id, 'sale', -v_item.qty, p_order_id, v_uid);
  END LOOP;

  UPDATE public.orders
  SET preorder_status = 'fulfilled',
      fulfilled_at = now(),
      status = 'confirmed',
      updated_at = now()
  WHERE id = p_order_id;

  PERFORM public.log_order_action(
    'preorder_fulfill',
    p_order_id,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'total_sum', (SELECT o.total_sum FROM public.orders o WHERE o.id = p_order_id),
      'items', public.order_history_item_snapshot(p_order_id)
    )
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.apply_order_cancel_report(p_order_id uuid, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_can_cancel_orders boolean := false;
  v_order record;
  v_item record;
  v_pid uuid;
  v_need numeric;
  v_should_return boolean;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT
    id, city_id, status, seller_id, order_number, created_at,
    COALESCE(is_preorder, false) AS is_preorder,
    COALESCE(is_debt, false) AS is_debt,
    preorder_status,
    fulfilled_at
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  SELECT role, COALESCE(can_cancel_orders, false)
    INTO v_role, v_can_cancel_orders
  FROM public.profiles
  WHERE id = v_uid;

  IF v_role = 'admin' THEN
    NULL;
  ELSIF v_role = 'manager' THEN
    -- Flag allows cancel of any existing order id. Client cannot pass seller_id.
    IF v_can_cancel_orders IS NOT TRUE THEN
      RAISE EXCEPTION 'Cancel permission denied';
    END IF;
  ELSIF v_role = 'seller' AND v_order.seller_id = v_uid THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Not allowed to cancel this order';
  END IF;

  IF v_order.status IN ('canceled', 'cancelled') THEN
    PERFORM public.log_order_action(
      'order_cancel',
      p_order_id,
      jsonb_build_object(
        'order_number', v_order.order_number,
        'already_canceled', true,
        'returned_stock', false,
        'actor_role', v_role
      )
    );
    RETURN jsonb_build_object(
      'ok', true,
      'already_canceled', true,
      'returned_stock', false,
      'order_number', v_order.order_number
    );
  END IF;

  IF v_order.is_preorder AND v_order.preorder_status = 'cancelled' THEN
    UPDATE public.orders
    SET status = 'canceled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
    WHERE id = p_order_id AND status IS DISTINCT FROM 'canceled';
    PERFORM public.log_order_action(
      'order_cancel',
      p_order_id,
      jsonb_build_object(
        'order_number', v_order.order_number,
        'already_canceled', true,
        'returned_stock', false,
        'actor_role', v_role,
        'was_preorder', true
      )
    );
    RETURN jsonb_build_object(
      'ok', true,
      'already_canceled', true,
      'returned_stock', false,
      'order_number', v_order.order_number
    );
  END IF;

  IF v_role = 'seller' AND v_order.created_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Cannot cancel order after 10 minutes';
  END IF;

  v_should_return :=
    (NOT v_order.is_preorder)
    OR (v_order.preorder_status = 'fulfilled');

  FOR v_pid IN
    SELECT DISTINCT product_id FROM public.order_items WHERE order_id = p_order_id ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(v_order.city_id, v_pid);
  END LOOP;

  IF v_order.is_preorder AND v_order.preorder_status IS DISTINCT FROM 'fulfilled' THEN
    FOR v_item IN
      SELECT product_id, COALESCE(qty_reserved, 0) AS qty_reserved
      FROM public.order_items
      WHERE order_id = p_order_id
      ORDER BY product_id, id
    LOOP
      PERFORM public.inventory_release_reserve(v_order.city_id, v_item.product_id, v_item.qty_reserved);
    END LOOP;
    UPDATE public.order_items SET qty_reserved = 0 WHERE order_id = p_order_id;
  END IF;

  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'product_id', product_id,
      'qty', qty,
      'name', product_name_snapshot
    )),
    '[]'::jsonb
  )
  INTO v_items
  FROM public.order_items
  WHERE order_id = p_order_id;

  IF v_should_return THEN
    FOR v_pid, v_need IN
      SELECT product_id, SUM(qty)
      FROM public.order_items
      WHERE order_id = p_order_id
      GROUP BY 1
      ORDER BY 1
    LOOP
      PERFORM 1 FROM public.inventory
      WHERE city_id = v_order.city_id AND product_id = v_pid
      FOR UPDATE;

      PERFORM public.inventory_add_physical(v_order.city_id, v_pid, v_need);
    END LOOP;

    FOR v_item IN
      SELECT product_id, qty FROM public.order_items WHERE order_id = p_order_id
    LOOP
      INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, order_id, created_by)
      VALUES (v_order.city_id, v_item.product_id, 'cancel_sale', v_item.qty, p_order_id, auth.uid());
    END LOOP;
  END IF;

  UPDATE public.orders
  SET
    status = 'canceled',
    cancelled_at = now(),
    cancelled_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
    updated_at = now(),
    preorder_status = CASE WHEN v_order.is_preorder THEN 'cancelled' ELSE preorder_status END,
    fulfilled_at = CASE WHEN v_order.is_preorder THEN NULL ELSE fulfilled_at END,
    debt_paid_at = CASE WHEN v_order.is_debt THEN NULL ELSE debt_paid_at END
  WHERE id = p_order_id;

  PERFORM public.log_order_action(
    'order_cancel',
    p_order_id,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''),
      'returned_stock', v_should_return,
      'was_preorder', v_order.is_preorder,
      'was_fulfilled', v_order.preorder_status = 'fulfilled',
      'actor_role', v_role,
      'items', v_items
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'already_canceled', false,
    'returned_stock', v_should_return,
    'order_number', v_order.order_number
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.apply_inventory_adjust__session_body(p_operation_id uuid, p_city_id uuid, p_product_id uuid, p_new_qty numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_existing jsonb;
  v_old numeric;
  v_new numeric;
  v_delta numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_operation_id IS NULL OR p_city_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'Invalid adjust payload';
  END IF;

  v_new := round(COALESCE(p_new_qty, -1), 3);
  IF v_new < 0 THEN
    RAISE EXCEPTION 'Invalid qty';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admin can adjust inventory';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cities WHERE id = p_city_id AND COALESCE(is_active, true)
  ) THEN
    RAISE EXCEPTION 'City is not active';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('client_op:' || v_uid::text), hashtext(p_operation_id::text));
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);

  SELECT result INTO v_existing
  FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  IF v_existing IS NOT NULL THEN
    IF (v_existing->>'city_id') IS DISTINCT FROM p_city_id::text
       OR (v_existing->>'product_id') IS DISTINCT FROM p_product_id::text
       OR (v_existing->>'qty_on_hand')::numeric IS DISTINCT FROM v_new THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT qty_on_hand INTO v_old
  FROM public.inventory
  WHERE city_id = p_city_id AND product_id = p_product_id
  FOR UPDATE;

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'Inventory row not found';
  END IF;

  v_delta := v_new - v_old;

  PERFORM public.inventory_set_physical(p_city_id, p_product_id, v_new);

  IF v_delta <> 0 THEN
    INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, created_by, note)
    VALUES (p_city_id, p_product_id, 'adjust', v_delta, v_uid, p_operation_id::text);
  END IF;

  INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
  VALUES (
    v_uid,
    p_operation_id,
    'inventory_adjust',
    'inventory',
    p_city_id::text || ':' || p_product_id::text,
    jsonb_build_object(
      'qty_on_hand', v_new,
      'qty_delta', v_delta,
      'city_id', p_city_id,
      'product_id', p_product_id
    )
  )
  ON CONFLICT (actor_id, operation_id) DO NOTHING;

  SELECT result INTO v_existing
  FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  RETURN COALESCE(v_existing, jsonb_build_object('qty_on_hand', v_new, 'qty_delta', v_delta));
END;
$$;


CREATE OR REPLACE FUNCTION public.apply_inventory_restock__session_body(p_operation_id uuid, p_city_id uuid, p_product_id uuid, p_qty numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_existing jsonb;
  v_new_qty numeric;
  v_qty numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_operation_id IS NULL OR p_city_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'Invalid restock payload';
  END IF;

  v_qty := round(COALESCE(p_qty, 0), 3);
  IF v_qty <= 0 THEN
    RAISE EXCEPTION 'Invalid qty';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admin can restock';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cities WHERE id = p_city_id AND COALESCE(is_active, true)
  ) THEN
    RAISE EXCEPTION 'City is not active';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('client_op:' || v_uid::text), hashtext(p_operation_id::text));
  PERFORM public.inventory_lock_sku(p_city_id, p_product_id);

  SELECT result INTO v_existing
  FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  IF v_existing IS NOT NULL THEN
    IF (v_existing->>'city_id') IS DISTINCT FROM p_city_id::text
       OR (v_existing->>'product_id') IS DISTINCT FROM p_product_id::text
       OR (v_existing->>'qty_added')::numeric IS DISTINCT FROM v_qty THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN v_existing;
  END IF;

  PERFORM public.inventory_add_physical(p_city_id, p_product_id, v_qty);
  SELECT qty_on_hand INTO v_new_qty
  FROM public.inventory
  WHERE city_id = p_city_id AND product_id = p_product_id;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Insufficient stock';
  END IF;

  INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, created_by, note)
  VALUES (p_city_id, p_product_id, 'restock', v_qty, v_uid, p_operation_id::text);

  INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
  VALUES (
    v_uid,
    p_operation_id,
    'inventory_restock',
    'inventory',
    p_city_id::text || ':' || p_product_id::text,
    jsonb_build_object(
      'qty_on_hand', v_new_qty,
      'qty_added', v_qty,
      'city_id', p_city_id,
      'product_id', p_product_id
    )
  )
  ON CONFLICT (actor_id, operation_id) DO NOTHING;

  SELECT result INTO v_existing
  FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  RETURN COALESCE(v_existing, jsonb_build_object('qty_on_hand', v_new_qty, 'qty_added', v_qty));
END;
$$;


CREATE OR REPLACE FUNCTION public.create_stock_transfer__session_body(p_operation_id uuid, p_from_city_id uuid, p_to_city_id uuid, p_items jsonb, p_comment text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_can_create boolean := false;
  v_existing jsonb;
  v_fp text;
  v_id uuid;
  v_number text;
  v_pid uuid;
  v_need numeric;
  v_upd int;
  v_payload jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.stock_transfer_require(false);
  IF p_operation_id IS NULL OR p_from_city_id IS NULL OR p_to_city_id IS NULL THEN
    RAISE EXCEPTION 'Invalid transfer payload';
  END IF;
  IF p_from_city_id = p_to_city_id THEN
    RAISE EXCEPTION 'Source and destination cities must differ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cities c WHERE c.id = p_from_city_id) THEN
    RAISE EXCEPTION 'Source city not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.cities c
    WHERE c.id = p_from_city_id AND COALESCE(c.is_active, true) IS TRUE
  ) THEN
    RAISE EXCEPTION 'Source city is inactive or not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cities c WHERE c.id = p_to_city_id) THEN
    RAISE EXCEPTION 'Destination city not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.cities c
    WHERE c.id = p_to_city_id AND COALESCE(c.is_active, true) IS TRUE
  ) THEN
    RAISE EXCEPTION 'Destination city is inactive or not found';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items in transfer';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id,
           'qty', s.qty
         ) ORDER BY s.product_id), '[]'::jsonb)
    INTO v_payload
  FROM (
    SELECT (e->>'product_id')::uuid AS product_id,
           round(SUM((e->>'qty')::numeric), 3) AS qty
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
  ) s;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_payload) e WHERE (e->>'qty')::numeric IS NULL OR (e->>'qty')::numeric <= 0) THEN
    RAISE EXCEPTION 'Invalid qty';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload) e
    WHERE NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = (e->>'product_id')::uuid)
  ) THEN
    RAISE EXCEPTION 'Unknown product';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload) e
    JOIN public.products p ON p.id = (e->>'product_id')::uuid
    WHERE p.is_active IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'Inactive product';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload) e
    JOIN public.products p ON p.id = (e->>'product_id')::uuid
    WHERE COALESCE(p.unit, '') IS DISTINCT FROM 'kg'
      AND (e->>'qty')::numeric <> trunc((e->>'qty')::numeric)
  ) THEN
    RAISE EXCEPTION 'Invalid qty';
  END IF;

  v_fp := public.stock_transfer_fingerprint(
    'create',
    jsonb_build_object(
      'from_city_id', p_from_city_id,
      'to_city_id', p_to_city_id,
      'comment', COALESCE(btrim(COALESCE(p_comment, '')), ''),
      'items', v_payload
    )
  );

  PERFORM pg_advisory_xact_lock(hashtext('client_op:' || v_uid::text), hashtext(p_operation_id::text));

  SELECT result INTO v_existing
  FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'fingerprint' IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN v_existing;
  END IF;

  FOR v_pid IN SELECT (e->>'product_id')::uuid FROM jsonb_array_elements(v_payload) e ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(p_from_city_id, v_pid);
  END LOOP;

  FOR v_pid, v_need IN
    SELECT (e->>'product_id')::uuid, (e->>'qty')::numeric
    FROM jsonb_array_elements(v_payload) e
    ORDER BY 1
  LOOP
    PERFORM public.inventory_deduct_available(p_from_city_id, v_pid, v_need);
  END LOOP;

  INSERT INTO public.stock_transfers (from_city_id, to_city_id, status, comment, created_by)
  VALUES (p_from_city_id, p_to_city_id, 'in_transit', NULLIF(btrim(COALESCE(p_comment, '')), ''), v_uid)
  RETURNING id, transfer_number INTO v_id, v_number;

  INSERT INTO public.stock_transfer_items (transfer_id, product_id, qty_sent)
  SELECT v_id, (e->>'product_id')::uuid, (e->>'qty')::numeric
  FROM jsonb_array_elements(v_payload) e;

  INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, created_by, note, transfer_id)
  SELECT p_from_city_id, (e->>'product_id')::uuid, 'transfer_out', -(e->>'qty')::numeric, v_uid, v_number, v_id
  FROM jsonb_array_elements(v_payload) e;

  INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)
  VALUES (v_id, 'created', v_uid, jsonb_build_object('transfer_number', v_number, 'items', v_payload));

  v_existing := jsonb_build_object(
    'id', v_id,
    'transfer_number', v_number,
    'status', 'in_transit',
    'fingerprint', v_fp
  );

  INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
  VALUES (v_uid, p_operation_id, 'stock_transfer_create', 'stock_transfer', v_id::text, v_existing)
  ON CONFLICT (actor_id, operation_id) DO NOTHING;

  SELECT result INTO v_existing FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  RETURN v_existing;
END;
$$;


CREATE OR REPLACE FUNCTION public.receive_stock_transfer__session_body(p_operation_id uuid, p_transfer_id uuid, p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_existing jsonb;
  v_fp text;
  v_tr record;
  v_payload jsonb;
  v_pid uuid;
  v_add numeric;
  v_remain numeric;
  v_already numeric;
  v_inc numeric;
  v_applied boolean := false;
  v_status text;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.stock_transfer_require(true);
  IF p_operation_id IS NULL OR p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'Invalid receive payload';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id,
           'qty', s.qty
         ) ORDER BY s.product_id), '[]'::jsonb)
    INTO v_payload
  FROM (
    SELECT (e->>'product_id')::uuid AS product_id,
           round(SUM(COALESCE(
             NULLIF(e->>'qty', '')::numeric,
             NULLIF(e->>'qty_received', '')::numeric,
             0
           )), 3) AS qty
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) e
    GROUP BY 1
  ) s
  WHERE s.qty > 0;

  IF v_payload IS NULL OR v_payload = '[]'::jsonb THEN
    RAISE EXCEPTION 'No items in receive';
  END IF;

  v_fp := public.stock_transfer_fingerprint(
    'receive',
    jsonb_build_object('transfer_id', p_transfer_id, 'items', v_payload)
  );

  PERFORM pg_advisory_xact_lock(hashtext('client_op:' || v_uid::text), hashtext(p_operation_id::text));

  SELECT result INTO v_existing
  FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'fingerprint' IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_tr FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_tr.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  PERFORM 1 FROM public.stock_transfer_items WHERE transfer_id = p_transfer_id ORDER BY product_id FOR UPDATE;
  IF v_tr.status = 'cancelled' THEN RAISE EXCEPTION 'Transfer is cancelled'; END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload) e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.stock_transfer_items i
      WHERE i.transfer_id = p_transfer_id AND i.product_id = (e->>'product_id')::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Unknown product in receive payload';
  END IF;

  SELECT COALESCE(SUM(public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)), 0)
    INTO v_remain
  FROM public.stock_transfer_items
  WHERE transfer_id = p_transfer_id;

  IF v_remain <= 0 THEN
    v_result := jsonb_build_object(
      'id', v_tr.id,
      'transfer_number', v_tr.transfer_number,
      'status', v_tr.status,
      'fingerprint', v_fp
    );
    INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
    VALUES (v_uid, p_operation_id, 'stock_transfer_receive', 'stock_transfer', v_tr.id::text, v_result)
    ON CONFLICT (actor_id, operation_id) DO NOTHING;
    SELECT result INTO v_existing FROM public.client_operations
    WHERE actor_id = v_uid AND operation_id = p_operation_id;
    RETURN v_existing;
  END IF;

  FOR v_pid IN
    SELECT (e->>'product_id')::uuid FROM jsonb_array_elements(v_payload) e ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(v_tr.to_city_id, v_pid);
  END LOOP;

  FOR v_pid, v_add IN
    SELECT (e->>'product_id')::uuid, (e->>'qty')::numeric
    FROM jsonb_array_elements(v_payload) e
    ORDER BY 1
  LOOP
    SELECT public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned),
           COALESCE(qty_received, 0)
      INTO v_remain, v_already
    FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id AND product_id = v_pid;
    IF v_add IS NULL OR v_add < 0 THEN RAISE EXCEPTION 'Invalid qty'; END IF;
    -- New UI sends this-batch qty (<= remaining). Deployed UI may send cumulative totals.
    IF v_add > v_remain THEN
      v_inc := round(v_add - v_already, 3);
    ELSE
      v_inc := v_add;
    END IF;
    IF v_inc < 0 THEN RAISE EXCEPTION 'Invalid qty'; END IF;
    IF v_inc > v_remain THEN RAISE EXCEPTION 'Received qty exceeds remaining in transit'; END IF;
    IF v_inc = 0 THEN CONTINUE; END IF;

    UPDATE public.stock_transfer_items
    SET qty_received = COALESCE(qty_received, 0) + v_inc
    WHERE transfer_id = p_transfer_id AND product_id = v_pid;

    PERFORM public.inventory_add_physical(v_tr.to_city_id, v_pid, v_inc);
    INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, created_by, note, transfer_id)
    VALUES (v_tr.to_city_id, v_pid, 'transfer_in', v_inc, v_uid, v_tr.transfer_number, v_tr.id);
    v_applied := true;
  END LOOP;

  IF NOT v_applied THEN
    v_result := jsonb_build_object(
      'id', v_tr.id,
      'transfer_number', v_tr.transfer_number,
      'status', v_tr.status,
      'fingerprint', v_fp
    );
    INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
    VALUES (v_uid, p_operation_id, 'stock_transfer_receive', 'stock_transfer', v_tr.id::text, v_result)
    ON CONFLICT (actor_id, operation_id) DO NOTHING;
    SELECT result INTO v_existing FROM public.client_operations
    WHERE actor_id = v_uid AND operation_id = p_operation_id;
    RETURN v_existing;
  END IF;

  v_status := public.stock_transfer_close_status(p_transfer_id);
  UPDATE public.stock_transfers
  SET status = v_status,
      received_by = v_uid,
      received_at = now(),
      updated_at = now()
  WHERE id = p_transfer_id;

  INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)
  VALUES (p_transfer_id, 'received_partial', v_uid, jsonb_build_object('items', v_payload, 'status', v_status));

  v_result := jsonb_build_object(
    'id', p_transfer_id,
    'transfer_number', v_tr.transfer_number,
    'status', v_status,
    'fingerprint', v_fp
  );
  INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
  VALUES (v_uid, p_operation_id, 'stock_transfer_receive', 'stock_transfer', p_transfer_id::text, v_result)
  ON CONFLICT (actor_id, operation_id) DO NOTHING;
  SELECT result INTO v_existing FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  RETURN v_existing;
END;
$$;


CREATE OR REPLACE FUNCTION public.cancel_stock_transfer__session_body(p_operation_id uuid, p_transfer_id uuid, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_existing jsonb;
  v_fp text;
  v_tr record;
  v_pid uuid;
  v_remain numeric;
  v_reason text;
  v_status text;
  v_result jsonb;
  v_returned jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.stock_transfer_require(true);
  IF p_operation_id IS NULL OR p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'Invalid cancel payload';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_fp := public.stock_transfer_fingerprint(
    'cancel',
    jsonb_build_object('transfer_id', p_transfer_id, 'reason', COALESCE(v_reason, ''))
  );

  PERFORM pg_advisory_xact_lock(hashtext('client_op:' || v_uid::text), hashtext(p_operation_id::text));

  SELECT result INTO v_existing
  FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'fingerprint' IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_tr FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_tr.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  PERFORM 1 FROM public.stock_transfer_items WHERE transfer_id = p_transfer_id ORDER BY product_id FOR UPDATE;

  SELECT COALESCE(SUM(public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)), 0)
    INTO v_remain
  FROM public.stock_transfer_items
  WHERE transfer_id = p_transfer_id;

  IF v_tr.status = 'cancelled' OR v_remain <= 0 THEN
    IF v_remain <= 0 AND v_tr.status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'Received transfer cannot be cancelled';
    END IF;
    v_result := jsonb_build_object(
      'id', v_tr.id,
      'transfer_number', v_tr.transfer_number,
      'status', v_tr.status,
      'fingerprint', v_fp
    );
    INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
    VALUES (v_uid, p_operation_id, 'stock_transfer_cancel', 'stock_transfer', v_tr.id::text, v_result)
    ON CONFLICT (actor_id, operation_id) DO NOTHING;
    SELECT result INTO v_existing FROM public.client_operations
    WHERE actor_id = v_uid AND operation_id = p_operation_id;
    RETURN v_existing;
  END IF;

  FOR v_pid IN
    SELECT product_id FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id
      AND public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned) > 0
    ORDER BY product_id
  LOOP
    PERFORM public.inventory_lock_sku(v_tr.from_city_id, v_pid);
  END LOOP;

  FOR v_pid, v_remain IN
    SELECT product_id, public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)
    FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id
    ORDER BY product_id
  LOOP
    IF v_remain <= 0 THEN CONTINUE; END IF;
    PERFORM public.inventory_add_physical(v_tr.from_city_id, v_pid, v_remain);
    INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, created_by, note, transfer_id)
    VALUES (v_tr.from_city_id, v_pid, 'transfer_cancel', v_remain, v_uid, v_tr.transfer_number, v_tr.id);
    UPDATE public.stock_transfer_items
    SET qty_returned = qty_returned + v_remain
    WHERE transfer_id = p_transfer_id AND product_id = v_pid;
    v_returned := v_returned || jsonb_build_array(jsonb_build_object('product_id', v_pid, 'qty', v_remain));
  END LOOP;

  v_status := public.stock_transfer_close_status(p_transfer_id);
  UPDATE public.stock_transfers
  SET status = v_status,
      cancelled_by = v_uid,
      cancelled_at = now(),
      cancelled_reason = v_reason,
      updated_at = now()
  WHERE id = p_transfer_id;

  INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)
  VALUES (
    p_transfer_id,
    'cancelled',
    v_uid,
    jsonb_build_object('reason', v_reason, 'returned', v_returned, 'status', v_status)
  );

  v_result := jsonb_build_object(
    'id', p_transfer_id,
    'transfer_number', v_tr.transfer_number,
    'status', v_status,
    'fingerprint', v_fp
  );
  INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
  VALUES (v_uid, p_operation_id, 'stock_transfer_cancel', 'stock_transfer', p_transfer_id::text, v_result)
  ON CONFLICT (actor_id, operation_id) DO NOTHING;
  SELECT result INTO v_existing FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  RETURN v_existing;
END;
$$;


CREATE OR REPLACE FUNCTION public.admin_seller_goods_issue_post(p_operation_id uuid, p_seller_id uuid, p_city_id uuid, p_items jsonb, p_comment text, p_issue_kind text, p_accrued_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
DECLARE
  v_uid uuid;
  v_comment text;
  v_kind text;
  v_role text;
  v_existing public.seller_goods_issues%ROWTYPE;
  v_issue_id uuid;
  v_ledger public.seller_ledger%ROWTYPE;
  v_balance numeric(12,2);
  v_credit numeric(12,2) := 0;
  v_at timestamptz;
  v_pid uuid;
  v_qty numeric(12,3);
  v_unit numeric(12,2);
  v_line numeric(12,2);
  v_cost numeric(12,2);
  v_upd integer;
  v_n integer;
  v_dup integer;
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_operation_id IS NULL OR p_seller_id IS NULL OR p_city_id IS NULL THEN
    RAISE EXCEPTION 'Invalid seller goods payload';
  END IF;
  v_kind := btrim(COALESCE(p_issue_kind, ''));
  IF v_kind IS DISTINCT FROM 'settlement' AND v_kind IS DISTINCT FROM 'advance' THEN
    RAISE EXCEPTION 'Invalid seller goods payload';
  END IF;
  v_comment := NULLIF(btrim(COALESCE(p_comment, '')), '');
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_seller_id;
  IF v_role IS DISTINCT FROM 'seller' THEN
    RAISE EXCEPTION 'Seller not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cities c WHERE c.id = p_city_id) THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;
  IF p_accrued_at IS NOT NULL AND p_accrued_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Operation date cannot be in the future';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) < 1 THEN
    RAISE EXCEPTION 'Goods issue requires at least one item';
  END IF;

  SELECT count(*), count(DISTINCT (e->>'product_id'))
    INTO v_n, v_dup
  FROM jsonb_array_elements(p_items) e;
  IF v_n IS DISTINCT FROM v_dup THEN
    RAISE EXCEPTION 'Duplicate product in goods issue';
  END IF;

  PERFORM pg_advisory_xact_lock(51730611, hashtext(p_operation_id::text));
  PERFORM pg_advisory_xact_lock(51730312, hashtext(p_seller_id::text));

  SELECT * INTO v_existing
  FROM public.seller_goods_issues
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.reversal_of IS NOT NULL THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    v_credit := v_existing.credit_amount;
    IF NOT public.seller_goods_issue_payload_matches(
         v_existing.id, p_seller_id, p_city_id, v_kind, v_comment, v_uid, v_credit, p_items
       ) THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    IF p_accrued_at IS NOT NULL THEN
      SELECT l.accrued_at INTO v_at FROM public.seller_ledger l WHERE l.id = v_existing.ledger_id;
      IF v_at IS DISTINCT FROM p_accrued_at THEN
        RAISE EXCEPTION 'Idempotency key reused with a different payload';
      END IF;
    END IF;
    RETURN public.seller_goods_issue_to_json(v_existing.id);
  END IF;

  FOR v_pid IN
    SELECT (e->>'product_id')::uuid
    FROM jsonb_array_elements(p_items) e
    ORDER BY 1
  LOOP
    PERFORM public.inventory_lock_sku(p_city_id, v_pid);
  END LOOP;

  v_at := COALESCE(p_accrued_at, clock_timestamp());
  IF v_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Operation date cannot be in the future';
  END IF;

  FOR v_pid, v_qty, v_unit IN
    SELECT (e->>'product_id')::uuid,
           round((e->>'qty')::numeric, 3),
           round((e->>'unit_credit_amount')::numeric, 2)
    FROM jsonb_array_elements(p_items) e
    ORDER BY 1
  LOOP
    IF v_pid IS NULL THEN
      RAISE EXCEPTION 'Invalid goods issue item';
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid qty for product %', v_pid;
    END IF;
    IF v_unit IS NULL OR v_unit < 0 THEN
      RAISE EXCEPTION 'Invalid unit credit for product %', v_pid;
    END IF;
    v_line := round(v_qty * v_unit, 2);
    v_credit := v_credit + v_line;
    SELECT pr.cost_price INTO v_cost
    FROM public.products pr
    WHERE pr.id = v_pid
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found %', v_pid;
    END IF;
    IF v_cost IS NULL THEN
      RAISE EXCEPTION 'Product cost is required';
    END IF;
    PERFORM 1 FROM public.inventory
    WHERE city_id = p_city_id AND product_id = v_pid
    FOR UPDATE;
  END LOOP;

  IF v_credit <= 0 THEN
    RAISE EXCEPTION 'Credit amount must be greater than 0';
  END IF;

  v_balance := public.seller_ledger_balance(p_seller_id);
  IF v_kind = 'settlement' AND v_balance < v_credit THEN
    RAISE EXCEPTION 'Goods issue exceeds available balance';
  END IF;

  BEGIN
    INSERT INTO public.seller_goods_issues (
      operation_id, seller_id, city_id, credit_amount, actor_id, comment, issue_kind
    ) VALUES (
      p_operation_id, p_seller_id, p_city_id, v_credit, v_uid, v_comment, v_kind
    )
    RETURNING id INTO v_issue_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_existing
      FROM public.seller_goods_issues
      WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF v_existing.reversal_of IS NOT NULL THEN
          RAISE EXCEPTION 'Idempotency key reused with a different payload';
        END IF;
        IF NOT public.seller_goods_issue_payload_matches(
             v_existing.id, p_seller_id, p_city_id, v_kind, v_comment, v_uid, v_existing.credit_amount, p_items
           ) THEN
          RAISE EXCEPTION 'Idempotency key reused with a different payload';
        END IF;
        RETURN public.seller_goods_issue_to_json(v_existing.id, true);
      END IF;
      RAISE;
  END;

  FOR v_pid, v_qty, v_unit IN
    SELECT (e->>'product_id')::uuid,
           round((e->>'qty')::numeric, 3),
           round((e->>'unit_credit_amount')::numeric, 2)
    FROM jsonb_array_elements(p_items) e
    ORDER BY 1
  LOOP
    SELECT pr.cost_price INTO v_cost FROM public.products pr WHERE pr.id = v_pid;
    v_line := round(v_qty * v_unit, 2);
    INSERT INTO public.seller_goods_issue_items (
      issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
    ) VALUES (
      v_issue_id, v_pid, v_qty, v_unit, v_line, v_cost
    );
    PERFORM public.inventory_deduct_available(p_city_id, v_pid, v_qty);
    INSERT INTO public.inventory_movements (
      city_id, product_id, type, qty_delta, created_by, note
    ) VALUES (
      p_city_id, v_pid, 'seller_goods_out', -v_qty, v_uid,
      (SELECT issue_number FROM public.seller_goods_issues WHERE id = v_issue_id)
    );
  END LOOP;

  v_ledger := public.seller_ledger_post_internal(
    p_operation_id,
    p_seller_id,
    'goods_issue',
    -v_credit,
    NULL, NULL, NULL, NULL, NULL, NULL,
    false, NULL, v_issue_id, v_at, v_uid, v_comment
  );

  UPDATE public.seller_goods_issues
  SET ledger_id = v_ledger.id
  WHERE id = v_issue_id
    AND ledger_id IS NULL;

  RETURN public.seller_goods_issue_to_json(v_issue_id);
END;
$$;


CREATE OR REPLACE FUNCTION public.admin_seller_goods_return__session_body(p_operation_id uuid, p_issue_id uuid, p_received boolean, p_comment text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
DECLARE
  v_uid uuid;
  v_comment text;
  v_orig public.seller_goods_issues%ROWTYPE;
  v_existing public.seller_goods_issues%ROWTYPE;
  v_return_id uuid;
  v_ledger public.seller_ledger%ROWTYPE;
  v_pid uuid;
  v_qty numeric(12,3);
  v_unit numeric(12,2);
  v_line numeric(12,2);
  v_cost numeric(12,2);
BEGIN
  v_uid := public.seller_commission_require_active_admin();
  IF p_operation_id IS NULL OR p_issue_id IS NULL THEN
    RAISE EXCEPTION 'Invalid seller goods return payload';
  END IF;
  IF p_received IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Physical receipt must be confirmed';
  END IF;
  v_comment := NULLIF(btrim(COALESCE(p_comment, '')), '');

  PERFORM pg_advisory_xact_lock(51730611, hashtext(p_operation_id::text));

  SELECT * INTO v_orig FROM public.seller_goods_issues WHERE id = p_issue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods issue not found';
  END IF;
  PERFORM pg_advisory_xact_lock(51730312, hashtext(v_orig.seller_id::text));

  SELECT * INTO v_orig
  FROM public.seller_goods_issues
  WHERE id = p_issue_id
  FOR UPDATE;

  SELECT * INTO v_existing
  FROM public.seller_goods_issues
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.reversal_of IS DISTINCT FROM p_issue_id
       OR v_existing.actor_id IS DISTINCT FROM v_uid
       OR v_existing.comment IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION 'Idempotency key reused with a different payload';
    END IF;
    RETURN public.seller_goods_issue_to_json(v_existing.id);
  END IF;

  IF v_orig.reversal_of IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot return a goods return document';
  END IF;
  IF v_orig.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Goods issue already returned';
  END IF;
  IF v_orig.ledger_id IS NULL THEN
    RAISE EXCEPTION 'Goods issue ledger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.seller_goods_issue_items WHERE issue_id = p_issue_id) THEN
    RAISE EXCEPTION 'Goods issue has no items to return';
  END IF;

  FOR v_pid IN
    SELECT i.product_id FROM public.seller_goods_issue_items i
    WHERE i.issue_id = p_issue_id
    ORDER BY i.product_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('inv:' || v_orig.city_id::text), hashtext(v_pid::text));
  END LOOP;

  FOR v_pid IN
    SELECT i.product_id FROM public.seller_goods_issue_items i
    WHERE i.issue_id = p_issue_id
    ORDER BY i.product_id
  LOOP
    PERFORM 1 FROM public.inventory
    WHERE city_id = v_orig.city_id AND product_id = v_pid
    FOR UPDATE;
  END LOOP;

  BEGIN
    INSERT INTO public.seller_goods_issues (
      operation_id, seller_id, city_id, credit_amount, actor_id, comment,
      issue_kind, reversal_of
    ) VALUES (
      p_operation_id, v_orig.seller_id, v_orig.city_id, v_orig.credit_amount, v_uid, v_comment,
      v_orig.issue_kind, p_issue_id
    )
    RETURNING id INTO v_return_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_existing
      FROM public.seller_goods_issues
      WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF v_existing.reversal_of IS DISTINCT FROM p_issue_id
           OR v_existing.actor_id IS DISTINCT FROM v_uid
           OR v_existing.comment IS DISTINCT FROM v_comment THEN
          RAISE EXCEPTION 'Idempotency key reused with a different payload';
        END IF;
        RETURN public.seller_goods_issue_to_json(v_existing.id, true);
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.seller_goods_issues WHERE reversal_of = p_issue_id
      ) THEN
        RAISE EXCEPTION 'Goods issue already returned';
      END IF;
      RAISE;
  END;

  FOR v_pid, v_qty, v_unit, v_line, v_cost IN
    SELECT i.product_id, i.qty, i.unit_credit_amount, i.line_credit_amount, i.cost_price_snapshot
    FROM public.seller_goods_issue_items i
    WHERE i.issue_id = p_issue_id
    ORDER BY i.product_id
  LOOP
    INSERT INTO public.seller_goods_issue_items (
      issue_id, product_id, qty, unit_credit_amount, line_credit_amount, cost_price_snapshot
    ) VALUES (
      v_return_id, v_pid, v_qty, v_unit, v_line, v_cost
    );
    PERFORM public.inventory_lock_sku(v_orig.city_id, v_pid);
    PERFORM public.inventory_add_physical(v_orig.city_id, v_pid, v_qty);
    INSERT INTO public.inventory_movements (
      city_id, product_id, type, qty_delta, created_by, note
    ) VALUES (
      v_orig.city_id, v_pid, 'seller_goods_in', v_qty, v_uid,
      (SELECT issue_number FROM public.seller_goods_issues WHERE id = v_return_id)
    );
  END LOOP;

  v_ledger := public.seller_ledger_post_internal(
    p_operation_id,
    v_orig.seller_id,
    'goods_reversal',
    v_orig.credit_amount,
    NULL, NULL, NULL, NULL, NULL, NULL,
    false, v_orig.ledger_id, v_return_id, clock_timestamp(), v_uid, v_comment
  );

  UPDATE public.seller_goods_issues
  SET ledger_id = v_ledger.id
  WHERE id = v_return_id
    AND ledger_id IS NULL;

  UPDATE public.seller_goods_issues
  SET reversed_at = clock_timestamp()
  WHERE id = p_issue_id
    AND reversed_at IS NULL;

  RETURN public.seller_goods_issue_to_json(v_return_id);
END;
$$;


DO $grant$
DECLARE
  v_select text;
BEGIN
  SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_select
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'order_items'
    AND c.column_name IS DISTINCT FROM 'cost_price_snapshot';
  IF v_select IS NULL OR v_select NOT LIKE '%qty_reserved%' THEN
    RAISE EXCEPTION 'order_items.qty_reserved must be selectable';
  END IF;
  EXECUTE format('GRANT SELECT (%s) ON TABLE public.order_items TO authenticated', v_select);
END
$grant$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.order_items FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory FROM anon, authenticated;

SELECT public.inventory_backfill_pending_preorder_reserves();

DO $wrap$
BEGIN
  IF to_regprocedure('public.confirm_order(jsonb)') IS NOT NULL
     AND pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)'))
         NOT LIKE '%assert_active_auth_session%' THEN
    RAISE EXCEPTION 'P0/Phase2 abort: confirm_order wrapper missing session assert';
  END IF;
  IF to_regprocedure('public.fulfill_preorder(uuid)') IS NOT NULL
     AND pg_get_functiondef(to_regprocedure('public.fulfill_preorder(uuid)'))
         NOT LIKE '%assert_active_auth_session%' THEN
    RAISE EXCEPTION 'P0/Phase2 abort: fulfill_preorder wrapper missing session assert';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.receive_stock_transfer__session_body(uuid, uuid, jsonb)'))
     LIKE '%fulfill_preorder%' THEN
    RAISE EXCEPTION 'receive must not fulfill preorders';
  END IF;
END
$wrap$;

COMMIT;
