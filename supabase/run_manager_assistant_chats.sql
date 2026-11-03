-- Block 5.1: manager role, staff order access, persistent assistant chats.
-- Does not rewrite existing profiles, orders, inventory, or T/N numbers.
-- Do not apply until explicitly allowed.

BEGIN;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'seller'::text, 'manager'::text]));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_cancel_orders boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_user_role() = 'admin';
$$;

CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_user_role() = 'manager';
$$;

CREATE OR REPLACE FUNCTION public.is_assistant_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_user_role() IN ('admin', 'manager');
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_assistant_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_manager() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_assistant_user() TO authenticated, service_role;

DROP POLICY IF EXISTS inventory_staff_select ON public.inventory;
CREATE POLICY inventory_staff_select ON public.inventory
  FOR SELECT TO authenticated
  USING (public.is_assistant_user());

DROP POLICY IF EXISTS orders_staff_select ON public.orders;
CREATE POLICY orders_staff_select ON public.orders
  FOR SELECT TO authenticated
  USING (public.is_assistant_user());

DROP POLICY IF EXISTS order_items_staff_select ON public.order_items;
CREATE POLICY order_items_staff_select ON public.order_items
  FOR SELECT TO authenticated
  USING (public.is_assistant_user());

DROP POLICY IF EXISTS profiles_staff_select ON public.profiles;
CREATE POLICY profiles_staff_select ON public.profiles
  FOR SELECT TO authenticated
  USING (public.is_manager() AND role = 'seller');

CREATE TABLE IF NOT EXISTS public.assistant_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id),
  title text NOT NULL DEFAULT 'Новый диалог',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_chats_title_check CHECK (char_length(btrim(title)) > 0 AND char_length(title) <= 120)
);

CREATE TABLE IF NOT EXISTS public.assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.assistant_chats(id) ON DELETE CASCADE,
  author_id uuid REFERENCES public.profiles(id),
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  client_message_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_messages_role_check CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])),
  CONSTRAINT assistant_messages_content_check CHECK (char_length(content) <= 20000)
);

CREATE INDEX IF NOT EXISTS assistant_chats_owner_updated_idx
  ON public.assistant_chats (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS assistant_messages_chat_created_idx
  ON public.assistant_messages (chat_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_messages_client_id_uidx
  ON public.assistant_messages (chat_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

ALTER TABLE public.assistant_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assistant_chats_select ON public.assistant_chats;
CREATE POLICY assistant_chats_select ON public.assistant_chats
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (public.is_assistant_user() AND owner_id = auth.uid())
  );

DROP POLICY IF EXISTS assistant_chats_insert ON public.assistant_chats;
CREATE POLICY assistant_chats_insert ON public.assistant_chats
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() AND public.is_assistant_user());

DROP POLICY IF EXISTS assistant_chats_update ON public.assistant_chats;
CREATE POLICY assistant_chats_update ON public.assistant_chats
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() AND public.is_assistant_user())
  WITH CHECK (owner_id = auth.uid() AND public.is_assistant_user());

DROP POLICY IF EXISTS assistant_messages_select ON public.assistant_messages;
CREATE POLICY assistant_messages_select ON public.assistant_messages
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      public.is_assistant_user()
      AND EXISTS (
        SELECT 1 FROM public.assistant_chats c
        WHERE c.id = assistant_messages.chat_id AND c.owner_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS assistant_messages_insert ON public.assistant_messages;
CREATE POLICY assistant_messages_insert ON public.assistant_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_assistant_user()
    AND author_id = auth.uid()
    AND role = 'user'
    AND EXISTS (
      SELECT 1 FROM public.assistant_chats c
      WHERE c.id = assistant_messages.chat_id AND c.owner_id = auth.uid()
    )
  );

REVOKE ALL ON TABLE public.assistant_chats FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.assistant_messages FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.assistant_chats TO authenticated;
GRANT SELECT, INSERT ON TABLE public.assistant_messages TO authenticated;
GRANT ALL ON TABLE public.assistant_chats TO service_role;
GRANT ALL ON TABLE public.assistant_messages TO service_role;

CREATE OR REPLACE FUNCTION public.assistant_chats_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Cannot reassign chat owner';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assistant_chats_guard ON public.assistant_chats;
CREATE TRIGGER assistant_chats_guard
  BEFORE UPDATE ON public.assistant_chats
  FOR EACH ROW
  EXECUTE FUNCTION public.assistant_chats_guard();

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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_prevent_privilege_escalation ON public.profiles;
CREATE TRIGGER profiles_prevent_privilege_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_prevent_privilege_escalation();

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

REVOKE ALL ON FUNCTION public.confirm_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_order(jsonb) TO authenticated, service_role;

COMMIT;
