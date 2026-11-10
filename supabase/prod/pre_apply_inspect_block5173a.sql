-- Read-only preflight BEFORE 5.17.3A SQL. One result set. No DDL/DML.

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
  UNION ALL SELECT 'products.present',
    CASE WHEN to_regclass('public.products') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'orders.present',
    CASE WHEN to_regclass('public.orders') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'order_items.present',
    CASE WHEN to_regclass('public.order_items') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order' AND args = 'payload jsonb') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'fulfill_preorder.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'fulfill_preorder') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'cancel_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'cancel_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'finance_expenses.present',
    CASE WHEN to_regclass('public.finance_expenses') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'seller_ledger_absent_before_apply',
    CASE WHEN to_regclass('public.seller_ledger') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'seller_tariff_plans_absent_before_apply',
    CASE WHEN to_regclass('public.seller_tariff_plans') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'seller_tariff_rates_absent_before_apply',
    CASE WHEN to_regclass('public.seller_tariff_rates') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'seller_goods_issues_absent_before_apply',
    CASE WHEN to_regclass('public.seller_goods_issues') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'admin_seller_cash_payout_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_cash_payout') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'seller_ledger_post_accrual_internal_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'seller_ledger_post_accrual_internal') THEN 'present' ELSE 'absent' END,
    'absent'
)
SELECT
  check_name,
  actual_value,
  expected_value,
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_name;
