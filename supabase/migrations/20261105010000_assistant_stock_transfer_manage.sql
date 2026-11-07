-- Block 5.2.6: manager can_manage_transfers + receive/cancel/shortage via existing RPCs.
-- Does not rewrite restock/adjust, confirm_order, or transfer numbering.
-- Do not apply until explicitly allowed.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_transfers boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.profiles_prevent_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.role IS DISTINCT FROM 'seller' THEN
      RAISE EXCEPTION 'Not allowed to change role';
    END IF;
    IF COALESCE(NEW.can_cancel_orders, false) IS TRUE THEN
      RAISE EXCEPTION 'Not allowed to change cancel permission';
    END IF;
    IF COALESCE(NEW.can_create_transfers, false) IS TRUE THEN
      RAISE EXCEPTION 'Not allowed to change transfer permission';
    END IF;
    IF COALESCE(NEW.can_manage_transfers, false) IS TRUE THEN
      RAISE EXCEPTION 'Not allowed to change transfer manage permission';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Not allowed to change role';
  END IF;
  IF NEW.can_cancel_orders IS DISTINCT FROM OLD.can_cancel_orders THEN
    RAISE EXCEPTION 'Not allowed to change cancel permission';
  END IF;
  IF NEW.can_create_transfers IS DISTINCT FROM OLD.can_create_transfers THEN
    RAISE EXCEPTION 'Not allowed to change transfer permission';
  END IF;
  IF NEW.can_manage_transfers IS DISTINCT FROM OLD.can_manage_transfers THEN
    RAISE EXCEPTION 'Not allowed to change transfer manage permission';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_prevent_privilege_escalation ON public.profiles;
CREATE TRIGGER profiles_prevent_privilege_escalation
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_prevent_privilege_escalation();

CREATE OR REPLACE FUNCTION public.stock_transfer_require(p_need_manage boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_active boolean := false;
  v_create boolean := false;
  v_manage boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT p.role, COALESCE(p.is_active, false), COALESCE(p.can_create_transfers, false), COALESCE(p.can_manage_transfers, false)
    INTO v_role, v_active, v_create, v_manage
  FROM public.profiles p
  WHERE p.id = v_uid;
  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Account is inactive';
  END IF;
  IF v_role = 'admin' THEN
    RETURN;
  END IF;
  IF v_role IS DISTINCT FROM 'manager' THEN
    RAISE EXCEPTION 'Transfer permission denied';
  END IF;
  IF p_need_manage THEN
    IF v_manage IS NOT TRUE THEN
      RAISE EXCEPTION 'Transfer manage permission denied';
    END IF;
  ELSIF v_create IS NOT TRUE AND v_manage IS NOT TRUE THEN
    RAISE EXCEPTION 'Transfer permission denied';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_transfer_require(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_transfer_require(boolean) TO postgres, service_role;

DROP POLICY IF EXISTS stock_transfers_select ON public.stock_transfers;
CREATE POLICY stock_transfers_select ON public.stock_transfers
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = 'admin'
    OR created_by = auth.uid()
    OR (
      public.get_user_role() = 'manager'
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND COALESCE(p.can_manage_transfers, false) IS TRUE
      )
    )
  );

DROP POLICY IF EXISTS stock_transfer_items_select ON public.stock_transfer_items;
CREATE POLICY stock_transfer_items_select ON public.stock_transfer_items
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = stock_transfer_items.transfer_id
        AND t.created_by = auth.uid()
    )
    OR (
      public.get_user_role() = 'manager'
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND COALESCE(p.can_manage_transfers, false) IS TRUE
      )
    )
  );

DROP POLICY IF EXISTS stock_transfer_events_select ON public.stock_transfer_events;
CREATE POLICY stock_transfer_events_select ON public.stock_transfer_events
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = stock_transfer_events.transfer_id
        AND t.created_by = auth.uid()
    )
    OR (
      public.get_user_role() = 'manager'
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND COALESCE(p.can_manage_transfers, false) IS TRUE
      )
    )
  );

