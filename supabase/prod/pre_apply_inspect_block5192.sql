-- 5.19.2 preflight. SELECT-only. Do not run writes.

SELECT check_name, actual_value, expected_value,
       CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
  SELECT 'authenticated.inventory.truncate'::text AS check_name,
         CASE WHEN has_table_privilege('authenticated', 'public.inventory', 'TRUNCATE')
           THEN 'true' ELSE 'false' END AS actual_value,
         'true'::text AS expected_value
  UNION ALL SELECT 'authenticated.inventory.update',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory', 'UPDATE')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.inventory_movements.truncate',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'TRUNCATE')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.inventory_movements.update',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'UPDATE')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.inventory_movements.delete',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'DELETE')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.inventory_movements.insert',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'false'
  UNION ALL SELECT 'authenticated.inventory.select',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'authenticated.inventory_movements.select',
    CASE WHEN has_table_privilege('authenticated', 'public.inventory_movements', 'SELECT')
      THEN 'true' ELSE 'false' END,
    'true'
  UNION ALL SELECT 'service_role.inventory_movements.insert',
    CASE WHEN has_table_privilege('service_role', 'public.inventory_movements', 'INSERT')
      THEN 'true' ELSE 'false' END,
    'true'
) s
ORDER BY check_name;
