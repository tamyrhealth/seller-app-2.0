-- Read-only checks AFTER inventory restock/adjust SQL.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT to_regclass('public.client_operations') AS client_operations;

SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements')
ORDER BY 1, 2;

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) LIKE '%Only admin%' AS checks_admin,
       pg_get_functiondef(p.oid) LIKE '%different payload%' AS rejects_payload_mismatch
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('apply_inventory_restock', 'apply_inventory_adjust')
  AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, uuid, numeric'
ORDER BY 1;

SELECT
  (SELECT count(*) FROM public.inventory) AS inventory_rows,
  (SELECT count(*) FROM public.inventory_movements) AS movements,
  (SELECT count(*) FROM public.products) AS products,
  (SELECT count(*) FROM public.cities) AS cities;
