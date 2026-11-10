-- 5.19.6C phase-1 postflight. SELECT-only. Run after phase 1, before phase 2.
-- confirm_order__session_body is probed only via to_regprocedure (NULL = absent, no ERROR).

SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'claim.present'::text AS check_name,
         CASE WHEN to_regprocedure('public.claim_active_auth_session()') IS NOT NULL THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'check.present',
    CASE WHEN to_regprocedure('public.check_active_auth_session()') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'assert.present',
    CASE WHEN to_regprocedure('public.assert_active_auth_session()') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'claim.authenticated_execute',
    CASE WHEN to_regprocedure('public.claim_active_auth_session()') IS NULL THEN 'false'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.claim_active_auth_session()'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'check.authenticated_execute',
    CASE WHEN to_regprocedure('public.check_active_auth_session()') IS NULL THEN 'false'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.check_active_auth_session()'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'assert.authenticated_execute',
    CASE WHEN to_regprocedure('public.assert_active_auth_session()') IS NULL THEN 'false'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.assert_active_auth_session()'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'claim.anon_execute',
    CASE WHEN to_regprocedure('public.claim_active_auth_session()') IS NULL THEN 'false'
         WHEN has_function_privilege('anon', to_regprocedure('public.claim_active_auth_session()'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'wrap.absent',
    CASE WHEN to_regprocedure('public.auth_session_guard_wrap(regprocedure)') IS NULL THEN 'absent' ELSE 'present' END,
    'absent'
  UNION ALL SELECT 'sessions.authenticated_insert',
    CASE WHEN has_table_privilege('authenticated', 'public.user_active_sessions', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'sessions.authenticated_update',
    CASE WHEN has_table_privilege('authenticated', 'public.user_active_sessions', 'UPDATE')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'sessions.authenticated_select',
    CASE WHEN has_table_privilege('authenticated', 'public.user_active_sessions', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'auth_session_id.present',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_active_sessions'
        AND column_name = 'auth_session_id'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.unwrapped',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'plain'
  UNION ALL SELECT 'confirm_order.body_absent',
    CASE WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NULL THEN 'absent' ELSE 'present' END,
    'absent'
  UNION ALL SELECT 'retry.unwrapped',
    CASE WHEN to_regprocedure('public.admin_seller_accrual_retry_item(uuid)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.admin_seller_accrual_retry_item(uuid)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'plain'
  UNION ALL SELECT 'products.write_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'products'
        AND t.tgname = 'auth_session_guard_products' AND NOT t.tgisinternal
    ) THEN 'present' ELSE 'absent' END,
    'absent'
) s
ORDER BY check_name;
