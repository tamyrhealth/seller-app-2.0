-- 5.19.6A preflight. SELECT-only. Do not run writes.

SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'user_active_sessions.present'::text AS check_name,
         CASE WHEN to_regclass('public.user_active_sessions') IS NOT NULL THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN to_regprocedure('public.confirm_order(jsonb)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'cancel_order.present',
    CASE WHEN to_regprocedure('public.cancel_order(uuid)') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'apply_inventory_restock.present',
    CASE WHEN to_regprocedure('public.apply_inventory_restock(uuid, uuid, uuid, numeric)') IS NOT NULL
      THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'admin_seller_accrual_retry_item.present',
    CASE WHEN to_regprocedure('public.admin_seller_accrual_retry_item(uuid)') IS NOT NULL
      THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'auth.sessions.present',
    CASE WHEN to_regclass('auth.sessions') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'claim.absent_before',
    CASE WHEN to_regprocedure('public.claim_active_auth_session()') IS NULL THEN 'absent' ELSE 'present' END,
    'absent'
  UNION ALL SELECT 'sessions_select_own.present',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'user_active_sessions'
        AND policyname = 'user_active_sessions_select_own'
    ) THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
