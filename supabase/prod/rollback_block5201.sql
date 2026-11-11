-- 5.20.1 rollback of P0 order write lockdown.
-- Restores pre-inspect ACL (authenticated writes + anon UPDATE on orders).
-- Does not unwrap session Phase 2 RPCs. Does not rewrite confirm_order.
-- Run only with explicit permission.

BEGIN;

DROP TRIGGER IF EXISTS zz_orders_protect_client_update ON public.orders;
DROP TRIGGER IF EXISTS zz_orders_block_client_write ON public.orders;
DROP TRIGGER IF EXISTS zz_order_items_block_client_write ON public.order_items;
DROP FUNCTION IF EXISTS public.orders_protect_client_update();
DROP FUNCTION IF EXISTS public.orders_block_client_write();
DROP FUNCTION IF EXISTS public.complete_seller_debt_pay(uuid, text, text);

DROP POLICY IF EXISTS orders_update ON public.orders;
DROP POLICY IF EXISTS "orders_update" ON public.orders;
CREATE POLICY orders_update ON public.orders
  FOR UPDATE
  USING (seller_id = auth.uid() OR public.get_user_role() = 'admin')
  WITH CHECK (true);

DROP POLICY IF EXISTS orders_seller_insert ON public.orders;
DROP POLICY IF EXISTS "orders_seller_insert" ON public.orders;
CREATE POLICY orders_seller_insert ON public.orders
  FOR INSERT
  WITH CHECK (seller_id = auth.uid() AND city_id = public.get_user_city_id() OR public.get_user_role() = 'admin');

DROP POLICY IF EXISTS order_items_insert ON public.order_items;
DROP POLICY IF EXISTS "order_items_insert" ON public.order_items;
CREATE POLICY order_items_insert ON public.order_items
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id
        AND (o.seller_id = auth.uid() OR public.get_user_role() = 'admin')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.orders TO authenticated;
GRANT UPDATE ON TABLE public.orders TO anon;

-- Restore 5.13.2 column ACL. Do not GRANT table-level INSERT on order_items
-- (Production already revoked it; only column INSERT exists).
REVOKE ALL ON TABLE public.order_items FROM PUBLIC;
REVOKE ALL ON TABLE public.order_items FROM anon;
REVOKE ALL ON TABLE public.order_items FROM authenticated;
DO $grant$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'order_items'
    AND c.column_name IS DISTINCT FROM 'cost_price_snapshot';
  IF v_cols IS NULL OR v_cols = '' THEN
    RAISE EXCEPTION 'order_items public columns missing';
  END IF;
  EXECUTE format('GRANT SELECT (%s) ON TABLE public.order_items TO authenticated', v_cols);
  EXECUTE format('GRANT INSERT (%s) ON TABLE public.order_items TO authenticated', v_cols);
  EXECUTE format('GRANT UPDATE (%s) ON TABLE public.order_items TO authenticated', v_cols);
  EXECUTE 'GRANT DELETE ON TABLE public.order_items TO authenticated';
END
$grant$;
GRANT ALL ON TABLE public.order_items TO service_role;

COMMIT;
