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
  IF v_select IS NULL OR v_select NOT LIKE '%qty_reserved%' THEN
    RAISE EXCEPTION 'order_items.qty_reserved must be selectable';
  END IF;
  EXECUTE format('GRANT SELECT (%s) ON TABLE public.order_items TO authenticated', v_select);
END
$grant$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.order_items FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory FROM anon, authenticated;

SELECT public.inventory_backfill_pending_preorder_reserves();

DO $wrap$
BEGIN
  IF to_regprocedure('public.confirm_order(jsonb)') IS NOT NULL
     AND pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)'))
         NOT LIKE '%assert_active_auth_session%' THEN
    RAISE EXCEPTION 'P0/Phase2 abort: confirm_order wrapper missing session assert';
  END IF;
  IF to_regprocedure('public.fulfill_preorder(uuid)') IS NOT NULL
     AND pg_get_functiondef(to_regprocedure('public.fulfill_preorder(uuid)'))
         NOT LIKE '%assert_active_auth_session%' THEN
    RAISE EXCEPTION 'P0/Phase2 abort: fulfill_preorder wrapper missing session assert';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.receive_stock_transfer__session_body(uuid, uuid, jsonb)'))
     LIKE '%fulfill_preorder%' THEN
    RAISE EXCEPTION 'receive must not fulfill preorders';
  END IF;
END
$wrap$;
