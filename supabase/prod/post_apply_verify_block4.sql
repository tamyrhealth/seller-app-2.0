-- Read-only checks AFTER stock transfer SQL.
-- Does not INSERT/UPDATE/DELETE.

SELECT current_database() AS db;

SELECT to_regclass('public.stock_transfers') AS stock_transfers,
       to_regclass('public.stock_transfer_items') AS stock_transfer_items,
       to_regclass('public.stock_transfer_events') AS stock_transfer_events;

SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'stock_transfers',
    'stock_transfer_items',
    'stock_transfer_events',
    'inventory',
    'inventory_movements'
  )
ORDER BY 1, 2;

SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'public.inventory_movements'::regclass
  AND conname IN ('inventory_movements_type_check', 'inventory_movements_transfer_id_fkey');

SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'public.stock_transfer_items'::regclass
  AND contype = 'f'
ORDER BY 1;

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) LIKE '%Only admin%' AS checks_admin,
       pg_get_functiondef(p.oid) LIKE '%different payload%' AS rejects_payload_mismatch,
       pg_get_functiondef(p.oid) LIKE '%FOR UPDATE%' AS row_locks,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'create_stock_transfer',
    'receive_stock_transfer',
    'cancel_stock_transfer',
    'format_transfer_number',
    'stock_transfer_fingerprint',
    'stock_transfers_assign_number',
    'confirm_order',
    'apply_inventory_restock',
    'apply_inventory_adjust'
  )
ORDER BY 1;

SELECT
  (SELECT count(*) FROM public.stock_transfers) AS transfers,
  (SELECT count(*) FROM public.inventory) AS inventory_rows,
  (SELECT count(*) FROM public.inventory_movements) AS movements,
  (SELECT count(*) FROM public.cities) AS cities,
  (SELECT count(*) FROM public.orders) AS orders;
