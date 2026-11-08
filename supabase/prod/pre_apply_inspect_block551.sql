-- Read-only preflight BEFORE 5.5.1 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
checks(check_name, actual_value, expected_value) AS (
  SELECT 'database'::text, current_database()::text, current_database()::text
  UNION ALL SELECT 'cities.present',
    CASE WHEN to_regclass('public.cities') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'profiles.present',
    CASE WHEN to_regclass('public.profiles') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'finance_expenses_absent_before_apply',
    CASE WHEN to_regclass('public.finance_expenses') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'finance_expense_events_absent_before_apply',
    CASE WHEN to_regclass('public.finance_expense_events') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'finance_expense_categories_absent_before_apply',
    CASE WHEN to_regclass('public.finance_expense_categories') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'admin_finance_expense_create_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_finance_expense_create') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'admin_finance_expenses_list_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_finance_expenses_list') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'admin_finance_expense_update_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_finance_expense_update') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'admin_finance_expense_delete_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_finance_expense_delete') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'admin_finance_expense_events_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_finance_expense_events') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'is_active_admin.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'is_active_admin') THEN 'present' ELSE 'absent' END,
    'absent'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