CREATE OR REPLACE FUNCTION public.create_stock_transfer(
  p_operation_id uuid,
  p_from_city_id uuid,
  p_to_city_id uuid,
  p_items jsonb,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    PERFORM pg_advisory_xact_lock(hashtext('inv:' || p_from_city_id::text), hashtext(v_pid::text));
    PERFORM 1 FROM public.inventory
    WHERE city_id = p_from_city_id AND product_id = v_pid
    FOR UPDATE;
  END LOOP;

  FOR v_pid, v_need IN
    SELECT (e->>'product_id')::uuid, (e->>'qty')::numeric
    FROM jsonb_array_elements(v_payload) e
    ORDER BY 1
  LOOP
    UPDATE public.inventory
    SET qty_on_hand = qty_on_hand - v_need, updated_at = now()
    WHERE city_id = p_from_city_id AND product_id = v_pid AND qty_on_hand >= v_need;
    GET DIAGNOSTICS v_upd = ROW_COUNT;
    IF v_upd = 0 THEN
      RAISE EXCEPTION 'Insufficient stock';
    END IF;
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

CREATE OR REPLACE FUNCTION public.receive_stock_transfer(
  p_operation_id uuid,
  p_transfer_id uuid,
  p_items jsonb
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
    PERFORM pg_advisory_xact_lock(hashtext('inv:' || v_tr.to_city_id::text), hashtext(v_pid::text));
    PERFORM 1 FROM public.inventory
    WHERE city_id = v_tr.to_city_id AND product_id = v_pid
    FOR UPDATE;
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

    INSERT INTO public.inventory (city_id, product_id, qty_on_hand, updated_at)
    VALUES (v_tr.to_city_id, v_pid, v_inc, now())
    ON CONFLICT (city_id, product_id) DO UPDATE
      SET qty_on_hand = public.inventory.qty_on_hand + EXCLUDED.qty_on_hand,
          updated_at = now();
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

CREATE OR REPLACE FUNCTION public.write_off_stock_transfer_shortage(
  p_operation_id uuid,
  p_transfer_id uuid,
  p_items jsonb,
  p_reason text
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
  v_fp text;
  v_tr record;
  v_payload jsonb;
  v_snapshot jsonb;
  v_pid uuid;
  v_add numeric;
  v_remain numeric;
  v_reason text;
  v_status text;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.stock_transfer_require(true);
  IF p_operation_id IS NULL OR p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'Invalid write-off payload';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Shortage reason is required'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id,
           'qty', s.qty
         ) ORDER BY s.product_id), '[]'::jsonb)
    INTO v_payload
  FROM (
    SELECT (e->>'product_id')::uuid AS product_id,
           round(SUM(COALESCE(
             NULLIF(e->>'qty', '')::numeric,
             NULLIF(e->>'qty_lost', '')::numeric,
             0
           )), 3) AS qty
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) e
    GROUP BY 1
  ) s
  WHERE s.qty > 0;

  IF v_payload IS NULL OR v_payload = '[]'::jsonb THEN
    RAISE EXCEPTION 'No items in write-off';
  END IF;

  v_fp := public.stock_transfer_fingerprint(
    'shortage',
    jsonb_build_object('transfer_id', p_transfer_id, 'reason', v_reason, 'items', v_payload)
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

  SELECT COALESCE(SUM(public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)), 0)
    INTO v_remain
  FROM public.stock_transfer_items
  WHERE transfer_id = p_transfer_id;
  IF v_remain <= 0 THEN
    RAISE EXCEPTION 'No remaining quantity to write off';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload) e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.stock_transfer_items i
      WHERE i.transfer_id = p_transfer_id AND i.product_id = (e->>'product_id')::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Unknown product in write-off payload';
  END IF;

  FOR v_pid, v_add IN
    SELECT (e->>'product_id')::uuid, (e->>'qty')::numeric
    FROM jsonb_array_elements(v_payload) e
    ORDER BY 1
  LOOP
    SELECT public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)
      INTO v_remain
    FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id AND product_id = v_pid;
    IF v_add IS NULL OR v_add <= 0 THEN RAISE EXCEPTION 'Invalid qty'; END IF;
    IF v_add > v_remain THEN RAISE EXCEPTION 'Write-off qty exceeds remaining in transit'; END IF;
    UPDATE public.stock_transfer_items
    SET qty_lost = qty_lost + v_add
    WHERE transfer_id = p_transfer_id AND product_id = v_pid;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', (e->>'product_id')::uuid,
           'qty', (e->>'qty')::numeric,
           'unit_cost', to_jsonb(p.cost_price)
         ) ORDER BY (e->>'product_id')), '[]'::jsonb)
    INTO v_snapshot
  FROM jsonb_array_elements(v_payload) e
  LEFT JOIN public.products p ON p.id = (e->>'product_id')::uuid;

  v_status := public.stock_transfer_close_status(p_transfer_id);
  UPDATE public.stock_transfers
  SET status = v_status, updated_at = now()
  WHERE id = p_transfer_id;

  INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)
  VALUES (
    p_transfer_id,
    'shortage',
    v_uid,
    jsonb_build_object('items', v_snapshot, 'reason', v_reason, 'status', v_status)
  );

  v_result := jsonb_build_object(
    'id', p_transfer_id,
    'transfer_number', v_tr.transfer_number,
    'status', v_status,
    'fingerprint', v_fp
  );
  INSERT INTO public.client_operations (actor_id, operation_id, operation_type, entity_type, entity_id, result)
  VALUES (v_uid, p_operation_id, 'stock_transfer_shortage', 'stock_transfer', p_transfer_id::text, v_result)
  ON CONFLICT (actor_id, operation_id) DO NOTHING;
  SELECT result INTO v_existing FROM public.client_operations
  WHERE actor_id = v_uid AND operation_id = p_operation_id;
  RETURN v_existing;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_stock_transfer(
  p_operation_id uuid,
  p_transfer_id uuid,
  p_reason text DEFAULT NULL
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
    PERFORM pg_advisory_xact_lock(hashtext('inv:' || v_tr.from_city_id::text), hashtext(v_pid::text));
    PERFORM 1 FROM public.inventory
    WHERE city_id = v_tr.from_city_id AND product_id = v_pid
    FOR UPDATE;
  END LOOP;

  FOR v_pid, v_remain IN
    SELECT product_id, public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)
    FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id
    ORDER BY product_id
  LOOP
    IF v_remain <= 0 THEN CONTINUE; END IF;
    INSERT INTO public.inventory (city_id, product_id, qty_on_hand, updated_at)
    VALUES (v_tr.from_city_id, v_pid, v_remain, now())
    ON CONFLICT (city_id, product_id) DO UPDATE
      SET qty_on_hand = public.inventory.qty_on_hand + EXCLUDED.qty_on_hand,
          updated_at = now();
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

REVOKE ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_stock_transfer(uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_stock_transfer(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_stock_transfer(uuid, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_stock_transfer(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text) TO authenticated, service_role;

COMMIT;
