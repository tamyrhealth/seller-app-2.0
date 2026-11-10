-- Read-only postflight AFTER 5.17.5 SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
g AS (
  SELECT p.proname, r.rolname AS grantee, priv.privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) priv ON true
  JOIN pg_roles r ON r.oid = priv.grantee
  WHERE n.nspname = 'public'
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'balances_list.present'::text AS check_name,
         CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_balances_list' AND args = '') THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'cash_payout.5arg',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn
      WHERE proname = 'admin_seller_cash_payout'
        AND args = 'p_operation_id uuid, p_seller_id uuid, p_amount numeric, p_comment text, p_accrued_at timestamp with time zone'
    ) THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'cash_payout.overload_count',
    (SELECT count(*)::text FROM fn WHERE proname = 'admin_seller_cash_payout'),
    '1'
  UNION ALL SELECT 'cash_payout.old_4arg_gone',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn
      WHERE proname = 'admin_seller_cash_payout'
        AND args = 'p_operation_id uuid, p_seller_id uuid, p_amount numeric, p_comment text'
    ) THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'cash_post.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_seller_cash_post' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'balances_list.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_seller_balances_list' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'breakdown.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'seller_ledger_breakdown' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'confirm_order.not_replaced',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'authenticated.seller_ledger.select',
    CASE WHEN has_table_privilege('authenticated', 'public.seller_ledger', 'SELECT') THEN 'true' ELSE 'false' END,
    'false'
) s
ORDER BY check_name;
