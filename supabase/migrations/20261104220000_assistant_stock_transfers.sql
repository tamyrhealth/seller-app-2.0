-- Block 5.2.5: assistant stock-transfer drafts + manager create flag.
-- Does not rewrite receive/cancel/shortage RPCs or confirm_order.
-- Do not apply until explicitly allowed.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_create_transfers boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.profiles_prevent_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_admin() THEN
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
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS stock_transfers_admin_select ON public.stock_transfers;
DROP POLICY IF EXISTS stock_transfers_select ON public.stock_transfers;
CREATE POLICY stock_transfers_select ON public.stock_transfers
  FOR SELECT TO authenticated
  USING (public.get_user_role() = 'admin' OR created_by = auth.uid());

DROP POLICY IF EXISTS stock_transfer_items_admin_select ON public.stock_transfer_items;
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
  );

DROP POLICY IF EXISTS stock_transfer_events_admin_select ON public.stock_transfer_events;
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
  SELECT role, COALESCE(can_create_transfers, false)
    INTO v_role, v_can_create
  FROM public.profiles
  WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' THEN
    IF v_role IS DISTINCT FROM 'manager' OR v_can_create IS NOT TRUE THEN
      RAISE EXCEPTION 'Transfer permission denied';
    END IF;
  END IF;
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

