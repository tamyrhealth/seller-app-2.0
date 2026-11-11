-- SELECT-only inspect for 5.20.2. Safe before qty_reserved exists.
-- Column presence via pg_catalog only. Do not apply.

WITH cols AS (
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         a.attname AS column_name
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
SELECT 'confirm.body.reserve',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.confirm_order__session_body(jsonb)')) LIKE '%inventory_reserve_up_to%',
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
SELECT 'fulfill.body.helper',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.fulfill_preorder__session_body(uuid)')) LIKE '%inventory_fulfill_sku%',
         false
       )::text
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
SELECT 'authenticated.qty_reserved.update',
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM cols WHERE table_name = 'order_items') THEN 'absent'
         ELSE has_column_privilege('authenticated', 'public.order_items', 'qty_reserved', 'UPDATE')::text
       END
UNION ALL
SELECT 'authenticated.qty_reserved.select',
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM cols WHERE table_name = 'order_items') THEN 'absent'
         ELSE has_column_privilege('authenticated', 'public.order_items', 'qty_reserved', 'SELECT')::text
       END
UNION ALL
SELECT 'helper.reserve.regproc',
       (to_regprocedure('public.inventory_reserve_up_to(uuid, uuid, numeric)') IS NOT NULL)::text
UNION ALL
SELECT 'pending.preorders',
       (SELECT COUNT(*)::text FROM public.orders
         WHERE is_preorder AND preorder_status = 'pending' AND status IS DISTINCT FROM 'canceled');
