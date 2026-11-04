-- Read-only checks AFTER apply_order_cancel manager SQL.

SELECT p.proname, pg_get_function_result(p.oid) AS result_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'cancel_order',
    'admin_cancel_order',
    'apply_order_cancel',
    'cancel_order_report',
    'admin_cancel_order_report',
    'apply_order_cancel_report'
  )
ORDER BY 1;

SELECT pg_get_functiondef(p.oid) LIKE '%can_cancel_orders%' AS manager_flag_enforced,
       pg_get_functiondef(p.oid) LIKE '%Cancel permission denied%' AS manager_denied_without_flag,
       pg_get_functiondef(p.oid) LIKE '%already_canceled%' AS idempotent_already_canceled,
       pg_get_functiondef(p.oid) LIKE '%''already_canceled'', true%' AS logs_already_canceled,
       pg_get_functiondef(p.oid) LIKE '%Cannot cancel order after 10 minutes%' AS seller_ten_minutes,
       pg_get_functiondef(p.oid) LIKE '%FOR UPDATE%' AS locks_order_row,
       pg_get_functiondef(p.oid) LIKE '%cancel_sale%' AS writes_cancel_sale_movement,
       pg_get_functiondef(p.oid) LIKE '%qty_on_hand%' AS returns_stock,
       pg_get_functiondef(p.oid) LIKE '%is_debt%' AS keeps_debt_clear,
       pg_get_functiondef(p.oid) LIKE '%is_preorder%' AS keeps_preorder_gate
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'apply_order_cancel_report';

SELECT has_function_privilege('authenticated', 'public.cancel_order(uuid)', 'EXECUTE') AS auth_cancel_exec,
       has_function_privilege('authenticated', 'public.admin_cancel_order(uuid, text)', 'EXECUTE') AS auth_admin_cancel_exec,
       has_function_privilege('authenticated', 'public.cancel_order_report(uuid)', 'EXECUTE') AS auth_cancel_report_exec,
       has_function_privilege('anon', 'public.cancel_order(uuid)', 'EXECUTE') AS anon_cancel_exec,
       has_function_privilege('service_role', 'public.cancel_order(uuid)', 'EXECUTE') AS service_cancel_exec,
       has_function_privilege('authenticated', 'public.apply_order_cancel(uuid, text)', 'EXECUTE') AS auth_apply_cancel_exec,
       has_function_privilege('authenticated', 'public.apply_order_cancel_report(uuid, text)', 'EXECUTE') AS auth_apply_report_exec,
       has_function_privilege('service_role', 'public.apply_order_cancel_report(uuid, text)', 'EXECUTE') AS service_apply_report_exec;

SELECT pg_get_functiondef(p.oid) LIKE '%Product is not available%' AS confirm_still_rejects_inactive,
       pg_get_function_result(p.oid) AS confirm_result_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'confirm_order';
