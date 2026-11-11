-- 5.20.1 preflight. SELECT-only. Phase 2 must already be live. P0 not applied yet.

SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'confirm_order.wrapped'::text AS check_name,
         CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'absent'
              WHEN pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)'))
                   LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
              ELSE 'plain' END AS actual_value,
         'wrapped'::text AS expected_value
  UNION ALL SELECT 'confirm_order.body_present',
    CASE WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'mark_debt_paid.wrapped',
    CASE WHEN to_regprocedure('public.mark_debt_paid(uuid, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.mark_debt_paid(uuid, text)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'wrapped'
  UNION ALL SELECT 'mark_debt_paid.signature',
    CASE WHEN to_regprocedure('public.mark_debt_paid(uuid, text)') IS NULL THEN 'absent' ELSE 'uuid_text' END,
    'uuid_text'
  UNION ALL SELECT 'mark_debt_paid.body_present',
    CASE WHEN to_regprocedure('public.mark_debt_paid__session_body(uuid, text)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'mark_debt_paid.body_owner_check',
    CASE WHEN to_regprocedure('public.mark_debt_paid__session_body(uuid, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.mark_debt_paid__session_body(uuid, text)'))
              LIKE '%Seller can only mark own debts as paid%' THEN 'present'
         ELSE 'missing' END,
    'present'
  UNION ALL SELECT 'mark_debt_paid.body_authenticated_execute',
    CASE WHEN to_regprocedure('public.mark_debt_paid__session_body(uuid, text)') IS NULL THEN 'absent'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.mark_debt_paid__session_body(uuid, text)'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'mark_debt_paid.authenticated_execute',
    CASE WHEN to_regprocedure('public.mark_debt_paid(uuid, text)') IS NULL THEN 'absent'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.mark_debt_paid(uuid, text)'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'confirm_order.signature',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'absent' ELSE 'jsonb' END,
    'jsonb'
  UNION ALL SELECT 'orders_update.with_check',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'orders' AND policyname = 'orders_update'
        AND with_check = 'true'
    ) THEN 'true' ELSE 'other' END,
    'true'
  UNION ALL SELECT 'orders_update.qual_owner_or_admin',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'orders' AND policyname = 'orders_update'
        AND qual LIKE '%seller_id%auth.uid()%'
        AND qual LIKE '%admin%'
    ) THEN 'owner_or_admin' ELSE 'other' END,
    'owner_or_admin'
  UNION ALL SELECT 'fulfill_preorder.wrapped',
    CASE WHEN to_regprocedure('public.fulfill_preorder(uuid)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.fulfill_preorder(uuid)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'wrapped'
  UNION ALL SELECT 'protect.trigger.absent_before_apply',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'orders' AND NOT t.tgisinternal
        AND t.tgname IN ('zz_orders_block_client_write', 'zz_orders_protect_client_update')
    ) THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'debt_pay_rpc.absent_before_apply',
    CASE WHEN to_regprocedure('public.complete_seller_debt_pay(uuid, text, text)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'authenticated.orders.status_update_open',
    CASE WHEN has_column_privilege('authenticated', 'public.orders', 'status', 'UPDATE') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.orders.insert_open',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'INSERT') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.order_items.table_insert',
    CASE WHEN has_table_privilege('authenticated', 'public.order_items', 'INSERT') THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.order_items.qty_insert',
    CASE WHEN has_column_privilege('authenticated', 'public.order_items', 'qty', 'INSERT') THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.order_items.cost_select',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'cost_price_snapshot'
    ) THEN 'absent'
         WHEN has_column_privilege('authenticated', 'public.order_items', 'cost_price_snapshot', 'SELECT')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'anon.orders.update_open',
    CASE WHEN has_table_privilege('anon', 'public.orders', 'UPDATE') THEN 'true' ELSE 'false' END,
    'true'
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
  UNION ALL SELECT 'debt_sync.trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'orders' AND NOT t.tgisinternal
        AND t.tgname = 'orders_sync_debt_trigger'
    ) THEN 'present' ELSE 'absent' END,
    'absent'
) s
ORDER BY check_name;
