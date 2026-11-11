-- Isolated P0 integration schema. Not Production.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, anon;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL
);

CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.assert_active_auth_session()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Active session required';
  END IF;
  RETURN auth.uid();
END;
$$;

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  seller_id uuid,
  city_id uuid,
  status text,
  payment_type text,
  comment text,
  total_sum numeric,
  is_preorder boolean DEFAULT false,
  preorder_status text,
  is_debt boolean,
  debt_status text,
  debt_paid_at timestamptz,
  debt_payment_method text,
  debt_customer_phone text,
  order_number text,
  idempotency_key text
);

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid,
  product_id uuid,
  qty numeric,
  price numeric,
  cost_price_snapshot numeric
);

CREATE TABLE public.action_logs (
  id bigserial PRIMARY KEY,
  kind text,
  payload jsonb
);

CREATE TABLE public.commission_hits (
  id bigserial PRIMARY KEY,
  kind text,
  at timestamptz DEFAULT now()
);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY orders_update ON public.orders
  FOR UPDATE
  USING (seller_id = auth.uid() OR public.get_user_role() = 'admin')
  WITH CHECK (true);

CREATE POLICY orders_seller_insert ON public.orders
  FOR INSERT
  WITH CHECK (seller_id = auth.uid() OR public.get_user_role() = 'admin');

CREATE POLICY orders_select ON public.orders
  FOR SELECT
  USING (true);

CREATE POLICY order_items_insert ON public.order_items
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY order_items_select ON public.order_items
  FOR SELECT
  USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.orders TO authenticated;
GRANT UPDATE ON TABLE public.orders TO anon;
GRANT SELECT (id, order_id, product_id, qty, price),
      INSERT (id, order_id, product_id, qty, price),
      UPDATE (id, order_id, product_id, qty, price) ON TABLE public.order_items TO authenticated;
GRANT DELETE ON TABLE public.order_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

CREATE OR REPLACE FUNCTION public.log_order_action(p_kind text, p_order_id uuid, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.action_logs (kind, payload)
  VALUES (p_kind, jsonb_build_object('order_id', p_order_id) || COALESCE(p_payload, '{}'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.order_history_item_snapshot(p_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT '[]'::jsonb
$$;

CREATE OR REPLACE FUNCTION public.mark_debt_paid(p_order_id uuid, p_payment_method text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_order_rec record;
  v_method text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  SELECT id, seller_id, is_debt, debt_status, order_number
    INTO v_order_rec
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF v_order_rec.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NOT COALESCE(v_order_rec.is_debt, false) THEN
    RAISE EXCEPTION 'Order is not a debt';
  END IF;
  IF v_role = 'seller' AND v_order_rec.seller_id <> v_uid THEN
    RAISE EXCEPTION 'Seller can only mark own debts as paid';
  END IF;
  IF v_order_rec.debt_status = 'paid' THEN
    RETURN;
  END IF;
  v_method := NULLIF(trim(COALESCE(p_payment_method, '')), '');
  UPDATE public.orders
  SET
    debt_status = 'paid',
    debt_paid_at = now(),
    debt_payment_method = v_method,
    payment_type = CASE WHEN v_method IN ('cash', 'kaspi') THEN v_method ELSE payment_type END,
    updated_at = now()
  WHERE id = p_order_id;
  PERFORM public.log_order_action('debt_pay', p_order_id, jsonb_build_object('payment_method', v_method));
END;
$$;

ALTER FUNCTION public.mark_debt_paid(uuid, text) RENAME TO mark_debt_paid__session_body;

CREATE OR REPLACE FUNCTION public.mark_debt_paid(p_order_id uuid, p_payment_method text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_active_auth_session();
  PERFORM public.mark_debt_paid__session_body(p_order_id, p_payment_method);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_debt_paid__session_body(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_debt_paid__session_body(uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.mark_debt_paid(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_order(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.assert_active_auth_session();
  INSERT INTO public.orders (id, seller_id, status, payment_type, total_sum, is_debt)
  VALUES (v_id, auth.uid(), 'confirmed', COALESCE(payload->>'payment_type', 'cash'), 10, false);
  INSERT INTO public.order_items (id, order_id, qty, price)
  VALUES (gen_random_uuid(), v_id, 1, 10);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_active_auth_session();
  UPDATE public.orders SET status = 'canceled', updated_at = now() WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_order(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_active_auth_session() TO postgres;

CREATE OR REPLACE FUNCTION public.seller_commission_orders_au()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.commission_hits (kind) VALUES ('orders_au');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.seller_commission_order_items_ai()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.commission_hits (kind) VALUES ('items_ai');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.orders_log_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.action_logs (kind, payload) VALUES ('order_insert', jsonb_build_object('id', NEW.id));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.orders_sync_debt_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END;
$$;

CREATE TRIGGER seller_commission_orders_au_trg
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_commission_orders_au();

CREATE TRIGGER seller_commission_order_items_ai_trg
  AFTER INSERT ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.seller_commission_order_items_ai();

CREATE TRIGGER orders_log_insert_trg
  AFTER INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_log_insert();

CREATE TRIGGER orders_sync_debt_trigger
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_sync_debt_fields();

INSERT INTO public.profiles (id, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'seller'),
  ('22222222-2222-2222-2222-222222222222', 'seller'),
  ('33333333-3333-3333-3333-333333333333', 'admin');

INSERT INTO public.orders (id, seller_id, status, payment_type, total_sum, is_debt, debt_status, debt_customer_phone)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'confirmed', 'debt', 100, true, 'active', '77010000001'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'confirmed', 'debt', 80, true, 'active', '77010000002'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'confirmed', 'debt', 50, true, 'active', '77010000003');
