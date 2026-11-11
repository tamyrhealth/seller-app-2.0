-- 5.20.1 P0: authenticated/anon cannot write orders or order_items.
-- Mutations stay SECURITY DEFINER (postgres). Does not rewrite
-- confirm_order / cancel / mark_debt_paid / fulfill_preorder bodies
-- and does not re-run auth_session_guard_apply().

BEGIN;

DO $$
DECLARE
  v_body regprocedure := to_regprocedure('public.mark_debt_paid__session_body(uuid, text)');
  v_wrap regprocedure := to_regprocedure('public.mark_debt_paid(uuid, text)');
  v_def text;
BEGIN
  IF v_wrap IS NULL THEN
    RAISE EXCEPTION 'P0 requires public.mark_debt_paid(uuid, text)';
  END IF;
  v_def := pg_get_functiondef(COALESCE(v_body, v_wrap));
  IF v_def NOT LIKE '%Seller can only mark own debts as paid%' THEN
    RAISE EXCEPTION 'P0 abort: mark_debt_paid body must reject foreign seller debts';
  END IF;
  IF v_body IS NOT NULL
     AND has_function_privilege('authenticated', v_body, 'EXECUTE') THEN
    RAISE EXCEPTION 'P0 abort: authenticated must not EXECUTE mark_debt_paid__session_body';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.orders_block_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Direct order table writes are not allowed';
END;
$$;

DROP TRIGGER IF EXISTS zz_orders_protect_client_update ON public.orders;
DROP TRIGGER IF EXISTS zz_orders_block_client_write ON public.orders;
DROP FUNCTION IF EXISTS public.orders_protect_client_update();
CREATE TRIGGER zz_orders_block_client_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_block_client_write();

DROP TRIGGER IF EXISTS zz_order_items_block_client_write ON public.order_items;
CREATE TRIGGER zz_order_items_block_client_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_block_client_write();

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.orders_block_client_write() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.orders_block_client_write() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.orders_block_client_write() FROM authenticated;
  END IF;
  GRANT EXECUTE ON FUNCTION public.orders_block_client_write() TO postgres;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    GRANT EXECUTE ON FUNCTION public.orders_block_client_write() TO supabase_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.orders_block_client_write() TO service_role;
  END IF;
END $$;

DROP POLICY IF EXISTS "orders_update" ON public.orders;
DROP POLICY IF EXISTS orders_update ON public.orders;
CREATE POLICY orders_update ON public.orders
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "orders_seller_insert" ON public.orders;
DROP POLICY IF EXISTS orders_seller_insert ON public.orders;
CREATE POLICY orders_seller_insert ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "order_items_insert" ON public.order_items;
DROP POLICY IF EXISTS order_items_insert ON public.order_items;
CREATE POLICY order_items_insert ON public.order_items
  FOR INSERT TO authenticated
  WITH CHECK (false);

REVOKE ALL ON TABLE public.orders FROM PUBLIC;
REVOKE ALL ON TABLE public.orders FROM anon;
REVOKE ALL ON TABLE public.orders FROM authenticated;
GRANT SELECT ON TABLE public.orders TO authenticated;

REVOKE ALL ON TABLE public.order_items FROM PUBLIC;
REVOKE ALL ON TABLE public.order_items FROM anon;
REVOKE ALL ON TABLE public.order_items FROM authenticated;
-- Keep 5.13.2: no table-level SELECT (that would leak cost_price_snapshot).
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
  IF v_select IS NULL OR v_select = '' THEN
    RAISE EXCEPTION 'order_items public columns missing';
  END IF;
  EXECUTE format('GRANT SELECT (%s) ON TABLE public.order_items TO authenticated', v_select);
END
$grant$;

CREATE OR REPLACE FUNCTION public.complete_seller_debt_pay(
  p_order_id uuid,
  p_payment_method text,
  p_customer_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_order public.orders%ROWTYPE;
  v_phone text;
  v_method text;
BEGIN
  PERFORM public.assert_active_auth_session();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role NOT IN ('admin', 'seller') THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('cash', 'kaspi') THEN
    RAISE EXCEPTION 'payment_method must be cash or kaspi';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_role = 'seller' AND v_order.seller_id <> v_uid THEN
    RAISE EXCEPTION 'Seller can only mark own debts as paid';
  END IF;
  IF v_order.status IN ('canceled', 'cancelled') THEN
    RAISE EXCEPTION 'Заказ отменён, закрыть долг нельзя';
  END IF;
  IF v_order.debt_status = 'paid' OR v_order.debt_paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'Debt is already paid';
  END IF;
  IF v_order.payment_type IS DISTINCT FROM 'debt' AND v_order.is_debt IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Order is not a debt';
  END IF;

  v_phone := NULLIF(btrim(COALESCE(p_customer_phone, '')), '');
  IF v_phone IS NOT NULL THEN
    IF to_regprocedure('public.kz_normalize_customer_phone(text)') IS NOT NULL THEN
      v_phone := public.kz_normalize_customer_phone(v_phone);
    END IF;
    IF v_phone IS NULL OR length(v_phone) < 8 THEN
      RAISE EXCEPTION 'Некорректный телефон клиента';
    END IF;
    UPDATE public.orders
    SET
      debt_customer_phone = v_phone,
      updated_at = now()
    WHERE id = p_order_id;
  END IF;

  IF v_order.payment_type = 'debt' AND v_order.is_debt IS DISTINCT FROM TRUE THEN
    UPDATE public.orders
    SET is_debt = true, updated_at = now()
    WHERE id = p_order_id;
  END IF;

  PERFORM public.mark_debt_paid(p_order_id, v_method);
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.complete_seller_debt_pay(uuid, text, text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.complete_seller_debt_pay(uuid, text, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.complete_seller_debt_pay(uuid, text, text) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON FUNCTION public.complete_seller_debt_pay(uuid, text, text) FROM service_role;
  END IF;
END $$;

COMMIT;
