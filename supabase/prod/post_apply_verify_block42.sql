-- Read-only checks AFTER product cost / shortage snapshot SQL.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'products'
  AND column_name = 'cost_price';

SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'public.products'::regclass
  AND conname = 'products_cost_price_check';

SELECT
  has_table_privilege('authenticated', 'public.products', 'SELECT') AS authenticated_table_select,
  has_column_privilege('authenticated', 'public.products', 'name', 'SELECT') AS authenticated_select_name,
  has_column_privilege('authenticated', 'public.products', 'price_retail', 'SELECT') AS authenticated_select_retail,
  has_column_privilege('authenticated', 'public.products', 'sort_order', 'SELECT') AS authenticated_select_sort,
  has_column_privilege('authenticated', 'public.products', 'cost_price', 'SELECT') AS authenticated_select_cost,
  has_column_privilege('authenticated', 'public.products', 'cost_price', 'UPDATE') AS authenticated_update_cost,
  has_column_privilege('authenticated', 'public.products', 'cost_price', 'INSERT') AS authenticated_insert_cost,
  has_column_privilege('anon', 'public.products', 'name', 'SELECT') AS anon_select_name,
  has_column_privilege('anon', 'public.products', 'cost_price', 'SELECT') AS anon_select_cost,
  has_column_privilege('anon', 'public.products', 'cost_price', 'UPDATE') AS anon_update_cost;

SELECT grantee, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'products'
  AND column_name = 'cost_price'
ORDER BY 1, 2;

SELECT c.relacl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'products';

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) LIKE '%unit_cost%' AS snapshots_unit_cost,
       pg_get_functiondef(p.oid) LIKE '%to_jsonb(p.cost_price)%' AS null_safe_unit_cost,
       pg_get_functiondef(p.oid) LIKE '%INSERT INTO public.inventory%' AS inserts_inventory,
       pg_get_functiondef(p.oid) LIKE '%INSERT INTO public.inventory_movements%' AS inserts_movements,
       pg_get_functiondef(p.oid) LIKE '%UPDATE public.inventory%' AS updates_inventory,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('write_off_stock_transfer_shortage', 'admin_product_costs')
ORDER BY 1;

SELECT t.transfer_number,
       t.status,
       i.qty_sent,
       i.qty_received,
       i.qty_lost,
       i.qty_returned,
       public.stock_transfer_remaining(i.qty_sent, i.qty_received, i.qty_lost, i.qty_returned) AS qty_in_transit
FROM public.stock_transfers t
JOIN public.stock_transfer_items i ON i.transfer_id = t.id
WHERE t.transfer_number IN ('T000001', 'T000002')
ORDER BY t.transfer_number, i.product_id;

SELECT e.created_at, t.transfer_number, e.action, e.details
FROM public.stock_transfer_events e
JOIN public.stock_transfers t ON t.id = e.transfer_id
WHERE t.transfer_number IN ('T000001', 'T000002')
ORDER BY e.created_at;
