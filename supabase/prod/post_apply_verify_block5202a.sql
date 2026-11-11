-- SELECT-only postflight after 5.20.2. Column presence via pg_catalog; row check only if column exists.

WITH cols AS (
  SELECT c.relname AS table_name
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND a.attname = 'qty_reserved'
    AND c.relname IN ('inventory', 'order_items')
)
SELECT 'inventory.qty_reserved' AS k,
       EXISTS (SELECT 1 FROM cols WHERE table_name = 'inventory')::text AS v
UNION ALL
SELECT 'order_items.qty_reserved',
       EXISTS (SELECT 1 FROM cols WHERE table_name = 'order_items')::text
UNION ALL
SELECT 'confirm.body.available',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.confirm_order__session_body(jsonb)')) LIKE '%inventory_deduct_available%',
         false
       )::text
UNION ALL
SELECT 'confirm.wrapper.session',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)')) LIKE '%assert_active_auth_session%',
         false
       )::text
UNION ALL
SELECT 'fulfill.wrapper.session',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.fulfill_preorder(uuid)')) LIKE '%assert_active_auth_session%',
         false
       )::text
UNION ALL
SELECT 'receive.no_fulfill',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.receive_stock_transfer__session_body(uuid, uuid, jsonb)')) NOT LIKE '%fulfill_preorder%',
         false
       )::text
UNION ALL
SELECT 'helper.reserve.no_client',
       CASE
         WHEN to_regprocedure('public.inventory_reserve_up_to(uuid, uuid, numeric)') IS NULL THEN 'absent'
         ELSE (NOT has_function_privilege('authenticated', 'public.inventory_reserve_up_to(uuid, uuid, numeric)', 'EXECUTE'))::text
       END
UNION ALL
SELECT 'qty_reserved.no_client_update',
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM cols WHERE table_name = 'order_items') THEN 'absent'
         ELSE (NOT has_column_privilege('authenticated', 'public.order_items', 'qty_reserved', 'UPDATE'))::text
       END
UNION ALL
SELECT 'qty_reserved.client_select',
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM cols WHERE table_name = 'order_items') THEN 'absent'
         ELSE has_column_privilege('authenticated', 'public.order_items', 'qty_reserved', 'SELECT')::text
       END
UNION ALL
SELECT 'p0.orders.write_trigger',
       EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'orders' AND t.tgname = 'zz_orders_block_client_write'
       )::text
UNION ALL
SELECT 'p0.order_items.write_trigger',
       EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'order_items' AND t.tgname = 'zz_order_items_block_client_write'
       )::text
UNION ALL
SELECT 'reserved_le_physical',
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM cols WHERE table_name = 'inventory') THEN 'absent'
         ELSE (
           NOT EXISTS (
             SELECT 1
             FROM public.inventory
             WHERE qty_reserved > GREATEST(qty_on_hand, 0)
           )
         )::text
       END;
