-- Read-only: dump production apply_order_cancel_report for comparison.
-- No DDL/DML. Do not apply 5.4.2 until this matches 5.2.3 business logic
-- (can_cancel_orders, seller window, cancel_sale, already_canceled return shape).
-- 5.4.2 migration must NOT CREATE OR REPLACE this function.

SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS security_definer,
  r.rolname AS owner,
  p.proconfig,
  md5(pg_get_functiondef(p.oid)) AS def_md5,
  length(pg_get_functiondef(p.oid)) AS def_len,
  (pg_get_functiondef(p.oid) LIKE '%can_cancel_orders%') AS has_manager_flag,
  (pg_get_functiondef(p.oid) LIKE '%Cancel permission denied%') AS has_manager_deny,
  (pg_get_functiondef(p.oid) LIKE '%Cannot cancel order after 10 minutes%') AS has_seller_window,
  (pg_get_functiondef(p.oid) LIKE '%cancel_sale%') AS has_cancel_sale,
  (pg_get_functiondef(p.oid) LIKE '%already_canceled%') AS has_already_canceled,
  (pg_get_functiondef(p.oid) LIKE '%FOR UPDATE%') AS has_lock,
  (pg_get_functiondef(p.oid) LIKE '%is_preorder%') AS has_preorder,
  (pg_get_functiondef(p.oid) LIKE '%is_debt%') AS has_debt,
  (pg_get_functiondef(p.oid) LIKE '%order_cancel_already%') AS has_new_already_action,
  pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.proname = 'apply_order_cancel_report'
  AND pg_get_function_identity_arguments(p.oid) = 'p_order_id uuid, p_reason text';
