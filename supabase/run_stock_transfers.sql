-- Block 4: admin stock transfers between cities.
-- Additive tables/RPCs. Does not change cities.is_active.
-- No DELETE of business rows. Do not apply until explicitly allowed.

BEGIN;

ALTER TABLE public.inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_type_check;
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_type_check CHECK (type = ANY (ARRAY[
    'sale'::text, 'cancel_sale'::text, 'restock'::text, 'adjust'::text,
    'transfer_out'::text, 'transfer_in'::text, 'transfer_cancel'::text
  ]));

CREATE SEQUENCE IF NOT EXISTS public.stock_transfers_number_seq;

CREATE TABLE IF NOT EXISTS public.stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_number text NOT NULL,
  from_city_id uuid NOT NULL,
  to_city_id uuid NOT NULL,
  status text NOT NULL,
  comment text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid,
  received_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancelled_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfers_from_city_id_fkey FOREIGN KEY (from_city_id) REFERENCES public.cities(id),
  CONSTRAINT stock_transfers_to_city_id_fkey FOREIGN KEY (to_city_id) REFERENCES public.cities(id),
  CONSTRAINT stock_transfers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  CONSTRAINT stock_transfers_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.profiles(id),
  CONSTRAINT stock_transfers_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.profiles(id),
  CONSTRAINT stock_transfers_cities_distinct CHECK (from_city_id <> to_city_id),
  CONSTRAINT stock_transfers_status_check CHECK (status = ANY (ARRAY[
    'in_transit'::text,
    'received'::text,
    'received_with_variance'::text,
    'cancelled'::text
  ]))
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_number_uidx
  ON public.stock_transfers (transfer_number);

CREATE INDEX IF NOT EXISTS stock_transfers_created_idx
  ON public.stock_transfers (created_at DESC);

CREATE TABLE IF NOT EXISTS public.stock_transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  qty_sent numeric(12,3) NOT NULL,
  qty_received numeric(12,3),
  CONSTRAINT stock_transfer_items_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES public.stock_transfers(id),
  CONSTRAINT stock_transfer_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id),
  CONSTRAINT stock_transfer_items_qty_sent_check CHECK (qty_sent > 0),
  CONSTRAINT stock_transfer_items_qty_recv_check CHECK (qty_received IS NULL OR qty_received >= 0),
  CONSTRAINT stock_transfer_items_unique UNIQUE (transfer_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.stock_transfer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL,
  action text NOT NULL,
  actor_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfer_events_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES public.stock_transfers(id),
  CONSTRAINT stock_transfer_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id)
);

