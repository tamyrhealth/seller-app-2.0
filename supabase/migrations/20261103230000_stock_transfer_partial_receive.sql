-- Partial receive: leftover stays in transit until received, returned, or written off.
-- Additive. Does not rewrite T000001/T000002 qty or status. Does not DELETE history.
-- Do not apply until explicitly allowed.

BEGIN;

ALTER TABLE public.stock_transfer_items
  ADD COLUMN IF NOT EXISTS qty_lost numeric(12,3) NOT NULL DEFAULT 0;
ALTER TABLE public.stock_transfer_items
  ADD COLUMN IF NOT EXISTS qty_returned numeric(12,3) NOT NULL DEFAULT 0;

ALTER TABLE public.stock_transfer_items
  DROP CONSTRAINT IF EXISTS stock_transfer_items_qty_lost_check;
ALTER TABLE public.stock_transfer_items
  ADD CONSTRAINT stock_transfer_items_qty_lost_check CHECK (qty_lost >= 0);

ALTER TABLE public.stock_transfer_items
  DROP CONSTRAINT IF EXISTS stock_transfer_items_qty_returned_check;
ALTER TABLE public.stock_transfer_items
  ADD CONSTRAINT stock_transfer_items_qty_returned_check CHECK (qty_returned >= 0);

ALTER TABLE public.stock_transfer_items
  DROP CONSTRAINT IF EXISTS stock_transfer_items_qty_balance_check;
ALTER TABLE public.stock_transfer_items
  ADD CONSTRAINT stock_transfer_items_qty_balance_check CHECK (
    qty_sent >= COALESCE(qty_received, 0) + qty_lost + qty_returned
  );

CREATE OR REPLACE FUNCTION public.stock_transfer_remaining(
  p_sent numeric,
  p_received numeric,
  p_lost numeric,
  p_returned numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT round(
    COALESCE(p_sent, 0)
    - COALESCE(p_received, 0)
    - COALESCE(p_lost, 0)
    - COALESCE(p_returned, 0),
    3
  );
$$;

CREATE OR REPLACE FUNCTION public.stock_transfer_close_status(p_transfer_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_remain numeric;
  v_lost numeric;
  v_received numeric;
  v_returned numeric;
BEGIN
  SELECT
    COALESCE(SUM(public.stock_transfer_remaining(qty_sent, qty_received, qty_lost, qty_returned)), 0),
    COALESCE(SUM(qty_lost), 0),
    COALESCE(SUM(COALESCE(qty_received, 0)), 0),
    COALESCE(SUM(qty_returned), 0)
  INTO v_remain, v_lost, v_received, v_returned
  FROM public.stock_transfer_items
  WHERE transfer_id = p_transfer_id;

  IF v_remain > 0 THEN
    RETURN 'in_transit';
  END IF;
  IF v_received = 0 AND v_lost = 0 THEN
    RETURN 'cancelled';
  END IF;
  IF v_lost > 0 THEN
    RETURN 'received_with_variance';
  END IF;
  RETURN 'received';
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
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin can receive transfers'; END IF;
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
  v_pid uuid;
  v_add numeric;
  v_remain numeric;
  v_reason text;
  v_status text;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin can write off transfer shortage'; END IF;
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

  v_status := public.stock_transfer_close_status(p_transfer_id);
  UPDATE public.stock_transfers
  SET status = v_status, updated_at = now()
  WHERE id = p_transfer_id;

  INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)
  VALUES (
    p_transfer_id,
    'shortage',
    v_uid,
    jsonb_build_object('items', v_payload, 'reason', v_reason, 'status', v_status)
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
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin can cancel transfers'; END IF;
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

REVOKE ALL ON FUNCTION public.stock_transfer_remaining(numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_transfer_close_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_transfer_remaining(numeric, numeric, numeric, numeric) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.stock_transfer_close_status(uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.write_off_stock_transfer_shortage(uuid, uuid, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_stock_transfer(uuid, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_stock_transfer(uuid, uuid, text) TO authenticated, service_role;

COMMIT;
