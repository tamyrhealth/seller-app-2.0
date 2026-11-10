-- 5.19.2 postflight. SELECT-only. Do not run writes.

WITH fn AS (
  SELECT p.proname
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
pol AS (
  SELECT tablename, cmd
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('inventory', 'inventory_movements')
)
SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'authenticated.inventory.select'::text AS check_name,
         CASE WHEN has_table_privilege('authenticated', 'public.inventory', 'SELECT')
           THEN 'true' ELSE 'false' END AS actual_value,
         'true'::text AS expected_value
  UNION ALL SELECT 'authenticated.inventory.insert',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory.update',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory', 'UPDATE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory.delete',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory', 'DELETE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory.truncate',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory', 'TRUNCATE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'anon.inventory.select',
    CASE WHEN has_table_privilege('anon', 'public.inventory', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'anon.inventory.truncate',
    CASE WHEN has_table_privilege('anon', 'public.inventory', 'TRUNCATE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory_movements.select',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.inventory_movements.insert',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory_movements.update',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'UPDATE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory_movements.delete',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'DELETE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory_movements.truncate',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'TRUNCATE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'anon.inventory_movements.select',
    CASE WHEN has_table_privilege('anon', 'public.inventory_movements', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'anon.inventory_movements.truncate',
    CASE WHEN has_table_privilege('anon', 'public.inventory_movements', 'TRUNCATE')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'service_role.inventory_movements.insert',
    CASE WHEN has_table_privilege('service_role', 'public.inventory_movements', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'service_role.inventory.update',
    CASE WHEN has_table_privilege('service_role', 'public.inventory', 'UPDATE')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rls.inventory.enabled',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'inventory' AND c.relrowsecurity
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rls.inventory_movements.enabled',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'inventory_movements' AND c.relrowsecurity
    ) THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'rls.movements_insert_policy',
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE tablename = 'inventory_movements' AND cmd = 'INSERT')
      THEN 'present' ELSE 'absent' END,
    'absent'
  UNION ALL SELECT 'confirm_order.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_order') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'apply_inventory_restock.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'apply_inventory_restock') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'create_stock_transfer.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'create_stock_transfer') THEN 'present' ELSE 'absent' END,
    'present'
  UNION ALL SELECT 'admin_seller_goods_issue.present',
    CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_seller_goods_issue') THEN 'present' ELSE 'absent' END,
    'present'
) s
ORDER BY check_name;
