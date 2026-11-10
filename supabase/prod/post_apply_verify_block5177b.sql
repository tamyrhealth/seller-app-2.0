-- Read-only postflight AFTER 5.17.7B SQL. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosecdef,
         COALESCE(p.proconfig, ARRAY[]::text[]) AS cfg
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
  SELECT 'admin_finance_seller_pnl.present'::text AS check_name,
         CASE WHEN EXISTS (
           SELECT 1 FROM fn
           WHERE proname = 'admin_finance_seller_pnl'
             AND args = 'p_from date, p_to date'
         ) THEN 'present' ELSE 'absent' END AS actual_value,
         'present'::text AS expected_value
  UNION ALL SELECT 'admin_finance_seller_pnl.security_definer',
    CASE WHEN COALESCE((
      SELECT prosecdef FROM fn
      WHERE proname = 'admin_finance_seller_pnl' AND args = 'p_from date, p_to date' LIMIT 1
    ), false) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'admin_finance_seller_pnl.search_path',
    CASE WHEN EXISTS (
      SELECT 1 FROM fn
      WHERE proname = 'admin_finance_seller_pnl'
        AND args = 'p_from date, p_to date'
        AND cfg @> ARRAY['search_path=public']
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'admin_finance_seller_pnl.authenticated_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_finance_seller_pnl' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'admin_finance_seller_pnl.anon_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_finance_seller_pnl' AND grantee = 'anon' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'admin_finance_seller_pnl.service_role_execute',
    CASE WHEN EXISTS (
      SELECT 1 FROM g
      WHERE proname = 'admin_finance_seller_pnl' AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
    ) THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.seller_ledger.select',
    CASE WHEN has_table_privilege('authenticated', 'public.seller_ledger', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.seller_goods_issue_items.select',
    CASE WHEN has_table_privilege('authenticated', 'public.seller_goods_issue_items', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'finance_expenses.untouched_table',
    CASE WHEN to_regclass('public.finance_expenses') IS NOT NULL THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
