-- SELECT-only preflight. Expect qty_reserved absent, Phase 2 / P0 still wrapped.
-- Column presence via pg_catalog only.

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
SELECT 'inventory.qty_reserved.absent' AS k,
       (NOT EXISTS (SELECT 1 FROM cols WHERE table_name = 'inventory'))::text AS v
UNION ALL
SELECT 'order_items.qty_reserved.absent',
       (NOT EXISTS (SELECT 1 FROM cols WHERE table_name = 'order_items'))::text
UNION ALL
SELECT 'helper.reserve.absent',
       (to_regprocedure('public.inventory_reserve_up_to(uuid, uuid, numeric)') IS NULL)::text
UNION ALL
SELECT 'confirm.wrapped',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)')) LIKE '%assert_active_auth_session%',
         false
       )::text
UNION ALL
SELECT 'fulfill.wrapped',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.fulfill_preorder(uuid)')) LIKE '%assert_active_auth_session%',
         false
       )::text
UNION ALL
SELECT 'cancel.wrapped',
       COALESCE(
         pg_get_functiondef(to_regprocedure('public.cancel_order(uuid)')) LIKE '%assert_active_auth_session%',
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
SELECT 'commission.orders_trigger',
       EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'orders' AND t.tgname ILIKE '%commission%'
       )::text;
