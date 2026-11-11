-- 5.20.1 Production inspect. SELECT-only. Do not apply P0 from this file.
-- Does not wrap/unwrap session RPCs. Does not rewrite confirm_order.
--
-- psql $env:PROD_DB_URI -X -v ON_ERROR_STOP=1 -f "supabase\prod\inspect_block5201_orders_readonly.sql"

SELECT check_name, actual_value, expected_value,
       CASE
         WHEN expected_value IS NULL THEN 'INFO'
         WHEN actual_value = expected_value THEN 'PASS'
         ELSE 'FAIL'
       END AS status
FROM (
  SELECT 'confirm_order.session_assert'::text AS check_name,
         CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'absent'
              WHEN pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)'))
                   LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
              ELSE 'plain' END AS actual_value,
         'wrapped'::text AS expected_value
  UNION ALL SELECT 'confirm_order.session_body',
    CASE WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.body_authenticated_execute',
    CASE WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NULL THEN 'absent'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.confirm_order__session_body(jsonb)'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'mark_debt_paid.session_assert',
    CASE WHEN to_regprocedure('public.mark_debt_paid(uuid, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.mark_debt_paid(uuid, text)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'wrapped'
  UNION ALL SELECT 'integrity.present',
    CASE WHEN to_regprocedure('public.auth_session_guard_integrity()') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'session_write_trigger.orders',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'orders' AND NOT t.tgisinternal
        AND t.tgname = 'auth_session_guard_orders'
    ) THEN 'present' ELSE     'absent' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.select',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'SELECT') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.insert',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'INSERT') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.update',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'UPDATE') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.delete',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'DELETE') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.truncate',
    CASE WHEN has_table_privilege('authenticated', 'public.orders', 'TRUNCATE') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.status_update',
    CASE WHEN has_column_privilege('authenticated', 'public.orders', 'status', 'UPDATE') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.total_sum_update',
    CASE WHEN has_column_privilege('authenticated', 'public.orders', 'total_sum', 'UPDATE') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.seller_id_update',
    CASE WHEN has_column_privilege('authenticated', 'public.orders', 'seller_id', 'UPDATE') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.orders.debt_status_update',
    CASE WHEN has_column_privilege('authenticated', 'public.orders', 'debt_status', 'UPDATE') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'anon.orders.update',
    CASE WHEN has_table_privilege('anon', 'public.orders', 'UPDATE') THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'inventory.qty_nonnegative_check',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint x
      JOIN pg_class c ON c.oid = x.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'inventory' AND x.contype = 'c'
        AND pg_get_constraintdef(x.oid) ILIKE '%qty_on_hand%>=%0%'
    ) THEN 'present' ELSE     'absent' END,
    NULL::text
  UNION ALL SELECT 'authenticated.create_stock_transfer_execute',
    CASE WHEN to_regprocedure('public.create_stock_transfer(uuid, uuid, uuid, jsonb, text)') IS NULL THEN 'absent'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.create_stock_transfer(uuid, uuid, uuid, jsonb, text)'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'authenticated.receive_stock_transfer_execute',
    CASE WHEN to_regprocedure('public.receive_stock_transfer(uuid, uuid, jsonb)') IS NULL THEN 'absent'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.receive_stock_transfer(uuid, uuid, jsonb)'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    NULL::text
  UNION ALL SELECT 'create_stock_transfer.session_assert',
    CASE WHEN to_regprocedure('public.create_stock_transfer(uuid, uuid, uuid, jsonb, text)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.create_stock_transfer(uuid, uuid, uuid, jsonb, text)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'wrapped'
) s
ORDER BY check_name;

SELECT pol.polname AS policy_name,
       CASE pol.polcmd
         WHEN 'r' THEN 'SELECT'
         WHEN 'a' THEN 'INSERT'
         WHEN 'w' THEN 'UPDATE'
         WHEN 'd' THEN 'DELETE'
         WHEN '*' THEN 'ALL'
         ELSE pol.polcmd::text
       END AS command,
       pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
       pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check_expr
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'orders'
ORDER BY pol.polname;

SELECT t.tgname,
       pg_get_triggerdef(t.oid) AS trigger_def,
       t.tgtype,
       t.tgdeferrable,
       t.tginitdeferred
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'orders' AND NOT t.tgisinternal
ORDER BY t.tgname;

SELECT privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'orders' AND grantee = 'authenticated'
ORDER BY privilege_type;

SELECT con.conname, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'inventory' AND con.contype = 'c'
ORDER BY con.conname;

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       (pg_get_functiondef(p.oid) LIKE '%PERFORM public.assert_active_auth_session()%') AS session_assert
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'create_stock_transfer',
    'receive_stock_transfer',
    'cancel_stock_transfer',
    'write_off_stock_transfer_shortage'
  )
ORDER BY p.proname, args;

SELECT
  CASE
    WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'absent'
    WHEN pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)'))
         LIKE '%v_key IS NOT NULL%' THEN 'idempotency_optional'
    ELSE 'idempotency_unknown'
  END AS confirm_order_idempotency_gate,
  CASE
    WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NULL THEN 'no_body'
    WHEN pg_get_functiondef(to_regprocedure('public.confirm_order__session_body(jsonb)'))
         LIKE '%UPDATE inventory SET qty_on_hand = qty_on_hand -%' THEN 'stock_decrement'
    ELSE 'stock_unknown'
  END AS confirm_body_stock;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'order_items'
ORDER BY ordinal_position;

SELECT table_name, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('orders', 'order_items')
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;
