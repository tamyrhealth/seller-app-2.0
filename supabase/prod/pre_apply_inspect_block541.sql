-- Read-only preflight BEFORE 5.4.1 SQL. One result set. No DDL/DML.

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
  UNION ALL SELECT 'confirm_order_present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'find_similar_orders_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'find_similar_orders') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'orders_table',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'orders'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'order_items_is_gift',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'is_gift'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'orders.debt_customer_phone',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'debt_customer_phone'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'action_logs_untouched_exists',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'action_logs'
    ) THEN 'present' ELSE 'absent' END,
    'present'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
