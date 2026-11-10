-- 5.19.6C phase-2 postflight. SELECT-only. Run after enforce wrappers.
-- to_regprocedure only — never ::regprocedure on a maybe-missing function.

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
  UNION ALL SELECT 'assert.authenticated_execute',
    CASE WHEN to_regprocedure('public.assert_active_auth_session()') IS NULL THEN 'false'
         WHEN has_function_privilege('authenticated', to_regprocedure('public.assert_active_auth_session()'), 'EXECUTE')
           THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'sessions.authenticated_insert',
    CASE WHEN has_table_privilege('authenticated', 'public.user_active_sessions', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'sessions.authenticated_update',
    CASE WHEN has_table_privilege('authenticated', 'public.user_active_sessions', 'UPDATE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'sessions.authenticated_select',
    CASE WHEN has_table_privilege('authenticated', 'public.user_active_sessions', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'confirm_order.wrapped',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.confirm_order(jsonb)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'wrapped'
  UNION ALL SELECT 'confirm_order.body_present',
    CASE WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.body_unrewritten',
    CASE WHEN to_regprocedure('public.confirm_order__session_body(jsonb)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.confirm_order__session_body(jsonb)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'rewritten'
         ELSE 'plain' END,
    'plain'
  UNION ALL SELECT 'retry.wrapped',
    CASE WHEN to_regprocedure('public.admin_seller_accrual_retry_item(uuid)') IS NULL THEN 'absent'
         WHEN pg_get_functiondef(to_regprocedure('public.admin_seller_accrual_retry_item(uuid)'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'wrapped'
  UNION ALL SELECT 'integrity.present',
    CASE WHEN to_regprocedure('public.auth_session_guard_integrity()') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'is_active_admin.unwrapped',
    CASE WHEN to_regprocedure('public.is_active_admin()') IS NULL THEN 'plain'
         WHEN pg_get_functiondef(to_regprocedure('public.is_active_admin()'))
              LIKE '%PERFORM public.assert_active_auth_session()%' THEN 'wrapped'
         ELSE 'plain' END,
    'plain'
  UNION ALL SELECT 'get_user_role.unwrapped',
    CASE WHEN to_regprocedure('public.get_user_role()') IS NULL THEN 'plain'
         WHEN pg_get_functiondef(to_regprocedure('public.get_user_role()'))
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
    'present'
  UNION ALL SELECT 'profiles.write_trigger',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'profiles'
        AND t.tgname = 'auth_session_guard_profiles' AND NOT t.tgisinternal
    ) THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
