-- Read-only preflight BEFORE 5.2.6 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'database'::text, current_database()::text, current_database()::text
  UNION ALL SELECT 'profiles.can_create_transfers',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_create_transfers'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'profiles.can_manage_transfers_absent_before_apply',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'can_manage_transfers'
    ) THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'receive_stock_transfer.admin_only_before',
    COALESCE((SELECT (def LIKE '%Only admin can receive transfers%')::text FROM fn WHERE proname = 'receive_stock_transfer' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'cancel_stock_transfer.admin_only_before',
    COALESCE((SELECT (def LIKE '%Only admin can cancel transfers%')::text FROM fn WHERE proname = 'cancel_stock_transfer' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'write_off.admin_only_before',
    COALESCE((SELECT (def LIKE '%Only admin can write off transfer shortage%')::text FROM fn WHERE proname = 'write_off_stock_transfer_shortage' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'create.can_create_flag_before',
    COALESCE((SELECT (def LIKE '%can_create_transfers%')::text FROM fn WHERE proname = 'create_stock_transfer' AND args LIKE '%p_comment%' LIMIT 1), 'missing'),
    'true'
  UNION ALL SELECT 'stock_transfer_require_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'stock_transfer_require') THEN 'present' ELSE 'absent' END,
    'absent'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
