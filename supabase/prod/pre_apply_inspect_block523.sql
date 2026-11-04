-- Read-only. Run BEFORE apply_order_cancel manager SQL.

SELECT current_database() AS db;

SELECT to_regclass('public.orders') AS orders,
       to_regclass('public.order_items') AS order_items,
       to_regclass('public.inventory') AS inventory,
       to_regclass('public.inventory_movements') AS inventory_movements,
       to_regclass('public.action_logs') AS action_logs;

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_cancel_orders';

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS result_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'apply_order_cancel',
    'apply_order_cancel_report',
    'cancel_order',
    'cancel_order_report',
    'admin_cancel_order',
    'admin_cancel_order_report',
    'confirm_order'
  )
ORDER BY 1, 2;

-- Incoming dependencies. Unexpected rows besides cancel_order / admin_cancel_order wrapping apply_order_cancel
-- mean do not DROP; this migration must not use CASCADE.
SELECT pg_describe_object(d.classid, d.objid, d.objsubid) AS dependent_obj,
       pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) AS referenced_obj,
       d.deptype
FROM pg_depend d
JOIN pg_proc refp ON d.refobjid = refp.oid
JOIN pg_namespace nref ON nref.oid = refp.pronamespace
WHERE nref.nspname = 'public'
  AND refp.proname IN ('cancel_order', 'admin_cancel_order', 'apply_order_cancel')
  AND d.deptype IN ('n', 'a');
