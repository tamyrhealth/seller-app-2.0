-- Read-only preflight BEFORE 5.17.7B SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'seller_ledger.present'::text AS check_name,
         CASE WHEN to_regclass('public.seller_ledger') IS NOT NULL THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'seller_goods_issues.present',
    CASE WHEN to_regclass('public.seller_goods_issues') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'seller_goods_issue_items.present',
    CASE WHEN to_regclass('public.seller_goods_issue_items') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'finance_require_active_admin.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'finance_require_active_admin') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'finance_expenses.present',
    CASE WHEN to_regclass('public.finance_expenses') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'admin_finance_seller_pnl.absent',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_finance_seller_pnl') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
