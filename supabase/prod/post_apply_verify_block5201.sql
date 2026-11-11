-- 5.20.1 postflight. SELECT-only. After P0 apply. Phase 2 wrappers must remain.

SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'confirm_order.still_wrapped'::text AS check_name,
         CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'absent'
              WHEN pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)'))
                   LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
              ELSE 'plain' END AS actual_value,
         'wrapped'::text AS expected_value
  UNION ALL SELECT 'confirm_order.body_unrewritten',
    CASE WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.confirm_order__session_body(jsonb)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'rewritten'
         ELSE 'plain' END,
    'plain'
  UNION ALL SELECT 'mark_debt_paid.still_wrapped',
    CASE WHEN to_regprocedure('public.mark_debt_paid(uuid, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.mark_debt_paid(uuid, text)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'wrapped'
  UNION ALL SELECT 'protect.orders_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'orders' AND NOT t.tgisinternal
        AND t.tgname = 'zz_orders_block_client_write'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'protect.items_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'order_items' AND NOT t.tgisinternal
        AND t.tgname = 'zz_order_items_block_client_write'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'authenticated.orders.select',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'SELECT') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.orders.insert',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'INSERT') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.orders.update',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'UPDATE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.orders.delete',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'DELETE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'anon.orders.update',
    CASE WHEN has_table_privilege('anon', 'public.orders', 'UPDATE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.orders.status_update',
    CASE WHEN has_column_privilege('authenticated', 'public.orders', 'status', 'UPDATE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.orders.total_sum_update',
    CASE WHEN has_column_privilege('authenticated', 'public.orders', 'total_sum', 'UPDATE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.orders.is_debt_update',
    CASE WHEN has_column_privilege('authenticated', 'public.orders', 'is_debt', 'UPDATE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.order_items.insert',
    CASE WHEN has_table_privilege('authenticated', 'public.order_items', 'INSERT') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.order_items.qty_insert',
    CASE WHEN has_column_privilege('authenticated', 'public.order_items', 'qty', 'INSERT') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.order_items.update',
    CASE WHEN has_table_privilege('authenticated', 'public.order_items', 'UPDATE') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.order_items.qty_select',
    CASE WHEN has_column_privilege('authenticated', 'public.order_items', 'qty', 'SELECT') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.order_items.cost_select',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'cost_price_snapshot'
    ) THEN 'absent'
         WHEN has_column_privilege('authenticated', 'public.order_items', 'cost_price_snapshot', 'SELECT')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'debt_pay_rpc.present',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'debt_pay_rpc.assert',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'assert'
         ELSE 'no_assert' END,
    'assert'
  UNION ALL SELECT 'debt_pay_rpc.authenticated_execute',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN 'absent'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'debt_pay_rpc.anon_execute',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN 'absent'
         WHEN has_function_privilege('anon', to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'debt_pay_rpc.service_role_execute',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN 'absent'
         WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN 'false'
         WHEN has_function_privilege('service_role', to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'debt_pay_rpc.replay_guard',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
              LIKE '%Debt is already paid%' THEN 'present' ELSE 'missing' END,
    'present'
  UNION ALL SELECT 'debt_pay_rpc.method_guard',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
              LIKE '%cash%kaspi%' THEN 'present' ELSE 'missing' END,
    'present'
  UNION ALL SELECT 'debt_pay_rpc.for_update',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
              LIKE '%FOR UPDATE%' THEN 'present' ELSE 'missing' END,
    'present'
  UNION ALL SELECT 'debt_pay_rpc.calls_mark_debt_paid',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)'))
              LIKE '%PERFORM public.mark_debt_paid(%' THEN 'present' ELSE 'missing' END,
    'present'
  UNION ALL SELECT 'commission.orders_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'orders' AND NOT t.tgisinternal
        AND t.tgname = 'seller_commission_orders_au_trg'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'audit.orders_insert_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'orders' AND NOT t.tgisinternal
        AND t.tgname = 'orders_log_insert_trg'
    ) THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
