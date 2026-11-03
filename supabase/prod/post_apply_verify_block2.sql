-- Read-only checks AFTER Block 2 SQL on MAIN db.
-- Does not INSERT/UPDATE/DELETE. Do not run until SQL is applied.

SELECT current_database() AS db;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'order_number';

SELECT count(*) AS orders_without_number
FROM public.orders
WHERE order_number IS NULL OR btrim(order_number) = '';

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'orders_order_number_uidx';

SELECT pg_get_functiondef(p.oid) LIKE '%apply_order_cancel%' AS cancel_wraps_apply,
       pg_get_functiondef(p.oid) LIKE '%Cannot cancel order after 10 minutes%' AS seller_window
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'cancel_order'
  AND pg_get_function_identity_arguments(p.oid) = 'uuid';

SELECT pg_get_functiondef(p.oid) LIKE '%Insufficient stock%' AS fulfill_checks_stock,
       pg_get_functiondef(p.oid) LIKE '%preorder_status = ''fulfilled'' THEN%' AS fulfill_idempotent
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'fulfill_preorder'
  AND pg_get_function_identity_arguments(p.oid) = 'uuid';

SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'action_logs'
ORDER BY 1;

SELECT (SELECT count(*) FROM public.orders) AS orders,
       (SELECT count(*) FROM public.action_logs) AS action_logs,
       (SELECT count(*) FROM public.cities) AS cities;
