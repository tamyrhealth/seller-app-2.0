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
