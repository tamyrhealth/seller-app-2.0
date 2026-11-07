-- Read-only preflight BEFORE 5.4.2 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
pol AS (
  SELECT policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'action_logs'
),
trg AS (
  SELECT tgname, tgdeferrable, tginitdeferred
  FROM pg_trigger
  WHERE tgrelid = 'public.orders'::regclass
    AND tgname = 'orders_log_insert_trg'
    AND NOT tgisinternal
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'database'::text, current_database()::text, current_database()::text
  UNION ALL SELECT 'action_logs.present',
    CASE WHEN to_regclass('public.action_logs') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'insert_policy_present_before',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE policyname = 'action_logs_insert_authenticated' AND cmd = 'INSERT')
      THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'select_admin_policy',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE policyname = 'action_logs_select_admin' AND cmd = 'SELECT')
      THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'log_order_action.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'log_order_action' AND args LIKE '%uuid%') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'orders_log_insert_trg.present',
    CASE WHEN EXISTS (SELECT 1 FROM trg) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'find_similar_orders.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'find_similar_orders') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'order_history_item_snapshot_absent_before',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'order_history_item_snapshot') THEN 'present' ELSE 'absent' END,
    'absent'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