CREATE TABLE IF NOT EXISTS public.assistant_stock_transfer_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.assistant_chats(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.profiles(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  user_message_id uuid REFERENCES public.assistant_messages(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES public.assistant_messages(id) ON DELETE SET NULL,
  status text NOT NULL,
  can_confirm boolean NOT NULL DEFAULT false,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
  transfer_id uuid REFERENCES public.stock_transfers(id) ON DELETE SET NULL,
  transfer_number text,
  confirmed_by uuid REFERENCES public.profiles(id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_stock_transfer_drafts_status_check
    CHECK (status = ANY (ARRAY['preview'::text, 'blocked'::text, 'confirming'::text, 'confirmed'::text, 'cancelled'::text]))
);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_stock_transfer_drafts_idempotency_uidx
  ON public.assistant_stock_transfer_drafts (idempotency_key);
CREATE INDEX IF NOT EXISTS assistant_stock_transfer_drafts_chat_idx
  ON public.assistant_stock_transfer_drafts (chat_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_stock_transfer_drafts_message_uidx
  ON public.assistant_stock_transfer_drafts (assistant_message_id)
  WHERE assistant_message_id IS NOT NULL;

ALTER TABLE public.assistant_stock_transfer_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_stock_transfer_drafts_select ON public.assistant_stock_transfer_drafts;
CREATE POLICY assistant_stock_transfer_drafts_select ON public.assistant_stock_transfer_drafts
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin());

REVOKE ALL ON TABLE public.assistant_stock_transfer_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.assistant_stock_transfer_drafts TO authenticated;
GRANT ALL ON TABLE public.assistant_stock_transfer_drafts TO service_role;

CREATE OR REPLACE FUNCTION public.save_assistant_stock_transfer_draft(
  p_id uuid,
  p_chat_id uuid,
  p_owner_id uuid,
  p_created_by uuid,
  p_user_message_id uuid,
  p_status text,
  p_can_confirm boolean,
  p_warnings jsonb,
  p_errors jsonb,
  p_resolved jsonb,
  p_preview jsonb,
  p_idempotency_key uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_id IS NULL OR p_chat_id IS NULL OR p_owner_id IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  IF p_created_by IS DISTINCT FROM p_owner_id THEN
    RAISE EXCEPTION 'created_by_mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.assistant_chats c
    WHERE c.id = p_chat_id AND c.owner_id = p_owner_id
  ) THEN
    RAISE EXCEPTION 'chat_owner_mismatch';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('preview', 'blocked') THEN
    RAISE EXCEPTION 'invalid_draft_status';
  END IF;

  INSERT INTO public.assistant_stock_transfer_drafts (
    id, chat_id, owner_id, created_by, user_message_id, status, can_confirm,
    warnings, errors, resolved, preview, idempotency_key
  ) VALUES (
    p_id, p_chat_id, p_owner_id, p_created_by, p_user_message_id, p_status,
    COALESCE(p_can_confirm, false),
    COALESCE(p_warnings, '[]'::jsonb),
    COALESCE(p_errors, '[]'::jsonb),
    COALESCE(p_resolved, '{}'::jsonb),
    COALESCE(p_preview, '{}'::jsonb),
    COALESCE(p_idempotency_key, gen_random_uuid())
  )
  ON CONFLICT (id) DO UPDATE
    SET status = EXCLUDED.status,
        can_confirm = EXCLUDED.can_confirm,
        warnings = EXCLUDED.warnings,
        errors = EXCLUDED.errors,
        resolved = EXCLUDED.resolved,
        preview = EXCLUDED.preview,
        user_message_id = COALESCE(EXCLUDED.user_message_id, public.assistant_stock_transfer_drafts.user_message_id),
        updated_at = now()
    WHERE public.assistant_stock_transfer_drafts.status IN ('preview', 'blocked')
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'draft_not_writable';
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_assistant_stock_transfer_draft_message(
  p_id uuid,
  p_assistant_message_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_id IS NULL OR p_assistant_message_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.assistant_stock_transfer_drafts
  SET assistant_message_id = p_assistant_message_id,
      updated_at = now()
  WHERE id = p_id
    AND assistant_message_id IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_assistant_stock_transfer_draft_content(
  p_id uuid,
  p_owner_id uuid,
  p_status text,
  p_can_confirm boolean,
  p_warnings jsonb,
  p_errors jsonb,
  p_resolved jsonb,
  p_preview jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_row public.assistant_stock_transfer_drafts%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('preview', 'blocked') THEN
    RAISE EXCEPTION 'invalid_draft_status';
  END IF;
  SELECT * INTO v_row
  FROM public.assistant_stock_transfer_drafts
  WHERE id = p_id AND owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.assistant_stock_transfer_drafts d WHERE d.id = p_id) THEN
      RAISE EXCEPTION 'not_draft_owner';
    END IF;
    RAISE EXCEPTION 'draft_not_found';
  END IF;
  IF v_row.status NOT IN ('preview', 'blocked') THEN
    RAISE EXCEPTION 'draft_not_editable';
  END IF;
  UPDATE public.assistant_stock_transfer_drafts
  SET status = p_status,
      can_confirm = COALESCE(p_can_confirm, false),
      warnings = COALESCE(p_warnings, '[]'::jsonb),
      errors = COALESCE(p_errors, '[]'::jsonb),
      resolved = COALESCE(p_resolved, '{}'::jsonb),
      preview = COALESCE(p_preview, '{}'::jsonb),
      updated_at = now()
  WHERE id = p_id AND owner_id = p_owner_id AND status IN ('preview', 'blocked');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft_not_editable';
  END IF;
  RETURN p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_assistant_stock_transfer_draft(
  p_id uuid,
  p_owner_id uuid,
  p_transfer_id uuid,
  p_transfer_number text,
  p_confirmed_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_id IS NULL OR p_owner_id IS NULL OR p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  UPDATE public.assistant_stock_transfer_drafts
  SET status = 'confirmed',
      can_confirm = false,
      transfer_id = p_transfer_id,
      transfer_number = NULLIF(btrim(COALESCE(p_transfer_number, '')), ''),
      confirmed_by = p_confirmed_by,
      confirmed_at = COALESCE(confirmed_at, now()),
      updated_at = now()
  WHERE id = p_id
    AND owner_id = p_owner_id
    AND status IN ('preview', 'blocked', 'confirming', 'confirmed', 'cancelled');
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_assistant_stock_transfer_confirm(
  p_id uuid,
  p_owner_id uuid,
  p_errors jsonb,
  p_can_confirm boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_id IS NULL OR p_owner_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.assistant_stock_transfer_drafts
  SET status = CASE WHEN COALESCE(p_can_confirm, false) THEN 'preview' ELSE 'blocked' END,
      can_confirm = COALESCE(p_can_confirm, false),
      errors = COALESCE(p_errors, errors),
      updated_at = now()
  WHERE id = p_id
    AND owner_id = p_owner_id
    AND status = 'confirming';
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_assistant_stock_transfer_confirm(p_draft_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_row public.assistant_stock_transfer_drafts%ROWTYPE;
  v_role text;
  v_flag boolean := false;
  v_existing uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_assistant_user() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_draft_id IS NULL THEN RAISE EXCEPTION 'invalid_args'; END IF;

  SELECT role, COALESCE(can_create_transfers, false) INTO v_role, v_flag
  FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'admin' AND NOT (v_role = 'manager' AND v_flag IS TRUE) THEN
    RAISE EXCEPTION 'Transfer permission denied';
  END IF;

  SELECT * INTO v_row
  FROM public.assistant_stock_transfer_drafts
  WHERE id = p_draft_id AND owner_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.assistant_stock_transfer_drafts d WHERE d.id = p_draft_id) THEN
      RAISE EXCEPTION 'not_draft_owner';
    END IF;
    RAISE EXCEPTION 'draft_not_found';
  END IF;

  SELECT t.id INTO v_existing
  FROM public.stock_transfers t
  JOIN public.client_operations c
    ON c.entity_type = 'stock_transfer' AND c.entity_id = t.id::text AND c.actor_id = v_uid
  WHERE c.operation_id = v_row.idempotency_key
  LIMIT 1;

  IF v_row.status = 'confirmed' OR v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_confirmed',
      'transfer_id', COALESCE(v_row.transfer_id, v_existing),
      'transfer_number', v_row.transfer_number
    );
  END IF;
  IF v_row.status = 'cancelled' THEN RAISE EXCEPTION 'draft_cancelled'; END IF;
  IF v_row.status = 'confirming' THEN
    -- In-flight confirm: caller may retry create_stock_transfer with the same operation_id.
    RETURN jsonb_build_object('status', 'confirming', 'draft_id', v_row.id);
  END IF;
  IF v_row.status <> 'preview' OR v_row.can_confirm IS NOT TRUE THEN
    RAISE EXCEPTION 'draft_not_confirmable';
  END IF;

  UPDATE public.assistant_stock_transfer_drafts
  SET status = 'confirming', updated_at = now()
  WHERE id = v_row.id AND owner_id = v_uid AND status = 'preview' AND can_confirm = true;

  RETURN jsonb_build_object('status', 'confirming', 'draft_id', v_row.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_assistant_stock_transfer_draft(p_draft_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid;
  v_row public.assistant_stock_transfer_drafts%ROWTYPE;
  v_existing uuid;
  v_number text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_assistant_user() THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT * INTO v_row
  FROM public.assistant_stock_transfer_drafts
  WHERE id = p_draft_id AND owner_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.assistant_stock_transfer_drafts d WHERE d.id = p_draft_id) THEN
      RAISE EXCEPTION 'not_draft_owner';
    END IF;
    RAISE EXCEPTION 'draft_not_found';
  END IF;

  SELECT t.id, t.transfer_number INTO v_existing, v_number
  FROM public.client_operations c
  JOIN public.stock_transfers t ON t.id::text = c.entity_id
  WHERE c.actor_id = v_uid AND c.operation_id = v_row.idempotency_key
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.assistant_stock_transfer_drafts
    SET status = 'confirmed',
        can_confirm = false,
        transfer_id = COALESCE(transfer_id, v_existing),
        transfer_number = COALESCE(transfer_number, v_number),
        confirmed_by = COALESCE(confirmed_by, v_uid),
        confirmed_at = COALESCE(confirmed_at, now()),
        updated_at = now()
    WHERE id = v_row.id;
    RETURN jsonb_build_object('status', 'already_confirmed', 'transfer_id', v_existing, 'transfer_number', v_number);
  END IF;
  IF v_row.status = 'confirmed' THEN
    RETURN jsonb_build_object('status', 'already_confirmed', 'transfer_id', v_row.transfer_id, 'transfer_number', v_row.transfer_number);
  END IF;
  IF v_row.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'cancelled');
  END IF;
  IF v_row.status = 'confirming' THEN
    RETURN jsonb_build_object('status', 'confirming');
  END IF;

  UPDATE public.assistant_stock_transfer_drafts
  SET status = 'cancelled', can_confirm = false, updated_at = now()
  WHERE id = v_row.id AND owner_id = v_uid AND status IN ('preview', 'blocked');

  RETURN jsonb_build_object('status', 'cancelled');
END;
$$;

REVOKE ALL ON FUNCTION public.save_assistant_stock_transfer_draft(uuid, uuid, uuid, uuid, uuid, text, boolean, jsonb, jsonb, jsonb, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_assistant_stock_transfer_draft_message(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_assistant_stock_transfer_draft_content(uuid, uuid, text, boolean, jsonb, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_assistant_stock_transfer_draft(uuid, uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_assistant_stock_transfer_confirm(uuid, uuid, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_assistant_stock_transfer_confirm(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_assistant_stock_transfer_draft(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_assistant_stock_transfer_draft(uuid, uuid, uuid, uuid, uuid, text, boolean, jsonb, jsonb, jsonb, jsonb, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_assistant_stock_transfer_draft_message(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_assistant_stock_transfer_draft_content(uuid, uuid, text, boolean, jsonb, jsonb, jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_assistant_stock_transfer_draft(uuid, uuid, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_assistant_stock_transfer_confirm(uuid, uuid, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_assistant_stock_transfer_confirm(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_assistant_stock_transfer_draft(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.create_stock_transfer(uuid, uuid, uuid, jsonb, text) TO authenticated, service_role;

COMMIT;