CREATE INDEX IF NOT EXISTS stock_transfer_events_transfer_idx
  ON public.stock_transfer_events (transfer_id, created_at);

ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS transfer_id uuid;
DO $$
BEGIN
  ALTER TABLE public.inventory_movements
    ADD CONSTRAINT inventory_movements_transfer_id_fkey
    FOREIGN KEY (transfer_id) REFERENCES public.stock_transfers(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.format_transfer_number(p_n bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'T' || CASE
    WHEN length(p_n::text) >= 6 THEN p_n::text
    ELSE lpad(p_n::text, 6, '0')
  END;
$$;

CREATE OR REPLACE FUNCTION public.stock_transfers_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.transfer_number IS NULL OR btrim(NEW.transfer_number) = '' THEN
    NEW.transfer_number := public.format_transfer_number(nextval('public.stock_transfers_number_seq'));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_transfers_assign_number_trg ON public.stock_transfers;
CREATE TRIGGER stock_transfers_assign_number_trg
  BEFORE INSERT ON public.stock_transfers
  FOR EACH ROW
  EXECUTE FUNCTION public.stock_transfers_assign_number();

ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_transfers_admin_select ON public.stock_transfers;
DROP POLICY IF EXISTS stock_transfer_items_admin_select ON public.stock_transfer_items;
DROP POLICY IF EXISTS stock_transfer_events_admin_select ON public.stock_transfer_events;

CREATE POLICY stock_transfers_admin_select ON public.stock_transfers
  FOR SELECT TO authenticated USING (public.get_user_role() = 'admin');
CREATE POLICY stock_transfer_items_admin_select ON public.stock_transfer_items
  FOR SELECT TO authenticated USING (public.get_user_role() = 'admin');
CREATE POLICY stock_transfer_events_admin_select ON public.stock_transfer_events
  FOR SELECT TO authenticated USING (public.get_user_role() = 'admin');

REVOKE ALL ON TABLE public.stock_transfers FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.stock_transfer_items FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.stock_transfer_events FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.stock_transfers TO authenticated;
GRANT SELECT ON TABLE public.stock_transfer_items TO authenticated;
GRANT SELECT ON TABLE public.stock_transfer_events TO authenticated;
GRANT ALL ON TABLE public.stock_transfers TO postgres, service_role;
GRANT ALL ON TABLE public.stock_transfer_items TO postgres, service_role;
GRANT ALL ON TABLE public.stock_transfer_events TO postgres, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.stock_transfers_number_seq TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.stock_transfer_fingerprint(p_kind text, p_payload jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT md5(p_kind || ':' || COALESCE(p_payload::text, ''));
$$;

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
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin can transfer stock'; END IF;
  IF p_operation_id IS NULL OR p_from_city_id IS NULL OR p_to_city_id IS NULL THEN
    RAISE EXCEPTION 'Invalid transfer payload';
  END IF;
  IF p_from_city_id = p_to_city_id THEN
    RAISE EXCEPTION 'Source and destination cities must differ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cities WHERE id = p_from_city_id) THEN
    RAISE EXCEPTION 'Source city not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cities WHERE id = p_to_city_id) THEN
    RAISE EXCEPTION 'Destination city not found';
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
  v_sent numeric;
  v_got numeric;
  v_has_var boolean := false;
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
           'qty_received', s.qty
         ) ORDER BY s.product_id), '[]'::jsonb)
    INTO v_payload
  FROM (
    SELECT (e->>'product_id')::uuid AS product_id,
           round(SUM(COALESCE(
             NULLIF(e->>'qty_received', '')::numeric,
             NULLIF(e->>'qty', '')::numeric,
             0
           )), 3) AS qty
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) e
    GROUP BY 1
  ) s;

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

  IF v_tr.status IN ('received', 'received_with_variance') THEN
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

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload) e
    WHERE NOT EXISTS (
      SELECT 1 FROM public.stock_transfer_items i
      WHERE i.transfer_id = p_transfer_id AND i.product_id = (e->>'product_id')::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Unknown product in receive payload';
  END IF;

  FOR v_pid IN
    SELECT product_id FROM public.stock_transfer_items WHERE transfer_id = p_transfer_id ORDER BY product_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('inv:' || v_tr.to_city_id::text), hashtext(v_pid::text));
    PERFORM 1 FROM public.inventory
    WHERE city_id = v_tr.to_city_id AND product_id = v_pid
    FOR UPDATE;
  END LOOP;

  FOR v_pid, v_sent IN
    SELECT product_id, qty_sent FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id
    ORDER BY product_id
  LOOP
    SELECT COALESCE(MAX((e->>'qty_received')::numeric), 0) INTO v_got
    FROM jsonb_array_elements(v_payload) e
    WHERE (e->>'product_id')::uuid = v_pid;
    IF v_got IS NULL OR v_got < 0 THEN RAISE EXCEPTION 'Invalid qty'; END IF;
    IF v_got > v_sent THEN RAISE EXCEPTION 'Received qty exceeds sent qty'; END IF;
    IF v_got IS DISTINCT FROM v_sent THEN v_has_var := true; END IF;

    UPDATE public.stock_transfer_items
    SET qty_received = v_got
    WHERE transfer_id = p_transfer_id AND product_id = v_pid;

    IF v_got > 0 THEN
      INSERT INTO public.inventory (city_id, product_id, qty_on_hand, updated_at)
      VALUES (v_tr.to_city_id, v_pid, v_got, now())
      ON CONFLICT (city_id, product_id) DO UPDATE
        SET qty_on_hand = public.inventory.qty_on_hand + EXCLUDED.qty_on_hand,
            updated_at = now();
      INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, created_by, note, transfer_id)
      VALUES (v_tr.to_city_id, v_pid, 'transfer_in', v_got, v_uid, v_tr.transfer_number, v_tr.id);
    END IF;
  END LOOP;

  v_status := CASE WHEN v_has_var THEN 'received_with_variance' ELSE 'received' END;

  UPDATE public.stock_transfers
  SET status = v_status, received_by = v_uid, received_at = now(), updated_at = now()
  WHERE id = p_transfer_id;

  INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)
  VALUES (
    p_transfer_id,
    CASE WHEN v_has_var THEN 'received_with_variance' ELSE 'received' END,
    v_uid,
    jsonb_build_object('items', v_payload, 'has_variance', v_has_var)
  );

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
  v_sent numeric;
  v_reason text;
  v_result jsonb;
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
  IF v_tr.status IN ('received', 'received_with_variance') THEN
    RAISE EXCEPTION 'Received transfer cannot be cancelled';
  END IF;

  IF v_tr.status = 'cancelled' THEN
    v_result := jsonb_build_object(
      'id', v_tr.id,
      'transfer_number', v_tr.transfer_number,
      'status', 'cancelled',
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
    SELECT product_id FROM public.stock_transfer_items WHERE transfer_id = p_transfer_id ORDER BY product_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('inv:' || v_tr.from_city_id::text), hashtext(v_pid::text));
    PERFORM 1 FROM public.inventory
    WHERE city_id = v_tr.from_city_id AND product_id = v_pid
    FOR UPDATE;
  END LOOP;

  FOR v_pid, v_sent IN
    SELECT product_id, qty_sent FROM public.stock_transfer_items
    WHERE transfer_id = p_transfer_id
    ORDER BY product_id
  LOOP
    INSERT INTO public.inventory (city_id, product_id, qty_on_hand, updated_at)
    VALUES (v_tr.from_city_id, v_pid, v_sent, now())
    ON CONFLICT (city_id, product_id) DO UPDATE
      SET qty_on_hand = public.inventory.qty_on_hand + EXCLUDED.qty_on_hand,
          updated_at = now();
    INSERT INTO public.inventory_movements (city_id, product_id, type, qty_delta, created_by, note, transfer_id)
    VALUES (v_tr.from_city_id, v_pid, 'transfer_cancel', v_sent, v_uid, v_tr.transfer_number, v_tr.id);
  END LOOP;

  UPDATE public.stock_transfers
  SET status = 'cancelled',
      cancelled_by = v_uid,
      cancelled_at = now(),
      cancelled_reason = v_reason,
      updated_at = now()
  WHERE id = p_transfer_id;

  INSERT INTO public.stock_transfer_events (transfer_id, action, actor_id, details)
  VALUES (p_transfer_id, 'cancelled', v_uid, jsonb_build_object('reason', v_reason));

  v_result := jsonb_build_object(
    'id', p_transfer_id,
    'transfer_number', v_tr.transfer_number,
    'status', 'cancelled',
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

REVOKE ALL ON FUNCTION public.format_transfer_number(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_transfer_fingerprint(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_transfers_assign_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.format_transfer_number(bigint) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.stock_transfer_fingerprint(text, jsonb) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.stock_transfers_assign_number() TO postgres, service_role;

REVOKE ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_stock_transfer(uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_stock_transfer(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_stock_transfer(uuid, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_stock_transfer(uuid, uuid, text) TO authenticated, service_role;

COMMIT;
