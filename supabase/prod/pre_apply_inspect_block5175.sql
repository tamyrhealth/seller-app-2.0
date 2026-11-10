-- Read-only preflight BEFORE 5.17.5 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.pronargs
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'seller_ledger_present'::text AS check_name,
         CASE WHEN to_regclass('public.seller_ledger') IS NOT NULL THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'cash_payout.present_4arg',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn
      WHERE proname = 'admin_seller_cash_payout'
        AND args = 'p_operation_id uuid, p_seller_id uuid, p_amount numeric, p_comment text'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'balances_list_absent_before_apply',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_balances_list') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
