-- Read-only postflight AFTER 5.17.6D REVOKE. One result set. No DDL/DML.

WITH
fn AS (
  SELECT p.proname
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
pol AS (
  SELECT policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'inventory_movements'
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'authenticated.inventory_movements.insert'::text AS check_name,
         CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT')
           THEN 'true' ELSE 'false' END AS actual_value,
         'false'::text AS expected_value
  UNION ALL SELECT 'anon.inventory_movements.insert',
    CASE WHEN has_table_privilege('anon', 'public.inventory_movements', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'public.inventory_movements.insert',
    CASE WHEN has_table_privilege('public', 'public.inventory_movements', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'service_role.inventory_movements.insert',
    CASE WHEN has_table_privilege('service_role', 'public.inventory_movements', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.inventory_movements.select',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rls.insert_policy_absent',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE cmd = 'INSERT') THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'goods_issue.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_goods_issue') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'apply_inventory_restock.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'apply_inventory_restock') THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
