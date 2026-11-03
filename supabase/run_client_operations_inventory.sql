-- Atomic restock/adjust with client operation_id idempotency.
-- Closes direct client writes to inventory / inventory_movements.
-- Does not implement warehouse transfers.
-- Does not touch cities.is_active. No DELETE of business rows.
-- Do not apply to production until explicitly allowed.

BEGIN;

CREATE TABLE IF NOT EXISTS public.client_operations (
  actor_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  operation_type text NOT NULL,
  entity_type text,
  entity_id text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE INDEX IF NOT EXISTS client_operations_type_idx
  ON public.client_operations (operation_type, created_at DESC);

ALTER TABLE public.client_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_operations_select_own ON public.client_operations;
CREATE POLICY client_operations_select_own
  ON public.client_operations FOR SELECT TO authenticated
  USING (actor_id = auth.uid() OR public.get_user_role() = 'admin');

REVOKE ALL ON TABLE public.client_operations FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.client_operations TO authenticated;
GRANT ALL ON TABLE public.client_operations TO postgres, service_role;

-- Admin/seller must not change stock from the browser. Order RPCs are SECURITY DEFINER.
DROP POLICY IF EXISTS inventory_admin_all ON public.inventory;
DROP POLICY IF EXISTS inventory_seller_update ON public.inventory;
DROP POLICY IF EXISTS inventory_admin_select ON public.inventory;
DROP POLICY IF EXISTS movements_admin ON public.inventory_movements;
DROP POLICY IF EXISTS movements_insert ON public.inventory_movements;
DROP POLICY IF EXISTS movements_admin_select ON public.inventory_movements;

CREATE POLICY inventory_admin_select ON public.inventory
  FOR SELECT TO authenticated
  USING (public.get_user_role() = 'admin');

CREATE POLICY movements_admin_select ON public.inventory_movements
  FOR SELECT TO authenticated
  USING (public.get_user_role() = 'admin');

CREATE OR REPLACE FUNCTION public.apply_inventory_restock(
  p_operation_id uuid,
  p_city_id uuid,
  p_product_id uuid,
  p_qty numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  PERFORM pg_advisory_xact_lock(hashtext('inv:' || p_city_id::text), hashtext(p_product_id::text));

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

  PERFORM 1 FROM public.inventory
  WHERE city_id = p_city_id AND product_id = p_product_id
  FOR UPDATE;

  INSERT INTO public.inventory (city_id, product_id, qty_on_hand, updated_at)
  VALUES (p_city_id, p_product_id, v_qty, now())
  ON CONFLICT (city_id, product_id) DO UPDATE
    SET qty_on_hand = public.inventory.qty_on_hand + EXCLUDED.qty_on_hand,
        updated_at = now()
  RETURNING qty_on_hand INTO v_new_qty;

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

CREATE OR REPLACE FUNCTION public.apply_inventory_adjust(
  p_operation_id uuid,
  p_city_id uuid,
  p_product_id uuid,
  p_new_qty numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  PERFORM pg_advisory_xact_lock(hashtext('inv:' || p_city_id::text), hashtext(p_product_id::text));

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

  UPDATE public.inventory
  SET qty_on_hand = v_new, updated_at = now()
  WHERE city_id = p_city_id AND product_id = p_product_id;

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

REVOKE ALL ON FUNCTION public.apply_inventory_restock(uuid, uuid, uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_inventory_adjust(uuid, uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_restock(uuid, uuid, uuid, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_inventory_adjust(uuid, uuid, uuid, numeric) TO authenticated, service_role;

COMMIT;
